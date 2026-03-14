/**
 * ContextZero — MCP Bridge Tool Handlers
 *
 * Direct-call implementations for all 22 ContextZero tools, executing engine
 * code without HTTP overhead. Each handler mirrors the logic from the REST API
 * but returns structured MCP CallToolResult payloads.
 *
 * All handlers follow the pattern:
 *   (args) => Promise<CallToolResult>
 *
 * Errors are caught and returned as isError:true results — handlers never throw.
 */

import { db } from '../db-driver';
import { coreDataService } from '../db-driver/core_data';
import { structuralGraphEngine } from '../analysis-engine';
import { behavioralEngine } from '../analysis-engine/behavioral';
import { contractEngine } from '../analysis-engine/contracts';
import { blastRadiusEngine } from '../analysis-engine/blast-radius';
import { capsuleCompiler } from '../analysis-engine/capsule-compiler';
import { uncertaintyTracker } from '../analysis-engine/uncertainty';
import { homologInferenceEngine } from '../homolog-engine';
import { transactionalChangeEngine } from '../transactional-editor';
import { ingestor } from '../ingestor';
import type { CapsuleMode, ValidationMode } from '../types';
import type { McpLogger } from './index';

// ────────── MCP CallToolResult ──────────
//
// We define a precise type matching what the MCP SDK expects.
// The content array items must use literal 'text' for the type field.

interface TextContent {
    type: 'text';
    text: string;
}

interface CallToolResult {
    content: TextContent[];
    isError?: boolean;
    [key: string]: unknown;
}

// ────────── Shared Helpers ──────────

/** Standard MCP text result */
function textResult(data: unknown): CallToolResult {
    return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
}

/** MCP error result (isError: true) */
function errorResult(message: string): CallToolResult {
    return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
        isError: true,
    };
}

/** Resolve repo base path for a transaction from the DB */
async function resolveRepoBasePathForTxn(txnId: string): Promise<string | null> {
    const result = await db.query(
        `SELECT r.base_path FROM change_transactions ct
         JOIN repositories r ON r.repo_id = ct.repo_id
         WHERE ct.txn_id = $1`,
        [txnId],
    );
    return (result.rows[0]?.base_path as string) ?? null;
}

// ────────── UUID validation ──────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUUID(v: unknown): v is string {
    return typeof v === 'string' && UUID_RE.test(v);
}

// ────────── Tool 1: Resolve Symbol ──────────

export async function handleResolveSymbol(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const query = args.query as string;
    const repo_id = args.repo_id as string;
    const snapshot_id = args.snapshot_id as string | undefined;
    const kind_filter = args.kind_filter as string | undefined;
    const limit = typeof args.limit === 'number' ? Math.min(Math.max(args.limit, 1), 100) : 10;

    if (!query || typeof query !== 'string') return errorResult('query is required and must be a string');
    if (!isUUID(repo_id)) return errorResult('repo_id is required and must be a valid UUID');
    if (snapshot_id !== undefined && !isUUID(snapshot_id)) return errorResult('snapshot_id must be a valid UUID');

    log.debug('scg_resolve_symbol', { query, repo_id });

    let sql = `
        SELECT s.symbol_id, s.canonical_name, s.kind, s.stable_key,
               sv.symbol_version_id, sv.signature, sv.visibility,
               f.path as file_path,
               similarity(s.canonical_name, $1) as name_sim
        FROM symbols s
        JOIN symbol_versions sv ON sv.symbol_id = s.symbol_id
        JOIN files f ON f.file_id = sv.file_id
        WHERE s.repo_id = $2
    `;
    const params: unknown[] = [query, repo_id];
    let paramIdx = 3;

    if (snapshot_id) {
        sql += ` AND sv.snapshot_id = $${paramIdx}`;
        params.push(snapshot_id);
        paramIdx++;
    }

    if (kind_filter) {
        sql += ` AND s.kind = $${paramIdx}`;
        params.push(kind_filter);
        paramIdx++;
    }

    sql += ` AND (s.canonical_name % $1 OR s.canonical_name ILIKE '%' || $1 || '%')`;
    sql += ` ORDER BY name_sim DESC LIMIT $${paramIdx}`;
    params.push(limit);

    const result = await db.query(sql, params);
    return textResult({ symbols: result.rows, count: result.rowCount });
}

