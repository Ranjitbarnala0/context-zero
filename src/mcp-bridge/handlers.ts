/**
 * ContextZero — MCP Bridge Tool Handlers
 *
 * Direct-call implementations for all 27 ContextZero tools, executing engine
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
import { tokenizeBody } from '../semantic-engine/tokenizer';
import { computeTF, computeTFIDF, cosineSimilarity, SparseVector } from '../semantic-engine/similarity';
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
    const rawConf = typeof args.confidence_threshold === 'number' ? args.confidence_threshold
        : typeof args.confidence_threshold === 'string' ? parseFloat(args.confidence_threshold) : NaN;
    const confidence_threshold = Number.isFinite(rawConf) ? Math.min(Math.max(rawConf, 0), 1) : 0.60;

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
    const rawDepth = typeof args.depth === 'number' ? args.depth : typeof args.depth === 'string' ? parseInt(args.depth, 10) : NaN;
    const depth = Number.isFinite(rawDepth) ? Math.min(Math.max(rawDepth, 1), 5) : 2;

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
    const rawConf = typeof args.confidence_threshold === 'number' ? args.confidence_threshold
        : typeof args.confidence_threshold === 'string' ? parseFloat(args.confidence_threshold) : NaN;
    const confidence_threshold = Number.isFinite(rawConf) ? Math.min(Math.max(rawConf, 0), 1) : 0.60;

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

// ────────── Tool 23: Read Source Code ──────────
//
// Serves symbol source directly from the database (body_source column).
// No disk I/O required — works in Docker, remote deployments, and
// survives repo path changes. Falls back to disk for pre-migration data.
// Supports batch queries (multiple symbol_version_ids in one call).

export async function handleReadSource(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const repo_id = args.repo_id as string;
    const symbol_version_id = args.symbol_version_id as string | undefined;
    const symbol_version_ids = args.symbol_version_ids as string[] | undefined;
    const file_path = args.file_path as string | undefined;
    const start_line = typeof args.start_line === 'number' ? args.start_line : undefined;
    const end_line = typeof args.end_line === 'number' ? args.end_line : undefined;
    const context_lines = typeof args.context_lines === 'number' ? Math.min(args.context_lines, 50) : 0;

    if (!isUUID(repo_id)) return errorResult('repo_id is required and must be a valid UUID');

    // Batch mode: multiple symbol_version_ids
    const ids: string[] = [];
    if (symbol_version_ids && Array.isArray(symbol_version_ids)) {
        for (const id of symbol_version_ids) {
            if (isUUID(id)) ids.push(id);
        }
    } else if (symbol_version_id && isUUID(symbol_version_id)) {
        ids.push(symbol_version_id);
    }

    if (ids.length === 0 && !file_path) {
        return errorResult('Either symbol_version_id, symbol_version_ids, or file_path is required');
    }

    log.debug('scg_read_source', { repo_id, ids: ids.length, file_path });

    // Symbol-scoped serving (batch)
    if (ids.length > 0) {
        const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
        const svResult = await db.query(`
            SELECT sv.symbol_version_id, sv.range_start_line, sv.range_end_line,
                   sv.signature, sv.summary, sv.body_source,
                   s.canonical_name, s.kind, s.stable_key,
                   f.path as file_path
            FROM symbol_versions sv
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            JOIN files f ON f.file_id = sv.file_id
            WHERE sv.symbol_version_id IN (${placeholders})
        `, ids);

        if (svResult.rows.length === 0) return errorResult('No symbol versions found');

        const symbols = (svResult.rows as {
            symbol_version_id: string;
            range_start_line: number;
            range_end_line: number;
            signature: string;
            summary: string;
            body_source: string | null;
            canonical_name: string;
            kind: string;
            stable_key: string;
            file_path: string;
        }[]).map(sv => {
            // Nullish coalescing: empty string is a valid body
            const source = sv.body_source ?? null;

            return {
                symbol_version_id: sv.symbol_version_id,
                canonical_name: sv.canonical_name,
                kind: sv.kind,
                signature: sv.signature,
                summary: sv.summary,
                file_path: sv.file_path,
                start_line: sv.range_start_line,
                end_line: sv.range_end_line,
                source: source || '[source unavailable]',
                token_estimate: source ? Math.ceil(source.length / 4) : 0,
            };
        });

        return textResult({ symbols, count: symbols.length });
    }

    // File-path mode (unchanged — reads from disk)
    const repo = await coreDataService.getRepository(repo_id);
    if (!repo) return errorResult('Repository not found');
    const basePath = repo.base_path as string;
    if (!basePath) return errorResult('Repository base path not configured');

    const fs = await import('fs');
    const path = await import('path');

    const resolvedPath = path.resolve(basePath, file_path!);

    // Path traversal protection
    let realBase: string;
    try { realBase = fs.realpathSync(basePath); } catch { return errorResult('Base path not accessible'); }
    if (!resolvedPath.startsWith(realBase + path.sep) && resolvedPath !== realBase) {
        return errorResult('Path traversal blocked');
    }

    try {
        const content = fs.readFileSync(resolvedPath, 'utf-8');
        const lines = content.split('\n');

        let outputLines: string[];
        if (start_line !== undefined && end_line !== undefined) {
            const s = Math.max(1, start_line);
            const e = Math.min(lines.length, end_line);
            outputLines = lines.slice(s - 1, e).map((line, i) => `${s + i}: ${line}`);
        } else {
            const cap = Math.min(lines.length, 500);
            outputLines = lines.slice(0, cap).map((line, i) => `${i + 1}: ${line}`);
            if (lines.length > 500) {
                outputLines.push(`... (${lines.length - 500} more lines truncated)`);
            }
        }

        return textResult({
            file_path,
            total_lines: lines.length,
            source: outputLines.join('\n'),
        });
    } catch {
        return errorResult('File not readable');
    }
}


// ────────── Tool 24: Search Code ──────────
//
// Grep/search across indexed files in a repository. Returns matching
// lines with context. This enables deep audit through MCP without
// needing to read every file manually.

export async function handleSearchCode(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const repo_id = args.repo_id as string;
    const pattern = args.pattern as string;
    const file_pattern = args.file_pattern as string | undefined;
    const max_results = typeof args.max_results === 'number' ? Math.min(args.max_results, 100) : 30;
    const context_lines_count = typeof args.context_lines === 'number' ? Math.min(args.context_lines, 5) : 2;

    if (!isUUID(repo_id)) return errorResult('repo_id is required and must be a valid UUID');
    if (!pattern || typeof pattern !== 'string') return errorResult('pattern is required');
    if (pattern.length > 500) return errorResult('pattern too long (max 500 chars)');

    log.debug('scg_search_code', { repo_id, pattern, file_pattern });

    // Resolve repo base path
    const repo = await coreDataService.getRepository(repo_id);
    if (!repo) return errorResult('Repository not found');
    const basePath = repo.base_path as string;
    if (!basePath) return errorResult('Repository base path not configured');

    const fs = await import('fs');
    const path = await import('path');

    // Get indexed files for this repo
    const filesResult = await db.query(`
        SELECT DISTINCT f.path FROM files f
        JOIN snapshots snap ON snap.snapshot_id = f.snapshot_id
        WHERE snap.repo_id = $1
        ORDER BY f.path
    `, [repo_id]);

    let regex: RegExp;
    try {
        regex = new RegExp(pattern, 'gi');
    } catch {
        // Fall back to literal string match if regex is invalid
        regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    }

    const matches: { file: string; line: number; text: string; context: string[] }[] = [];

    for (const row of filesResult.rows as { path: string }[]) {
        if (matches.length >= max_results) break;

        // Apply file pattern filter
        if (file_pattern) {
            const fp = row.path.toLowerCase();
            const pat = file_pattern.toLowerCase();
            if (!fp.includes(pat) && !fp.endsWith(pat)) continue;
        }

        const fullPath = path.resolve(basePath, row.path);

        // Path safety
        try {
            const realBase = fs.realpathSync(basePath);
            if (!fullPath.startsWith(realBase + path.sep)) continue;
        } catch { continue; }

        try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            const lines = content.split('\n');

            for (let i = 0; i < lines.length && matches.length < max_results; i++) {
                regex.lastIndex = 0;
                if (regex.test(lines[i]!)) {
                    const ctxStart = Math.max(0, i - context_lines_count);
                    const ctxEnd = Math.min(lines.length - 1, i + context_lines_count);
                    const contextArr: string[] = [];
                    for (let c = ctxStart; c <= ctxEnd; c++) {
                        const prefix = c === i ? '>' : ' ';
                        contextArr.push(`${prefix} ${c + 1}: ${lines[c]}`);
                    }
                    matches.push({
                        file: row.path,
                        line: i + 1,
                        text: (lines[i] ?? '').trim(),
                        context: contextArr,
                    });
                }
            }
        } catch { continue; }
    }

    return textResult({
        pattern,
        total_matches: matches.length,
        matches: matches.map(m => ({
            file: m.file,
            line: m.line,
            match: m.text,
            context: m.context.join('\n'),
        })),
    });
}

// ────────── Tool 25: Codebase Overview ──────────
//
// High-level architecture summary with risk assessment. Answers:
// "What does this codebase look like? Where are the risks?"
// This is the tool that turns ContextZero from an indexer into an auditor.

export async function handleCodebaseOverview(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const repo_id = args.repo_id as string;
    const snapshot_id = args.snapshot_id as string;

    if (!isUUID(repo_id)) return errorResult('repo_id is required and must be a valid UUID');
    if (!isUUID(snapshot_id)) return errorResult('snapshot_id is required and must be a valid UUID');

    log.debug('scg_codebase_overview', { repo_id, snapshot_id });

    // 1. File structure summary
    const filesResult = await db.query(`
        SELECT f.path, f.language FROM files
        WHERE snapshot_id = $1
        ORDER BY f.path
    `, [snapshot_id]);
    const files = filesResult.rows as { path: string; language: string }[];

    // Group by directory and language
    const dirCounts: Record<string, number> = {};
    const langCounts: Record<string, number> = {};
    for (const f of files) {
        const dir = f.path.split('/').slice(0, -1).join('/') || '.';
        dirCounts[dir] = (dirCounts[dir] || 0) + 1;
        const lang = f.language || 'unknown';
        langCounts[lang] = (langCounts[lang] || 0) + 1;
    }

    // 2. Symbol summary — kinds, visibility, complexity indicators
    const symbolsResult = await db.query(`
        SELECT s.kind, sv.visibility, sv.summary,
               s.canonical_name, f.path as file_path,
               sv.symbol_version_id
        FROM symbol_versions sv
        JOIN symbols s ON s.symbol_id = sv.symbol_id
        JOIN files f ON f.file_id = sv.file_id
        WHERE sv.snapshot_id = $1
        ORDER BY s.kind, s.canonical_name
    `, [snapshot_id]);
    const symbols = symbolsResult.rows as {
        kind: string; visibility: string; summary: string;
        canonical_name: string; file_path: string; symbol_version_id: string;
    }[];

    const kindCounts: Record<string, number> = {};
    const publicSymbols: string[] = [];
    for (const s of symbols) {
        kindCounts[s.kind] = (kindCounts[s.kind] || 0) + 1;
        if (s.visibility === 'public') publicSymbols.push(`${s.kind}:${s.canonical_name} (${s.file_path})`);
    }

    // 3. Behavioral risk — side-effecting and read_write functions
    const behaviorResult = await db.query(`
        SELECT bp.purity_class, COUNT(*) as cnt
        FROM behavioral_profiles bp
        JOIN symbol_versions sv ON sv.symbol_version_id = bp.symbol_version_id
        WHERE sv.snapshot_id = $1
        GROUP BY bp.purity_class
        ORDER BY bp.purity_class
    `, [snapshot_id]);
    const purityDist = Object.fromEntries(
        (behaviorResult.rows as { purity_class: string; cnt: string }[])
            .map(r => [r.purity_class, parseInt(r.cnt, 10)])
    );

    // High-risk symbols: side_effecting with network or DB writes
    const riskyResult = await db.query(`
        SELECT s.canonical_name, s.kind, f.path, bp.purity_class,
               bp.network_calls, bp.db_writes, bp.file_io
        FROM behavioral_profiles bp
        JOIN symbol_versions sv ON sv.symbol_version_id = bp.symbol_version_id
        JOIN symbols s ON s.symbol_id = sv.symbol_id
        JOIN files f ON f.file_id = sv.file_id
        WHERE sv.snapshot_id = $1
        AND bp.purity_class IN ('side_effecting', 'read_write')
        AND (array_length(bp.network_calls, 1) > 0
             OR array_length(bp.db_writes, 1) > 0
             OR array_length(bp.file_io, 1) > 0)
        ORDER BY bp.purity_class DESC
        LIMIT 30
    `, [snapshot_id]);
    const riskySymbols = (riskyResult.rows as {
        canonical_name: string; kind: string; path: string;
        purity_class: string; network_calls: string[]; db_writes: string[]; file_io: string[];
    }[]).map(r => ({
        name: r.canonical_name,
        kind: r.kind,
        file: r.path,
        purity: r.purity_class,
        risks: [
            ...(r.network_calls || []).map((c: string) => `network:${c}`),
            ...(r.db_writes || []).map((c: string) => `db_write:${c}`),
            ...(r.file_io || []).map((c: string) => `file_io:${c}`),
        ],
    }));

    // 4. Test coverage
    const testResult = await db.query(`
        SELECT COUNT(DISTINCT ta.symbol_version_id) as tested
        FROM test_artifacts ta
        JOIN symbol_versions sv ON sv.symbol_version_id = ta.symbol_version_id
        WHERE sv.snapshot_id = $1
    `, [snapshot_id]);
    const testedCount = parseInt((testResult.rows[0] as { tested: string })?.tested || '0', 10);

    // 5. Uncertainty report
    const uncertainty = await uncertaintyTracker.getSnapshotUncertainty(snapshot_id);

    // 6. Key entry points — exported functions/classes at top-level
    const entryPoints = publicSymbols.slice(0, 30);

    return textResult({
        summary: {
            total_files: files.length,
            total_symbols: symbols.length,
            languages: langCounts,
            directories: Object.entries(dirCounts).sort((a, b) => b[1] - a[1]).slice(0, 20),
        },
        symbols: {
            by_kind: kindCounts,
            public_api_count: publicSymbols.length,
            entry_points: entryPoints,
        },
        behavioral_profile: {
            purity_distribution: purityDist,
            profiled_count: Object.values(purityDist).reduce((a, b) => a + b, 0),
            high_risk_symbols: riskySymbols,
        },
        test_coverage: {
            symbols_tested: testedCount,
            symbols_total: symbols.length,
            coverage_percent: symbols.length > 0 ? ((testedCount / symbols.length) * 100).toFixed(1) + '%' : '0%',
        },
        uncertainty: {
            overall_confidence: uncertainty.overall_confidence,
            total_annotations: uncertainty.total_annotations,
            by_source: uncertainty.by_source,
            most_uncertain: uncertainty.most_uncertain_symbols.slice(0, 10),
        },
    });
}

// ────────── Tool 26: Semantic Search ──────────
//
// Body-content semantic search using TF-IDF similarity.
// Unlike resolve_symbol (name-only pg_trgm), this searches INSIDE
// function bodies. "where does the code accumulate V×V matrices"
// returns relevant symbols ranked by body-view cosine similarity.

export async function handleSemanticSearch(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const query = args.query as string;
    const snapshot_id = args.snapshot_id as string;
    const limit = typeof args.limit === 'number' ? Math.min(Math.max(args.limit, 1), 50) : 15;
    const include_source = args.include_source !== false; // default true

    if (!query || typeof query !== 'string') return errorResult('query is required');
    if (query.length > 2000) return errorResult('query too long (max 2000 chars)');
    if (!isUUID(snapshot_id)) return errorResult('snapshot_id is required and must be a valid UUID');

    log.debug('scg_semantic_search', { query, snapshot_id, limit });

    // Step 1: Tokenize the query using the same body tokenizer
    const queryTokens = tokenizeBody(query);
    if (queryTokens.length === 0) return textResult({ matches: [], total: 0, note: 'Query produced no tokens' });

    // Step 2: Compute TF for query tokens
    const queryTF = computeTF(queryTokens);

    // Step 3: Load IDF for body view from this snapshot
    const idfResult = await db.query(
        `SELECT document_count, token_document_counts FROM idf_corpus
         WHERE snapshot_id = $1 AND view_type = 'body'`,
        [snapshot_id],
    );

    let queryIDF: Record<string, number> = {};
    if (idfResult.rows.length > 0) {
        const docCounts: Record<string, number> =
            typeof idfResult.rows[0].token_document_counts === 'string'
                ? JSON.parse(idfResult.rows[0].token_document_counts)
                : idfResult.rows[0].token_document_counts;
        const totalDocs = idfResult.rows[0].document_count as number;
        for (const [token, freq] of Object.entries(docCounts)) {
            queryIDF[token] = Math.log(1 + totalDocs / (1 + freq));
        }
        // Assign maximum IDF to out-of-vocabulary query tokens — these are
        // rare/unique terms that strongly discriminate when they DO match.
        const defaultIDF = Math.log(1 + totalDocs);
        for (const token of Object.keys(queryTF)) {
            if (!(token in queryIDF)) {
                queryIDF[token] = defaultIDF;
            }
        }
    }

    // Step 4: Compute query TF-IDF vector
    const queryVector = computeTFIDF(queryTF, queryIDF);

    // Step 5: Load all body-view sparse vectors for this snapshot
    const vectorsResult = await db.query(`
        SELECT sv2.symbol_version_id, sv2.sparse_vector
        FROM semantic_vectors sv2
        JOIN symbol_versions symv ON symv.symbol_version_id = sv2.symbol_version_id
        WHERE symv.snapshot_id = $1 AND sv2.view_type = 'body'
    `, [snapshot_id]);

    // Step 6: Score each symbol by cosine similarity with query
    const scores: { svId: string; similarity: number }[] = [];

    for (const row of vectorsResult.rows) {
        let svVec: SparseVector;
        try {
            svVec = typeof row.sparse_vector === 'string'
                ? JSON.parse(row.sparse_vector)
                : row.sparse_vector;
        } catch { continue; } // skip corrupt vectors

        const sim = cosineSimilarity(queryVector, svVec);
        if (sim > 0.01) { // filter noise
            scores.push({ svId: row.symbol_version_id as string, similarity: sim });
        }
    }

    // Step 7: Sort by similarity descending, take top results
    scores.sort((a, b) => b.similarity - a.similarity);
    const topResults = scores.slice(0, limit);

    if (topResults.length === 0) {
        return textResult({ matches: [], total: 0, note: 'No semantic matches found' });
    }

    // Step 8: Load symbol metadata (and optionally source) for top results
    const topIds = topResults.map(r => r.svId);
    const placeholders = topIds.map((_, i) => `$${i + 1}`).join(',');
    const metaResult = await db.query(`
        SELECT sv.symbol_version_id, s.canonical_name, s.kind, s.stable_key,
               sv.signature, sv.summary, sv.body_source,
               f.path as file_path, sv.range_start_line, sv.range_end_line
        FROM symbol_versions sv
        JOIN symbols s ON s.symbol_id = sv.symbol_id
        JOIN files f ON f.file_id = sv.file_id
        WHERE sv.symbol_version_id IN (${placeholders})
    `, topIds);

    const metaMap = new Map<string, Record<string, unknown>>();
    for (const row of metaResult.rows) {
        metaMap.set(row.symbol_version_id as string, row as Record<string, unknown>);
    }

    const matches = topResults.map(r => {
        const meta = metaMap.get(r.svId);
        if (!meta) return null;
        return {
            symbol_version_id: r.svId,
            canonical_name: meta.canonical_name,
            kind: meta.kind,
            file_path: meta.file_path,
            start_line: meta.range_start_line,
            end_line: meta.range_end_line,
            signature: meta.signature,
            similarity: parseFloat(r.similarity.toFixed(4)),
            ...(include_source && meta.body_source ? {
                source: meta.body_source,
                token_estimate: Math.ceil((meta.body_source as string).length / 4),
            } : {}),
        };
    }).filter(Boolean);

    return textResult({
        query,
        total: matches.length,
        matches,
    });
}

// ────────── Tool 27: Smart Context ──────────
//
// Task-oriented context bundles. Instead of the consumer making 8+ calls
// to gather context for a change task, this tool:
//   1. Takes a task description + target symbols + token budget
//   2. Computes blast radius for targets
//   3. Ranks all impacted symbols by relevance to the task
//   4. Bundles target source + impacted source + tests + homologs
//   5. Returns a single response with everything needed, token-budgeted
//
// This is the "give me everything I need for this change" tool.

export async function handleSmartContext(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const task_description = args.task_description as string;
    const target_symbol_version_ids = args.target_symbol_version_ids as string[];
    const snapshot_id = args.snapshot_id as string;
    const token_budget = typeof args.token_budget === 'number' ? Math.min(args.token_budget, 100_000) : 20_000;
    const depth = typeof args.depth === 'number' ? Math.min(Math.max(args.depth, 1), 5) : 2;

    if (!task_description || typeof task_description !== 'string') return errorResult('task_description is required');
    if (!Array.isArray(target_symbol_version_ids) || target_symbol_version_ids.length === 0) {
        return errorResult('target_symbol_version_ids is required (non-empty array of UUIDs)');
    }
    if (!isUUID(snapshot_id)) return errorResult('snapshot_id is required and must be a valid UUID');
    for (const id of target_symbol_version_ids) {
        if (!isUUID(id)) return errorResult(`Invalid UUID in target_symbol_version_ids: ${id}`);
    }

    log.debug('scg_smart_context', {
        task: task_description.slice(0, 100),
        targets: target_symbol_version_ids.length,
        budget: token_budget,
    });

    const CHARS_PER_TOKEN = 4;
    let usedTokens = 0;

    // Step 1: Load target symbols with source
    const targetPlaceholders = target_symbol_version_ids.map((_, i) => `$${i + 1}`).join(',');
    const targetsResult = await db.query(`
        SELECT sv.symbol_version_id, s.canonical_name, s.kind, sv.signature,
               sv.summary, sv.body_source, f.path as file_path,
               sv.range_start_line, sv.range_end_line
        FROM symbol_versions sv
        JOIN symbols s ON s.symbol_id = sv.symbol_id
        JOIN files f ON f.file_id = sv.file_id
        WHERE sv.symbol_version_id IN (${targetPlaceholders})
    `, target_symbol_version_ids);

    const targets = (targetsResult.rows as {
        symbol_version_id: string; canonical_name: string; kind: string;
        signature: string; summary: string; body_source: string | null;
        file_path: string; range_start_line: number; range_end_line: number;
    }[]).map(t => {
        const source = t.body_source ?? '[source unavailable]';
        const tokens = Math.ceil(source.length / CHARS_PER_TOKEN);
        usedTokens += tokens;
        return {
            symbol_version_id: t.symbol_version_id,
            canonical_name: t.canonical_name,
            kind: t.kind,
            signature: t.signature,
            file_path: t.file_path,
            start_line: t.range_start_line,
            end_line: t.range_end_line,
            source,
            token_estimate: tokens,
        };
    });

    // Step 2: Compute blast radius
    const blastReport = await blastRadiusEngine.computeBlastRadius(
        snapshot_id, target_symbol_version_ids, depth
    );

    // Step 3: Collect all unique impacted symbol_version_ids
    const allImpacts = [
        ...blastReport.structural_impacts,
        ...blastReport.behavioral_impacts,
        ...blastReport.contract_impacts,
        ...blastReport.homolog_impacts,
        ...blastReport.historical_impacts,
    ];

    // Deduplicate and rank by severity
    const severityRank: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
    const impactMap = new Map<string, typeof allImpacts[0]>();
    for (const impact of allImpacts) {
        const existing = impactMap.get(impact.symbol_id);
        if (!existing || (severityRank[impact.severity] || 0) > (severityRank[existing.severity] || 0)) {
            impactMap.set(impact.symbol_id, impact);
        }
    }

    // Sort by severity descending
    const rankedImpacts = Array.from(impactMap.values())
        .sort((a, b) => (severityRank[b.severity] || 0) - (severityRank[a.severity] || 0));

    // Step 4: Load source for impacted symbols, budgeted
    const contextSymbols: {
        symbol_name: string; kind: string; file_path: string | null;
        start_line: number | null; end_line: number | null;
        impact_type: string; severity: string; evidence: string;
        source: string | null; token_estimate: number;
    }[] = [];
    const omitted: string[] = [];

    // Batch-load impacted symbols that have source
    const impactSvIds: string[] = [];
    for (const impact of rankedImpacts) {
        // impact.symbol_id is actually symbol_id; we need symbol_version_id
        // The blast radius queries return symbol_id from the symbols table
        impactSvIds.push(impact.symbol_id);
    }

    // Load body_source for impacted symbols (by symbol_id, matching snapshot)
    let impactSourceMap = new Map<string, { body_source: string | null; canonical_name: string; kind: string; file_path: string; start_line: number; end_line: number }>();
    if (impactSvIds.length > 0) {
        const impPlaceholders = impactSvIds.map((_, i) => `$${i + 2}`).join(',');
        const impResult = await db.query(`
            SELECT sv.symbol_version_id, s.symbol_id, s.canonical_name, s.kind,
                   sv.body_source, f.path as file_path,
                   sv.range_start_line, sv.range_end_line
            FROM symbol_versions sv
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            JOIN files f ON f.file_id = sv.file_id
            WHERE sv.snapshot_id = $1 AND s.symbol_id IN (${impPlaceholders})
        `, [snapshot_id, ...impactSvIds]);

        for (const row of impResult.rows) {
            impactSourceMap.set(row.symbol_id as string, {
                body_source: row.body_source as string | null,
                canonical_name: row.canonical_name as string,
                kind: row.kind as string,
                file_path: row.file_path as string,
                start_line: row.range_start_line as number,
                end_line: row.range_end_line as number,
            });
        }
    }

    for (const impact of rankedImpacts) {
        const meta = impactSourceMap.get(impact.symbol_id);
        const source = (meta?.body_source as string | null | undefined) ?? null;
        const tokens = source ? Math.ceil(source.length / CHARS_PER_TOKEN) : 0;

        if (usedTokens + tokens > token_budget) {
            omitted.push(`${impact.symbol_name} (${impact.severity} ${impact.impact_type}) — budget exceeded`);
            continue;
        }

        contextSymbols.push({
            symbol_name: impact.symbol_name,
            kind: meta?.kind || 'unknown',
            file_path: impact.file_path,
            start_line: impact.start_line,
            end_line: impact.end_line,
            impact_type: impact.impact_type,
            severity: impact.severity,
            evidence: impact.evidence,
            source,
            token_estimate: tokens,
        });
        usedTokens += tokens;
    }

    return textResult({
        task: task_description,
        targets,
        blast_radius: {
            total_impacts: blastReport.total_impact_count,
            validation_scope: blastReport.recommended_validation_scope,
        },
        context: contextSymbols,
        omitted: omitted.length > 0 ? omitted : undefined,
        token_usage: {
            budget: token_budget,
            used: usedTokens,
            remaining: token_budget - usedTokens,
        },
    });
}
