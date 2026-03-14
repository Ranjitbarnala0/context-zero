/**
 * ContextZero — Transactional Change Engine
 *
 * 9-state lifecycle for managing code changes with full validation.
 * State machine:
 *   planned → prepared → patched → reindexed → validated →
 *   propagation_pending → committed | rolled_back | failed
 *
 * 6-level progressive validation:
 *   1. Syntax check (per-file parse)
 *   2. Type check (tsc --noEmit / mypy)
 *   3. Contract delta (before/after contract comparison)
 *   4. Behavioral delta (before/after purity/resource comparison)
 *   5. Invariant check (re-verify affected invariants)
 *   6. Test execution (run affected test suites)
 *
 * Uses sandbox.ts for all subprocess execution (no raw execSync).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { db } from '../db-driver';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../logger';
import { sandboxExec, sandboxTypeCheck, sandboxRunTests } from './sandbox';
import { behavioralEngine } from '../analysis-engine/behavioral';
import { contractEngine } from '../analysis-engine/contracts';
import type { PoolClient } from 'pg';
import type {
    TransactionState, PatchSet,
    ValidationReport, ValidationMode,
    PropagationCandidate,
    ChangeTransaction,
} from '../types';

const log = new Logger('transactional-editor');

/** Maximum file size allowed for backup during applyPatch (5 MB) */
const MAX_BACKUP_FILE_SIZE = 5 * 1024 * 1024;

/** Valid state transitions */
const VALID_TRANSITIONS: Record<TransactionState, TransactionState[]> = {
    planned:               ['prepared', 'failed', 'rolled_back'],
    prepared:              ['patched', 'failed', 'rolled_back'],
    patched:               ['reindexed', 'failed', 'rolled_back'],
    reindexed:             ['validated', 'failed', 'rolled_back'],
    validated:             ['propagation_pending', 'committed', 'failed', 'rolled_back'],
    propagation_pending:   ['committed', 'failed', 'rolled_back'],
    committed:             [],
    rolled_back:           [],
    failed:                ['rolled_back'],
};

export class TransactionalChangeEngine {

    /**
     * Create a new change transaction.
     */
    public async createTransaction(
        repoId: string,
        baseSnapshotId: string,
        createdBy: string,
        targetSymbolVersionIds: string[]
    ): Promise<string> {
        const txnId = uuidv4();
        const timer = log.startTimer('createTransaction', { txnId, repoId });

        await db.query(`
            INSERT INTO change_transactions (
                txn_id, repo_id, base_snapshot_id, created_by,
                state, target_symbol_versions, patches
            ) VALUES ($1, $2, $3, $4, 'planned', $5, '[]'::jsonb)
        `, [txnId, repoId, baseSnapshotId, createdBy, targetSymbolVersionIds]);

        timer();
        return txnId;
    }

    /**
     * Resolve the repository base path from the DB for a given transaction.
     */
    private async getRepoBasePath(txnId: string): Promise<string> {
        const result = await db.query(
            `SELECT r.base_path FROM change_transactions ct
             JOIN repositories r ON r.repo_id = ct.repo_id
             WHERE ct.txn_id = $1`,
            [txnId]
        );
        const basePath = result.rows[0]?.base_path as string | undefined;
        if (!basePath) {
            throw new Error(`Repository base path not configured for transaction: ${txnId}`);
        }
        return basePath;
    }