// ────────── Tool 2: Get Symbol Details ──────────

export async function handleGetSymbolDetails(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const symbol_version_id = args.symbol_version_id as string;
    const view_mode = (args.view_mode as string) || 'summary';

    if (!isUUID(symbol_version_id)) return errorResult('symbol_version_id is required and must be a valid UUID');
    if (!['code', 'summary', 'signature'].includes(view_mode)) {
        return errorResult('view_mode must be one of: code, summary, signature');
    }

    log.debug('scg_get_symbol_details', { symbol_version_id, view_mode });

    const svResult = await db.query(`
        SELECT sv.*, s.canonical_name, s.kind, s.stable_key, s.repo_id,
               f.path as file_path
        FROM symbol_versions sv
        JOIN symbols s ON s.symbol_id = sv.symbol_id
        JOIN files f ON f.file_id = sv.file_id
        WHERE sv.symbol_version_id = $1
    `, [symbol_version_id]);

    if (svResult.rows.length === 0) {
        return errorResult('Symbol version not found');
    }

    const sv = svResult.rows[0] as Record<string, unknown>;
    const response: Record<string, unknown> = { symbol: sv };

    if (view_mode === 'signature') {
        response.symbol = {
            symbol_version_id: sv.symbol_version_id,
            canonical_name: sv.canonical_name,
            kind: sv.kind,
            signature: sv.signature,
            file_path: sv.file_path,
        };
    } else if (view_mode === 'code' || view_mode === 'summary') {
        const [bp, cp] = await Promise.all([
            behavioralEngine.getProfile(symbol_version_id),
            contractEngine.getProfile(symbol_version_id),
        ]);
        if (bp) response.behavioral_profile = bp;
        if (cp) response.contract_profile = cp;
    }

    return textResult(response);
}

// ────────── Tool 3: Get Symbol Relations ──────────

export async function handleGetSymbolRelations(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const symbol_version_id = args.symbol_version_id as string;
    const direction = (args.direction as string) || 'both';

    if (!isUUID(symbol_version_id)) return errorResult('symbol_version_id is required and must be a valid UUID');
    if (!['inbound', 'outbound', 'both'].includes(direction)) {
        return errorResult('direction must be one of: inbound, outbound, both');
    }

    log.debug('scg_get_symbol_relations', { symbol_version_id, direction });

    let relations;
    if (direction === 'inbound') {
        relations = await structuralGraphEngine.getCallers(symbol_version_id);
    } else if (direction === 'outbound') {
        relations = await structuralGraphEngine.getCallees(symbol_version_id);
    } else {
        relations = await structuralGraphEngine.getRelationsForSymbol(symbol_version_id);
    }

    return textResult({ relations, count: relations.length });
}

// ────────── Tool 4: Get Behavioral Profile ──────────

export async function handleGetBehavioralProfile(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const symbol_version_id = args.symbol_version_id as string;
    if (!isUUID(symbol_version_id)) return errorResult('symbol_version_id is required and must be a valid UUID');

    log.debug('scg_get_behavioral_profile', { symbol_version_id });

    const profile = await behavioralEngine.getProfile(symbol_version_id);
    if (!profile) {
        return errorResult('Behavioral profile not found');
    }
    return textResult({ profile });
}

// ────────── Tool 5: Get Contract Profile ──────────

export async function handleGetContractProfile(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const symbol_version_id = args.symbol_version_id as string;
    if (!isUUID(symbol_version_id)) return errorResult('symbol_version_id is required and must be a valid UUID');

    log.debug('scg_get_contract_profile', { symbol_version_id });

    const profile = await contractEngine.getProfile(symbol_version_id);
    if (!profile) {
        return errorResult('Contract profile not found');
    }
    return textResult({ profile });
}

// ────────── Tool 6: Get Invariants ──────────

export async function handleGetInvariants(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const symbol_id = args.symbol_id as string;
    if (!isUUID(symbol_id)) return errorResult('symbol_id is required and must be a valid UUID');

    log.debug('scg_get_invariants', { symbol_id });

    const invariants = await contractEngine.getInvariantsForSymbol(symbol_id);
    return textResult({ invariants, count: invariants.length });
}

// ────────── Tool 7: Get Uncertainty Report ──────────

export async function handleGetUncertainty(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const snapshot_id = args.snapshot_id as string;
    if (!isUUID(snapshot_id)) return errorResult('snapshot_id is required and must be a valid UUID');

    log.debug('scg_get_uncertainty', { snapshot_id });

    const report = await uncertaintyTracker.getSnapshotUncertainty(snapshot_id);
    return textResult({ report });
}

// ────────── Tool 8: Find Homologs ──────────

export async function handleFindHomologs(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const symbol_version_id = args.symbol_version_id as string;
    const snapshot_id = args.snapshot_id as string;
    const confidence_threshold = typeof args.confidence_threshold === 'number'
        ? Math.min(Math.max(args.confidence_threshold, 0), 1)
        : 0.70;

    if (!isUUID(symbol_version_id)) return errorResult('symbol_version_id is required and must be a valid UUID');
    if (!isUUID(snapshot_id)) return errorResult('snapshot_id is required and must be a valid UUID');

    log.debug('scg_find_homologs', { symbol_version_id, snapshot_id, confidence_threshold });

    const homologs = await homologInferenceEngine.findHomologs(
        symbol_version_id, snapshot_id, confidence_threshold,
    );

    return textResult({ homologs, count: homologs.length });
}

// ────────── Tool 9: Blast Radius ──────────

export async function handleBlastRadius(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const symbol_version_ids = args.symbol_version_ids;
    const snapshot_id = args.snapshot_id as string;
    const depth = typeof args.depth === 'number' ? Math.min(Math.max(args.depth, 1), 5) : 2;

    if (!Array.isArray(symbol_version_ids) || symbol_version_ids.length === 0) {
        return errorResult('symbol_version_ids is required and must be a non-empty array of UUIDs');
    }
    for (const id of symbol_version_ids) {
        if (!isUUID(id)) return errorResult(`Invalid UUID in symbol_version_ids: ${id}`);
    }
    if (!isUUID(snapshot_id)) return errorResult('snapshot_id is required and must be a valid UUID');

    log.debug('scg_blast_radius', { symbol_version_ids, snapshot_id, depth });

    const report = await blastRadiusEngine.computeBlastRadius(
        snapshot_id, symbol_version_ids as string[], depth,
    );

    return textResult({ report });
}

// ────────── Tool 10: Compile Context Capsule ──────────

export async function handleCompileContextCapsule(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const symbol_version_id = args.symbol_version_id as string;
    const snapshot_id = args.snapshot_id as string;
    const mode = (args.mode as string) || 'standard';
    const token_budget = typeof args.token_budget === 'number'
        ? Math.min(Math.max(args.token_budget, 100), 100_000)
        : 8000;

    if (!isUUID(symbol_version_id)) return errorResult('symbol_version_id is required and must be a valid UUID');
    if (!isUUID(snapshot_id)) return errorResult('snapshot_id is required and must be a valid UUID');
    if (!['minimal', 'standard', 'strict'].includes(mode)) {
        return errorResult('mode must be one of: minimal, standard, strict');
    }

    log.debug('scg_compile_context_capsule', { symbol_version_id, snapshot_id, mode, token_budget });

    // Resolve repo base path from DB
    const basePathResult = await db.query(
        `SELECT r.base_path FROM repositories r
         JOIN symbols s ON s.repo_id = r.repo_id
         JOIN symbol_versions sv ON sv.symbol_id = s.symbol_id
         WHERE sv.symbol_version_id = $1`,
        [symbol_version_id],
    );
    const repoBasePath = basePathResult.rows[0]?.base_path as string | undefined;

    const capsule = await capsuleCompiler.compile(
        symbol_version_id, snapshot_id, mode as CapsuleMode, token_budget, repoBasePath,
    );

    return textResult({ capsule });
}