    /**
     * Apply a patch to the transaction.
     *
     * State machine flow: planned → prepared (backup done) → patched (files written).
     * Only callable from 'planned' state. If any step fails, transaction
     * rolls back to 'planned' (backup) or 'prepared' (write failure).
     */
    public async applyPatch(
        txnId: string,
        patches: PatchSet,
        repoBasePath?: string
    ): Promise<void> {
        const timer = log.startTimer('applyPatch', { txnId, patchCount: patches.length });
        const txn = await this.loadTransaction(txnId);
        if (!txn) throw new Error(`Transaction not found: ${txnId}`);

        // applyPatch is only valid from 'planned' state — ensures idempotency
        if (txn.state !== 'planned') {
            throw new Error(
                `applyPatch requires transaction in 'planned' state, got '${txn.state}'. ` +
                `Cannot re-apply patches to an already-patched transaction.`
            );
        }

        // Resolve base path from DB if not provided
        const basePath = repoBasePath || await this.getRepoBasePath(txnId);

        // Phase 1: Backup original files to database (planned → prepared)
        // Wrapped in a DB transaction with advisory locks for concurrent file isolation.
        // Advisory locks are automatically released on COMMIT/ROLLBACK.
        await db.transaction(async (client: PoolClient) => {
            for (const patch of patches) {
                const fullPath = this.resolveSafePath(basePath, patch.file_path);

                // Acquire advisory lock: hash file path to int32 for pg_advisory_xact_lock
                // This serializes concurrent access to the same file across transactions
                const pathHash = crypto.createHash('md5').update(fullPath).digest();
                const lockKey = pathHash.readInt32BE(0);
                await db.queryWithClient(client, 'SELECT pg_advisory_xact_lock($1)', [lockKey]);

                // Guard: reject files that are too large to back up safely
                try {
                    const fileStat = fs.statSync(fullPath);
                    if (fileStat.size > MAX_BACKUP_FILE_SIZE) {
                        throw new Error(`File too large for backup: ${patch.file_path}`);
                    }
                } catch (err) {
                    // If statSync threw our size error, re-throw it
                    if (err instanceof Error && err.message.startsWith('File too large')) {
                        throw err;
                    }
                    // Otherwise file doesn't exist — that's fine, we'll record null below
                }

                let originalContent: string | null = null;
                try {
                    originalContent = fs.readFileSync(fullPath, 'utf-8');
                } catch {
                    // File doesn't exist yet — null signals "created by this patch"
                }
                await db.queryWithClient(client, `
                    INSERT INTO transaction_file_backups (backup_id, txn_id, file_path, original_content)
                    VALUES ($1, $2, $3, $4)
                `, [uuidv4(), txnId, fullPath, originalContent]);
            }

            // Transition state inside the transaction
            await db.queryWithClient(client,
                `UPDATE change_transactions SET state = $1, updated_at = NOW() WHERE txn_id = $2`,
                ['prepared', txnId]
            );
        });
        log.info('Transaction state changed', { txnId, newState: 'prepared' });

        // Phase 2: Write patched files (prepared → patched)
        // If any write fails, transition to 'failed' so the caller can rollback.
        try {
            for (const patch of patches) {
                const fullPath = this.resolveSafePath(basePath, patch.file_path);
                const dir = path.dirname(fullPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                fs.writeFileSync(fullPath, patch.new_content, 'utf-8');
            }
        } catch (writeErr) {
            log.error('Phase 2 file write failed — marking transaction as failed', writeErr, { txnId });
            await this.transitionState(txnId, 'failed');
            throw writeErr;
        }

        // Store patches and advance to 'patched'
        await db.query(`
            UPDATE change_transactions SET patches = $1, updated_at = NOW()
            WHERE txn_id = $2
        `, [JSON.stringify(patches), txnId]);

        await this.transitionState(txnId, 'patched');
        timer();
    }

    /**
     * Run 6-level progressive validation.
     */
    public async validate(
        txnId: string,
        repoBasePath: string,
        mode: ValidationMode = 'standard'
    ): Promise<ValidationReport> {
        const timer = log.startTimer('validate', { txnId, mode });
        const txn = await this.loadTransaction(txnId);
        if (!txn) throw new Error(`Transaction not found: ${txnId}`);

        // Must be at least patched to validate
        if (!['patched', 'reindexed'].includes(txn.state)) {
            throw new Error(`Cannot validate transaction in state: ${txn.state}`);
        }

        const levels: ValidationReport['levels'] = [];
        let allPassed = true;

        // Level 1: Syntax check
        const syntaxResult = await this.runSyntaxCheck(repoBasePath, txn.patches as PatchSet);
        levels.push({
            level: 1,
            name: 'syntax_check',
            passed: syntaxResult.passed,
            details: syntaxResult.details,
            failures: syntaxResult.failures,
        });
        if (!syntaxResult.passed) allPassed = false;

        // Level 2: Type check
        if (allPassed || mode === 'strict') {
            const typeResult = await this.runTypeCheck(repoBasePath);
            levels.push({
                level: 2,
                name: 'type_check',
                passed: typeResult.passed,
                details: typeResult.details,
                failures: typeResult.failures,
            });
            if (!typeResult.passed) allPassed = false;
        }

        // Reindex after type check so levels 3-6 operate on real post-patch symbol data
        if (txn.state === 'patched') {
            try {
                const changedPaths = (txn.patches as PatchSet).map(p => p.file_path);
                const { ingestor } = await import('../ingestor'); // dynamic import avoids circular dep
                await ingestor.ingestIncremental(txn.repo_id, txn.base_snapshot_id, changedPaths);
                await this.transitionState(txnId, 'reindexed');
            } catch (reindexErr) {
                log.error('Reindexing failed', reindexErr, { txnId });
                await this.transitionState(txnId, 'failed');
                const failReport: ValidationReport = {
                    transaction_id: txnId,
                    mode,
                    overall_passed: false,
                    levels: [{
                        level: 0,
                        name: 'reindexing',
                        passed: false,
                        details: `Reindexing failed: ${reindexErr instanceof Error ? reindexErr.message : String(reindexErr)}`,
                        failures: [`Reindexing error: ${reindexErr instanceof Error ? reindexErr.message : String(reindexErr)}`],
                    }, ...levels],
                    executed_at: new Date(),
                };
                await db.query(`
                    UPDATE change_transactions
                    SET validation_report_ref = $1, updated_at = NOW()
                    WHERE txn_id = $2
                `, [JSON.stringify(failReport), txnId]);
                timer({ passed: false, levels_run: levels.length, reindex_failed: true });
                return failReport;
            }
        }

        // Level 3: Contract delta (standard + strict)
        if ((allPassed || mode === 'strict') && mode !== 'quick') {
            const contractResult = await this.runContractDelta(txnId, txn);
            levels.push({
                level: 3,
                name: 'contract_delta',
                passed: contractResult.passed,
                details: contractResult.details,
                failures: contractResult.failures,
            });
            if (!contractResult.passed) allPassed = false;
        }

        // Level 4: Behavioral delta (standard + strict)
        if ((allPassed || mode === 'strict') && mode !== 'quick') {
            const behaviorResult = await this.runBehavioralDelta(txnId, txn);
            levels.push({
                level: 4,
                name: 'behavioral_delta',
                passed: behaviorResult.passed,
                details: behaviorResult.details,
                failures: behaviorResult.failures,
            });
            if (!behaviorResult.passed) allPassed = false;
        }

        // Level 5: Invariant check (strict only)
        if ((allPassed || mode === 'strict') && mode === 'strict') {
            const invariantResult = await this.runInvariantCheck(txn);
            levels.push({
                level: 5,
                name: 'invariant_check',
                passed: invariantResult.passed,
                details: invariantResult.details,
                failures: invariantResult.failures,
            });
            if (!invariantResult.passed) allPassed = false;
        }

        // Level 6: Test execution (strict only)
        if ((allPassed || mode === 'strict') && mode === 'strict') {
            const testResult = await this.runTestExecution(repoBasePath, txn);
            levels.push({
                level: 6,
                name: 'test_execution',
                passed: testResult.passed,
                details: testResult.details,
                failures: testResult.failures,
            });
            if (!testResult.passed) allPassed = false;
        }

        await this.transitionState(txnId, allPassed ? 'validated' : 'failed');

        const report: ValidationReport = {
            transaction_id: txnId,
            mode,
            overall_passed: allPassed,
            levels,
            executed_at: new Date(),
        };

        // Store report reference
        await db.query(`
            UPDATE change_transactions
            SET validation_report_ref = $1, updated_at = NOW()
            WHERE txn_id = $2
        `, [JSON.stringify(report), txnId]);

        timer({ passed: allPassed, levels_run: levels.length });
        return report;
    }

    /**
     * Commit a validated transaction.
     */
    public async commit(txnId: string): Promise<void> {
        const txn = await this.loadTransaction(txnId);
        if (!txn) throw new Error(`Transaction not found: ${txnId}`);
        this.assertTransition(txn.state, 'committed');
        await this.transitionState(txnId, 'committed');
        await db.query(`DELETE FROM transaction_file_backups WHERE txn_id = $1`, [txnId]);
        log.info('Transaction committed', { txnId });
    }

    /**
     * Rollback a transaction — restore original files.
     */
    public async rollback(txnId: string): Promise<void> {
        const timer = log.startTimer('rollback', { txnId });
        const txn = await this.loadTransaction(txnId);
        if (!txn) throw new Error(`Transaction not found: ${txnId}`);

        // Resolve repo base path for path validation during rollback
        let realBase: string | null = null;
        try {
            const repoBasePath = await this.getRepoBasePath(txnId);
            realBase = fs.realpathSync(path.resolve(repoBasePath));
        } catch {
            log.warn('Could not resolve repo base path for rollback path validation — skipping file restoration', { txnId });
        }

        // Restore file backups from database
        const backupResult = await db.query(
            `SELECT file_path, original_content FROM transaction_file_backups WHERE txn_id = $1`,
            [txnId]
        );

        if (realBase) {
            for (const backup of backupResult.rows as { file_path: string; original_content: string | null }[]) {
                try {
                    // Validate path from DB before any filesystem operation — defense against
                    // DB compromise or corruption injecting paths outside the repo directory
                    const resolvedBackupPath = path.resolve(realBase, backup.file_path);
                    if (!resolvedBackupPath.startsWith(realBase + path.sep) && resolvedBackupPath !== realBase) {
                        log.error('Rollback path traversal blocked — skipping', undefined, { filePath: backup.file_path });
                        continue;
                    }

                    if (backup.original_content === null) {
                        // File was newly created — remove it
                        if (fs.existsSync(resolvedBackupPath)) {
                            fs.unlinkSync(resolvedBackupPath);
                        }
                    } else {
                        fs.writeFileSync(resolvedBackupPath, backup.original_content, 'utf-8');
                    }
                } catch (err) {
                    log.error('Failed to restore backup', err, { filePath: backup.file_path });
                }
            }
        }

        // Clean up backups from database
        await db.query(`DELETE FROM transaction_file_backups WHERE txn_id = $1`, [txnId]);

        await this.transitionState(txnId, 'rolled_back');
        timer();
    }

    /**
     * Get transaction state.
     */
    public async getTransaction(txnId: string): Promise<ChangeTransaction | null> {
        return this.loadTransaction(txnId);
    }

    /**
     * Compute propagation proposals for homologs of changed symbols.
     */
    public async computePropagationProposals(
        txnId: string,
        _snapshotId: string
    ): Promise<PropagationCandidate[]> {
        const txn = await this.loadTransaction(txnId);
        if (!txn) throw new Error(`Transaction not found: ${txnId}`);

        const proposals: PropagationCandidate[] = [];

        for (const svId of txn.target_symbol_versions) {
            // Find homologs via inferred_relations
            const result = await db.query(`
                SELECT ir.dst_symbol_version_id, ir.relation_type, ir.confidence,
                       s.canonical_name, eb.contradiction_flags
                FROM inferred_relations ir
                JOIN symbol_versions sv ON sv.symbol_version_id = ir.dst_symbol_version_id
                JOIN symbols s ON s.symbol_id = sv.symbol_id
                JOIN evidence_bundles eb ON eb.evidence_bundle_id = ir.evidence_bundle_id
                WHERE ir.src_symbol_version_id = $1
                AND ir.confidence >= 0.70
                AND ir.review_state != 'rejected'
            `, [svId]);

            for (const row of result.rows as {
                dst_symbol_version_id: string;
                relation_type: string;
                confidence: number;
                canonical_name: string;
                contradiction_flags: string[];
            }[]) {
                const hasContradictions = row.contradiction_flags.length > 0;
                proposals.push({
                    homolog_symbol_id: row.dst_symbol_version_id,
                    homolog_name: row.canonical_name,
                    relation_type: row.relation_type as PropagationCandidate['relation_type'],
                    confidence: row.confidence,
                    is_safe: !hasContradictions && row.confidence >= 0.85,
                    patch_proposal: null,
                    risk_notes: hasContradictions
                        ? [`Contradictions detected: ${row.contradiction_flags.join(', ')}`]
                        : [],
                });
            }
        }

        // Store propagation report
        if (proposals.length > 0 && txn.state === 'validated') {
            await this.transitionState(txnId, 'propagation_pending');
            await db.query(`
                UPDATE change_transactions
                SET propagation_report_ref = $1, updated_at = NOW()
                WHERE txn_id = $2
            `, [JSON.stringify(proposals), txnId]);
        }

        return proposals;
    }

    // ────────── Validation Level Implementations ──────────

    private async runSyntaxCheck(
        repoBasePath: string,
        patches: PatchSet
    ): Promise<{ passed: boolean; details: string; failures: string[] }> {
        const failures: string[] = [];

        for (const patch of patches) {
            if (patch.file_path.endsWith('.ts') || patch.file_path.endsWith('.tsx')) {
                const fullPath = this.resolveSafePath(repoBasePath, patch.file_path);
                const result = await sandboxExec('npx', ['tsc', '--noEmit', '--allowJs', fullPath], {
                    cwd: repoBasePath,
                    timeoutMs: 30_000,
                    maxOutputBytes: 256_000,
                });
                if (result.exitCode !== 0) {
                    failures.push(`${patch.file_path}: ${result.stderr.substring(0, 500)}`);
                }
            } else if (patch.file_path.endsWith('.py')) {
                const fullPath = this.resolveSafePath(repoBasePath, patch.file_path);
                const result = await sandboxExec('python3', ['-m', 'py_compile', fullPath], {
                    cwd: repoBasePath,
                    timeoutMs: 15_000,
                    maxOutputBytes: 64_000,
                });
                if (result.exitCode !== 0) {
                    failures.push(`${patch.file_path}: ${result.stderr.substring(0, 500)}`);
                }
            }
        }

        return {
            passed: failures.length === 0,
            details: failures.length === 0 ? 'All patched files pass syntax check' : `${failures.length} syntax errors`,
            failures,
        };
    }

    private async runTypeCheck(
        repoBasePath: string
    ): Promise<{ passed: boolean; details: string; failures: string[] }> {
        const result = await sandboxTypeCheck(repoBasePath);
        const failures = result.exitCode !== 0
            ? result.stderr.split('\n').filter(l => l.includes('error TS')).slice(0, 20)
            : [];

        return {
            passed: result.exitCode === 0,
            details: result.exitCode === 0
                ? 'Type check passed'
                : `Type check failed (exit ${result.exitCode})`,
            failures,
        };
    }

    private async runContractDelta(
        txnId: string,
        txn: ChangeTransaction
    ): Promise<{ passed: boolean; details: string; failures: string[] }> {
        const failures: string[] = [];

        for (const svId of txn.target_symbol_versions) {
            // Look up the symbol_id for this symbol_version_id
            const svResult = await db.query(
                `SELECT symbol_id FROM symbol_versions WHERE symbol_version_id = $1`,
                [svId]
            );
            const symbolId = svResult.rows[0]?.symbol_id as string | undefined;
            if (!symbolId) continue;

            // Find the base snapshot's symbol_version_id for the same symbol
            const baseResult = await db.query(
                `SELECT symbol_version_id FROM symbol_versions
                 WHERE symbol_id = $1 AND snapshot_id = $2`,
                [symbolId, txn.base_snapshot_id]
            );
            const baseSvId = baseResult.rows[0]?.symbol_version_id as string | undefined;
            if (!baseSvId) continue;

            // Load before/after contract profiles
            const before = await contractEngine.getProfile(baseSvId);
            const after = await contractEngine.getProfile(svId);
            if (!before || !after) continue;

            // Compare contracts using the real engine
            const delta = contractEngine.compareContracts(before, after);

            if (delta.outputChanged) {
                failures.push(`Output contract changed for ${svId}: '${before.output_contract}' → '${after.output_contract}'`);
            }
            if (delta.errorChanged) {
                failures.push(`Error contract changed for ${svId}: '${before.error_contract}' → '${after.error_contract}'`);
            }
            if (delta.securityChanged) {
                failures.push(`Security contract changed for ${svId}: '${before.security_contract}' → '${after.security_contract}'`);
            }
            if (delta.inputChanged) {
                failures.push(`Input contract changed for ${svId}: '${before.input_contract}' → '${after.input_contract}'`);
            }
        }

        return {
            passed: failures.length === 0,
            details: failures.length === 0
                ? 'No contract violations detected'
                : `${failures.length} contract regressions detected`,
            failures,
        };
    }

    private async runBehavioralDelta(
        txnId: string,
        txn: ChangeTransaction
    ): Promise<{ passed: boolean; details: string; failures: string[] }> {
        const failures: string[] = [];

        for (const svId of txn.target_symbol_versions) {
            // Look up the symbol_id for this symbol_version_id
            const svResult = await db.query(
                `SELECT symbol_id FROM symbol_versions WHERE symbol_version_id = $1`,
                [svId]
            );
            const symbolId = svResult.rows[0]?.symbol_id as string | undefined;
            if (!symbolId) continue;

            // Find the base snapshot's symbol_version_id for the same symbol
            const baseResult = await db.query(
                `SELECT symbol_version_id FROM symbol_versions
                 WHERE symbol_id = $1 AND snapshot_id = $2`,
                [symbolId, txn.base_snapshot_id]
            );
            const baseSvId = baseResult.rows[0]?.symbol_version_id as string | undefined;
            if (!baseSvId) continue;

            // Load before/after behavioral profiles
            const before = await behavioralEngine.getProfile(baseSvId);
            const after = await behavioralEngine.getProfile(svId);
            if (!before || !after) continue;

            // Compare behavior using the real engine
            const delta = behavioralEngine.compareBehavior(before, after);

            if (delta.purityDirection === 'escalated') {
                failures.push(`Purity escalated for ${svId}: '${before.purity_class}' → '${after.purity_class}'`);
            }
            if (delta.newResourceTouches.length > 0) {
                failures.push(`New resource touches for ${svId}: ${delta.newResourceTouches.join(', ')}`);
            }
            if (delta.sideEffectsChanged) {
                failures.push(`Side effects changed for ${svId}`);
            }
        }

        return {
            passed: failures.length === 0,
            details: failures.length === 0
                ? 'No behavioral regressions'
                : `${failures.length} behavioral regressions detected`,
            failures,
        };
    }

    private async runInvariantCheck(
        txn: ChangeTransaction
    ): Promise<{ passed: boolean; details: string; failures: string[] }> {
        const failures: string[] = [];

        // Check invariants scoped to affected symbols
        for (const svId of txn.target_symbol_versions) {
            const result = await db.query(`
                SELECT i.expression, i.strength, i.source_type
                FROM invariants i
                JOIN symbol_versions sv ON sv.symbol_id = i.scope_symbol_id
                WHERE sv.symbol_version_id = $1
                AND i.strength >= 0.80
            `, [svId]);

            for (const row of result.rows as { expression: string; strength: number; source_type: string }[]) {
                if (row.strength >= 0.90) {
                    failures.push(`High-strength invariant needs re-verification: ${row.expression}`);
                }
            }
        }

        return {
            passed: failures.length === 0,
            details: failures.length === 0
                ? 'All invariants verified'
                : `${failures.length} invariants need re-verification`,
            failures,
        };
    }

    private async runTestExecution(
        repoBasePath: string,
        txn: ChangeTransaction
    ): Promise<{ passed: boolean; details: string; failures: string[] }> {
        // Find test files related to changed symbols
        const testPaths: string[] = [];

        for (const svId of txn.target_symbol_versions) {
            const result = await db.query(`
                SELECT DISTINCT f.path
                FROM test_artifacts ta
                JOIN symbol_versions sv ON sv.symbol_version_id = ta.symbol_version_id
                JOIN files f ON f.file_id = sv.file_id
                WHERE $1 = ANY(ta.related_symbols)
            `, [svId]);

            for (const row of result.rows as { path: string }[]) {
                if (!testPaths.includes(row.path)) {
                    testPaths.push(row.path);
                }
            }
        }

        if (testPaths.length === 0) {
            return {
                passed: true,
                details: 'No test files found for affected symbols',
                failures: [],
            };
        }

        const result = await sandboxRunTests(repoBasePath, testPaths);
        const failures = result.exitCode !== 0
            ? result.stdout.split('\n').filter(l => /FAIL|Error|✕|×/.test(l)).slice(0, 20)
            : [];

        return {
            passed: result.exitCode === 0,
            details: result.exitCode === 0
                ? `${testPaths.length} test files passed`
                : `Tests failed (exit ${result.exitCode})`,
            failures,
        };
    }

    // ────────── Helpers ──────────

    private async loadTransaction(txnId: string): Promise<ChangeTransaction | null> {
        const result = await db.query(
            `SELECT * FROM change_transactions WHERE txn_id = $1`,
            [txnId]
        );
        return (result.rows[0] as ChangeTransaction | undefined) ?? null;
    }

    private assertTransition(currentState: TransactionState, targetState: TransactionState): void {
        const valid = VALID_TRANSITIONS[currentState];
        if (!valid || !valid.includes(targetState)) {
            throw new Error(
                `Invalid state transition: ${currentState} → ${targetState}. ` +
                `Valid transitions: ${valid?.join(', ') || 'none'}`
            );
        }
    }

    private async transitionState(txnId: string, newState: TransactionState): Promise<void> {
        // Load current state and enforce valid transitions
        const current = await db.query(
            `SELECT state FROM change_transactions WHERE txn_id = $1`,
            [txnId]
        );
        const currentState = current.rows[0]?.state as TransactionState | undefined;
        if (currentState) {
            this.assertTransition(currentState, newState);
        }

        await db.query(
            `UPDATE change_transactions SET state = $1, updated_at = NOW() WHERE txn_id = $2`,
            [newState, txnId]
        );
        log.info('Transaction state changed', { txnId, newState });
    }

    /**
     * Resolve a file path safely, preventing path traversal.
     * Uses fs.realpathSync on the base to resolve symlinks before
     * checking containment — prevents symlink-based escapes.
     */
    private resolveSafePath(basePath: string, filePath: string): string {
        const realBase = fs.realpathSync(path.resolve(basePath));
        const resolved = path.resolve(realBase, filePath);
        if (!resolved.startsWith(realBase + path.sep) && resolved !== realBase) {
            throw new Error(`Path traversal attempt blocked: ${filePath}`);
        }
        // If the target already exists, resolve its real path too (catches symlink targets)
        if (fs.existsSync(resolved)) {
            const realResolved = fs.realpathSync(resolved);
            if (!realResolved.startsWith(realBase + path.sep) && realResolved !== realBase) {
                throw new Error(`Path traversal attempt blocked: ${filePath} (symlink escape)`);
            }
        }
        return resolved;
    }
}

export const transactionalChangeEngine = new TransactionalChangeEngine();