// ────────── Tool 11: Create Change Transaction ──────────

export async function handleCreateChangeTransaction(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const repo_id = args.repo_id as string;
    const base_snapshot_id = args.base_snapshot_id as string;
    const created_by = (args.created_by as string) || 'mcp';
    const target_symbol_version_ids = args.target_symbol_version_ids;
    const task_description = args.task_description as string | undefined;

    if (!isUUID(repo_id)) return errorResult('repo_id is required and must be a valid UUID');
    if (!isUUID(base_snapshot_id)) return errorResult('base_snapshot_id is required and must be a valid UUID');
    if (!Array.isArray(target_symbol_version_ids) || target_symbol_version_ids.length === 0) {
        return errorResult('target_symbol_version_ids is required and must be a non-empty array of UUIDs');
    }
    for (const id of target_symbol_version_ids) {
        if (!isUUID(id)) return errorResult(`Invalid UUID in target_symbol_version_ids: ${id}`);
    }

    log.debug('scg_create_change_transaction', { repo_id, base_snapshot_id });

    const txnId = await transactionalChangeEngine.createTransaction(
        repo_id, base_snapshot_id, created_by,
        target_symbol_version_ids as string[],
    );

    if (task_description) {
        await db.query(`
            UPDATE change_transactions
            SET impact_report_ref = $1, updated_at = NOW()
            WHERE txn_id = $2
        `, [JSON.stringify({ task_description }), txnId]);
    }

    return textResult({ txn_id: txnId, state: 'planned' });
}

// ────────── Tool 12: Apply Patch ──────────

export async function handleApplyPatch(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const txn_id = args.txn_id as string;
    const patches = args.patches;

    if (!isUUID(txn_id)) return errorResult('txn_id is required and must be a valid UUID');
    if (!Array.isArray(patches) || patches.length === 0) {
        return errorResult('patches is required and must be a non-empty array');
    }

    // Validate patch structure
    for (let i = 0; i < patches.length; i++) {
        const p = patches[i] as Record<string, unknown>;
        if (!p || typeof p.file_path !== 'string' || typeof p.new_content !== 'string') {
            return errorResult(`patches[${i}] must have file_path (string) and new_content (string)`);
        }
    }

    log.debug('scg_apply_patch', { txn_id, patch_count: patches.length });

    const repoBasePath = await resolveRepoBasePathForTxn(txn_id);
    if (!repoBasePath) {
        return errorResult('Repository base path not configured for this transaction');
    }

    await transactionalChangeEngine.applyPatch(txn_id, patches, repoBasePath);
    return textResult({ txn_id, state: 'patched' });
}

// ────────── Tool 13: Validate Change ──────────

export async function handleValidateChange(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const txn_id = args.txn_id as string;
    const mode = (args.mode as string) || 'standard';

    if (!isUUID(txn_id)) return errorResult('txn_id is required and must be a valid UUID');
    if (!['quick', 'standard', 'strict'].includes(mode)) {
        return errorResult('mode must be one of: quick, standard, strict');
    }

    log.debug('scg_validate_change', { txn_id, mode });

    const repoBasePath = await resolveRepoBasePathForTxn(txn_id);
    if (!repoBasePath) {
        return errorResult('Repository base path not configured for this transaction');
    }

    const report = await transactionalChangeEngine.validate(txn_id, repoBasePath, mode as ValidationMode);
    return textResult({ report });
}

// ────────── Tool 14: Commit Change ──────────

export async function handleCommitChange(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const txn_id = args.txn_id as string;
    if (!isUUID(txn_id)) return errorResult('txn_id is required and must be a valid UUID');

    log.debug('scg_commit_change', { txn_id });

    await transactionalChangeEngine.commit(txn_id);
    return textResult({ txn_id, state: 'committed' });
}

// ────────── Tool 15: Rollback Change ──────────

export async function handleRollbackChange(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const txn_id = args.txn_id as string;
    if (!isUUID(txn_id)) return errorResult('txn_id is required and must be a valid UUID');

    log.debug('scg_rollback_change', { txn_id });

    await transactionalChangeEngine.rollback(txn_id);
    return textResult({ txn_id, state: 'rolled_back' });
}

// ────────── Tool 16: Propagation Proposals ──────────

export async function handlePropagationProposals(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const txn_id = args.txn_id as string;
    const snapshot_id = args.snapshot_id as string;

    if (!isUUID(txn_id)) return errorResult('txn_id is required and must be a valid UUID');
    if (!isUUID(snapshot_id)) return errorResult('snapshot_id is required and must be a valid UUID');

    log.debug('scg_propagation_proposals', { txn_id, snapshot_id });

    const proposals = await transactionalChangeEngine.computePropagationProposals(txn_id, snapshot_id);
    return textResult({ proposals, count: proposals.length });
}

// ────────── Tool 17: Get Transaction ──────────

export async function handleGetTransaction(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const txn_id = args.txn_id as string;
    if (!isUUID(txn_id)) return errorResult('txn_id is required and must be a valid UUID');

    log.debug('scg_get_transaction', { txn_id });

    const txn = await transactionalChangeEngine.getTransaction(txn_id);
    if (!txn) {
        return errorResult('Transaction not found');
    }
    return textResult({ transaction: txn });
}

// ────────── Tool 18: Ingest Repository ──────────

export async function handleIngestRepo(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const repo_id = args.repo_id as string;
    const commit_sha = args.commit_sha as string;
    const branch = (args.branch as string) || 'main';

    if (!isUUID(repo_id)) return errorResult('repo_id is required and must be a valid UUID');
    if (!commit_sha || typeof commit_sha !== 'string') return errorResult('commit_sha is required and must be a string');

    log.debug('scg_ingest_repo', { repo_id, commit_sha, branch });

    const repo = await coreDataService.getRepository(repo_id);
    if (!repo) {
        return errorResult('Repository not found. Register it first via scg_register_repo (REST API)');
    }

    const repoBasePath = (repo as Record<string, unknown>).base_path as string | undefined;
    if (!repoBasePath) {
        return errorResult('Repository base path not configured. Register it first via scg_register_repo (REST API)');
    }

    const repoName = (repo as Record<string, unknown>).name as string;
    const result = await ingestor.ingestRepo(repoBasePath, repoName, commit_sha, branch);
    return textResult({ result });
}

// ────────── Tool 19: List Repositories ──────────

export async function handleListRepos(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const limit = typeof args.limit === 'number' ? Math.min(Math.max(args.limit, 1), 100) : 20;
    const offset = typeof args.offset === 'number' ? Math.min(Math.max(args.offset, 0), 100_000) : 0;

    log.debug('scg_list_repos', { limit, offset });

    const result = await db.query(
        `SELECT * FROM repositories ORDER BY updated_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset],
    );
    return textResult({ repositories: result.rows, count: result.rowCount });
}

// ────────── Tool 20: List Snapshots ──────────

export async function handleListSnapshots(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const repo_id = args.repo_id as string;
    const limit = typeof args.limit === 'number' ? Math.min(Math.max(args.limit, 1), 100) : 20;
    const offset = typeof args.offset === 'number' ? Math.min(Math.max(args.offset, 0), 100_000) : 0;

    if (!isUUID(repo_id)) return errorResult('repo_id is required and must be a valid UUID');

    log.debug('scg_list_snapshots', { repo_id, limit, offset });

    const result = await db.query(`
        SELECT * FROM snapshots
        WHERE repo_id = $1
        ORDER BY indexed_at DESC
        LIMIT $2 OFFSET $3
    `, [repo_id, limit, offset]);

    return textResult({ snapshots: result.rows, count: result.rowCount });
}

// ────────── Tool 21: Snapshot Stats ──────────

export async function handleSnapshotStats(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const snapshot_id = args.snapshot_id as string;
    if (!isUUID(snapshot_id)) return errorResult('snapshot_id is required and must be a valid UUID');

    log.debug('scg_snapshot_stats', { snapshot_id });

    // BUG-001 fix: Check if the snapshot actually exists and has data.
    // Ghost snapshots (orphaned after re-ingestion) return empty results
    // instead of an error, which silently misleads clients.
    const snapshotCheck = await db.query(
        `SELECT snapshot_id, index_status FROM snapshots WHERE snapshot_id = $1`,
        [snapshot_id],
    );
    if (snapshotCheck.rows.length === 0) {
        return errorResult(`Snapshot not found: ${snapshot_id}`);
    }

    const [fileCount, symbolCount, relationCount, uncertaintyReport] = await Promise.all([
        db.query(`SELECT COUNT(*) as cnt FROM files WHERE snapshot_id = $1`, [snapshot_id]),
        db.query(`SELECT COUNT(*) as cnt FROM symbol_versions WHERE snapshot_id = $1`, [snapshot_id]),
        db.query(`
            SELECT COUNT(*) as cnt FROM structural_relations sr
            JOIN symbol_versions sv ON sv.symbol_version_id = sr.src_symbol_version_id
            WHERE sv.snapshot_id = $1
        `, [snapshot_id]),
        uncertaintyTracker.getSnapshotUncertainty(snapshot_id),
    ]);

    const files = parseInt(fileCount.rows[0]?.cnt as string || '0', 10);
    const symbols = parseInt(symbolCount.rows[0]?.cnt as string || '0', 10);

    // If a snapshot exists but has zero files and zero symbols, it's orphaned
    if (files === 0 && symbols === 0) {
        const status = snapshotCheck.rows[0]?.index_status as string;
        if (status === 'complete' || status === 'partial') {
            return errorResult(
                `Snapshot ${snapshot_id} is orphaned — it was superseded by a newer ingestion. ` +
                `Re-ingest the repository to get a fresh snapshot.`
            );
        }
    }

    return textResult({
        snapshot_id,
        files,
        symbols,
        relations: parseInt(relationCount.rows[0]?.cnt as string || '0', 10),
        uncertainty: uncertaintyReport,
    });
}

// ────────── Tool 22: Persist Homologs ──────────

export async function handlePersistHomologs(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const source_symbol_version_id = args.source_symbol_version_id as string;
    const snapshot_id = args.snapshot_id as string;
    const confidence_threshold = typeof args.confidence_threshold === 'number'
        ? Math.min(Math.max(args.confidence_threshold, 0), 1)
        : 0.70;

    if (!isUUID(source_symbol_version_id)) return errorResult('source_symbol_version_id is required and must be a valid UUID');
    if (!isUUID(snapshot_id)) return errorResult('snapshot_id is required and must be a valid UUID');

    log.debug('scg_persist_homologs', { source_symbol_version_id, snapshot_id, confidence_threshold });

    const homologs = await homologInferenceEngine.findHomologs(
        source_symbol_version_id, snapshot_id, confidence_threshold,
    );

    const persisted = await homologInferenceEngine.persistHomologs(
        source_symbol_version_id, homologs, snapshot_id,
    );

    return textResult({ homologs_found: homologs.length, persisted });
}
