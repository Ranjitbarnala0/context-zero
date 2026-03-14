/**
 * ContextZero — API Interface (Express HTTP Server)
 *
 * API layer exposing all ContextZero tools as HTTP endpoints.
 *
 * Security:
 * - API key authentication (fail-closed)
 * - Per-route rate limiting
 * - validateBody() on EVERY route — zero ad-hoc validation
 * - No raw filesystem paths accepted from API requests
 * - Repository paths resolved from DB (registered via scg_register_repo)
 * - Allowed base paths enforced via SCG_ALLOWED_BASE_PATHS env var
 * - CORS with configurable origins
 * - Error responses sanitized — no stack traces, no internal paths
 * - Structured logging on all requests
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import express, { Request, Response, NextFunction } from 'express';
import { Logger } from '../logger';
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
import { authMiddleware } from '../middleware/auth';
import { rateLimitMiddleware } from '../middleware/rate-limiter';
import {
    validateBody,
    requireUUID, requireUUIDArray, requireString,
    optionalUUID, optionalString, optionalEnum, optionalConfidence,
    requireBoundedInt, requireAbsolutePath,
    requirePatchArray, requireSafePathArray,
    MAX_GRAPH_DEPTH, MAX_LIST_LIMIT, MAX_TOKEN_BUDGET,
} from '../middleware/validation';
import type { CapsuleMode, ValidationMode } from '../types';
import { renderMetrics, metricsMiddleware, setGauge } from '../metrics';
import { runPendingMigrations } from '../db-driver/migrate';

const log = new Logger('mcp-interface');
const app = express();

// ────────── Allowed Base Paths for Repository Registration ──────────
// Comma-separated list of absolute directory prefixes that repos can be registered under.
// If empty/unset, ALL paths are rejected (fail-closed).
const ALLOWED_BASE_PATHS: string[] = (process.env['SCG_ALLOWED_BASE_PATHS'] || '')
    .split(',')
    .map(p => p.trim())
    .filter(p => p.length > 0 && path.isAbsolute(p))
    .map(p => path.resolve(p));

function isPathAllowed(repoPath: string): boolean {
    if (ALLOWED_BASE_PATHS.length === 0) {
        log.warn('No SCG_ALLOWED_BASE_PATHS configured — rejecting all repository registrations');
        return false;
    }
    const resolved = path.resolve(repoPath);
    return ALLOWED_BASE_PATHS.some(
        base => resolved === base || resolved.startsWith(base + path.sep)
    );
}

// ────────── CORS Middleware ──────────

const CORS_ORIGINS = (process.env['SCG_CORS_ORIGINS'] || '').split(',').map(s => s.trim()).filter(Boolean);

app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && (CORS_ORIGINS.length > 0 && CORS_ORIGINS.includes(origin))) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
        res.setHeader('Access-Control-Max-Age', '86400');
    }
    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }
    next();
});

// ────────── Per-Route Body Size Tiers ──────────

const JSON_INGEST  = express.json({ limit: '10mb' });
const JSON_PATCH   = express.json({ limit: '5mb' });
const JSON_QUERY   = express.json({ limit: '100kb' });
const JSON_DEFAULT = express.json({ limit: '1mb' });

// ────────── Core Middleware ──────────
// NOTE: No global JSON parser here — body size limits are enforced per-route
// via JSON_INGEST, JSON_PATCH, JSON_QUERY, or JSON_DEFAULT as the first
// route middleware. A global parser would silently cap all routes at its limit.

// ────────── Security Headers ──────────
app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
});

app.use(authMiddleware);
app.use(rateLimitMiddleware);
app.use(metricsMiddleware);

// ────────── Request Correlation ID Middleware ──────────
// Extracts X-Request-ID from incoming request headers or generates a UUID.
// Stored on req.correlationId for use by downstream handlers and error responses.
app.use((req: Request, _res: Response, next: NextFunction) => {
    let correlationId = (req.headers['x-request-id'] as string) || crypto.randomUUID();
    // Cap length to prevent log bloat from malicious headers
    if (correlationId.length > 128) correlationId = correlationId.substring(0, 128);
    req.correlationId = correlationId;
    next();
});

// Request logging (includes correlation ID)
app.use((req: Request, _res: Response, next: NextFunction) => {
    log.info('Request', { method: req.method, path: req.path, ip: req.ip, correlationId: req.correlationId });
    next();
});

// ────────── Error Handler ──────────

/**
 * Classifies errors into user-facing (400-level) vs internal (500-level).
 * Only known, safe error classes expose their message to the client.
 * All others return a generic "Internal server error" to prevent information leakage.
 */
const SAFE_ERROR_PREFIXES = [
    'Transaction not found',
    'Invalid state transition',
    'applyPatch requires',
    'Cannot validate transaction',
    'Path traversal attempt blocked',
    'Repository base path not configured',
    'Repository not found',
    'Allowed base path violation',
    'File too large',
];

function isUserFacingError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    return SAFE_ERROR_PREFIXES.some(prefix => err.message.startsWith(prefix));
}

function safeHandler(
    handler: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response) => void {
    return (req: Request, res: Response) => {
        handler(req, res).catch((err: unknown) => {
            const correlationId = req.correlationId;
            log.error('Unhandled endpoint error', err, { path: req.path, correlationId });
            if (isUserFacingError(err)) {
                res.status(422).json({ error: (err as Error).message, correlationId });
            } else {
                res.status(500).json({ error: 'Internal server error', correlationId });
            }
        });
    };
}

/**
 * Resolves the repository base path from the DB for a given transaction.
 * Returns null if not configured, allowing the caller to respond with 400.
 */
async function resolveRepoBasePathForTxn(txnId: string): Promise<string | null> {
    const result = await db.query(
        `SELECT r.base_path FROM change_transactions ct
         JOIN repositories r ON r.repo_id = ct.repo_id
         WHERE ct.txn_id = $1`,
        [txnId]
    );
    return (result.rows[0]?.base_path as string) ?? null;
}

// ────────── Health & Readiness ──────────

app.get('/health', safeHandler(async (_req, res) => {
    const health = await db.healthCheck();
    const status = health.connected ? 200 : 503;

    // Version from package.json or env
    const version = process.env['SCG_VERSION'] || '1.0.0';

    // Cache stats summary
    const { symbolCache, profileCache, capsuleCache, homologCache, queryCache } = await import('../cache');
    const cacheStats = {
        symbol: symbolCache.stats(),
        profile: profileCache.stats(),
        capsule: capsuleCache.stats(),
        homolog: homologCache.stats(),
        query: queryCache.stats(),
    };

    res.status(status).json({
        status: health.connected ? 'healthy' : 'degraded',
        version,
        uptime_seconds: Math.floor(process.uptime()),
        db: health,
        pool: db.getPoolStats(),
        cache: cacheStats,
    });
}));

app.get('/ready', safeHandler(async (_req, res) => {
    const health = await db.healthCheck();

    // Migration currency check
    let migrationCount = 0;
    try {
        const migResult = await db.query('SELECT COUNT(*) as cnt FROM _migrations');
        migrationCount = parseInt(migResult.rows[0]?.cnt as string || '0', 10);
    } catch {
        // Table may not exist — treat as 0 migrations
        migrationCount = 0;
    }

    res.status(health.connected ? 200 : 503).json({
        ready: health.connected,
        migrations: migrationCount,
    });
}));

// ────────── Prometheus Metrics ──────────

app.get('/metrics', safeHandler(async (_req, res) => {
    // Update DB pool gauges before rendering
    const poolStats = db.getPoolStats();
    setGauge('scg_db_pool_total', poolStats.total);
    setGauge('scg_db_pool_idle', poolStats.idle);
    setGauge('scg_db_pool_waiting', poolStats.waiting);

    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(renderMetrics());
}));

// ────────── Tool 0: Register Repository (security-critical) ──────────

app.post('/scg_register_repo',
    JSON_DEFAULT,
    validateBody({
        repo_name: requireString,
        repo_path: requireAbsolutePath,
        default_branch: optionalString,
        visibility: optionalEnum('public', 'private'),
    }),
    safeHandler(async (req, res) => {
        const { repo_name, repo_path, default_branch, visibility } = req.body;

        // Enforce allowed base paths
        if (!isPathAllowed(repo_path)) {
            res.status(403).json({
                error: 'Allowed base path violation: repo_path is not under any configured SCG_ALLOWED_BASE_PATHS',
            });
            return;
        }

        // Verify path exists and is a directory
        const resolvedPath = path.resolve(repo_path);
        try {
            const stat = fs.statSync(resolvedPath);
            if (!stat.isDirectory()) {
                res.status(400).json({ error: 'repo_path must be a directory' });
                return;
            }
        } catch {
            res.status(400).json({ error: 'repo_path does not exist or is not accessible' });
            return;
        }

        // Create or reuse repository — deduplicate by base_path to prevent
        // orphaning data when a repo is re-registered after restart (BUG-001).
        const repoId = await coreDataService.createRepository({
            name: repo_name,
            default_branch: default_branch || 'main',
            visibility: visibility || 'private',
            language_set: [],
            base_path: resolvedPath,
        });

        log.info('Repository registered', { repo_id: repoId, name: repo_name, path: resolvedPath });
        res.json({ repo_id: repoId, registered_path: resolvedPath });
    })
);

// ────────── Tool 1: Resolve Symbol ──────────

app.post('/scg_resolve_symbol',
    JSON_QUERY,
    validateBody({
        query: requireString,
        repo_id: requireUUID,
        snapshot_id: optionalUUID,
        kind_filter: optionalString,
        limit: requireBoundedInt(1, MAX_LIST_LIMIT),
    }),
    safeHandler(async (req, res) => {
        const { query, repo_id, snapshot_id, kind_filter, limit = 10 } = req.body;

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
        res.json({ symbols: result.rows, count: result.rowCount });
    })
);

// ────────── Tool 2: Get Symbol Details ──────────

app.post('/scg_get_symbol_details',
    JSON_QUERY,
    validateBody({
        symbol_version_id: requireUUID,
        view_mode: optionalEnum('code', 'summary', 'signature'),
    }),
    safeHandler(async (req, res) => {
        const { symbol_version_id, view_mode = 'summary' } = req.body;

        const svResult = await db.query(`
            SELECT sv.*, s.canonical_name, s.kind, s.stable_key, s.repo_id,
                   f.path as file_path
            FROM symbol_versions sv
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            JOIN files f ON f.file_id = sv.file_id
            WHERE sv.symbol_version_id = $1
        `, [symbol_version_id]);

        if (svResult.rows.length === 0) {
            res.status(404).json({ error: 'Symbol version not found' });
            return;
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

        res.json(response);
    })
);

// ────────── Tool 3: Get Symbol Relations ──────────

app.post('/scg_get_symbol_relations',
    JSON_QUERY,
    validateBody({
        symbol_version_id: requireUUID,
        direction: optionalEnum('inbound', 'outbound', 'both'),
    }),
    safeHandler(async (req, res) => {
        const { symbol_version_id, direction = 'both' } = req.body;

        let relations;
        if (direction === 'inbound') {
            relations = await structuralGraphEngine.getCallers(symbol_version_id);
        } else if (direction === 'outbound') {
            relations = await structuralGraphEngine.getCallees(symbol_version_id);
        } else {
            relations = await structuralGraphEngine.getRelationsForSymbol(symbol_version_id);
        }

        res.json({ relations, count: relations.length });
    })
);

// ────────── Tool 4: Get Behavioral Profile ──────────

app.post('/scg_get_behavioral_profile',
    JSON_QUERY,
    validateBody({ symbol_version_id: requireUUID }),
    safeHandler(async (req, res) => {
        const profile = await behavioralEngine.getProfile(req.body.symbol_version_id);
        if (!profile) {
            res.status(404).json({ error: 'Behavioral profile not found' });
            return;
        }
        res.json({ profile });
    })
);

// ────────── Tool 5: Get Contract Profile ──────────

app.post('/scg_get_contract_profile',
    JSON_QUERY,
    validateBody({ symbol_version_id: requireUUID }),
    safeHandler(async (req, res) => {
        const profile = await contractEngine.getProfile(req.body.symbol_version_id);
        if (!profile) {
            res.status(404).json({ error: 'Contract profile not found' });
            return;
        }
        res.json({ profile });
    })
);

// ────────── Tool 6: Get Invariants ──────────

app.post('/scg_get_invariants',
    JSON_QUERY,
    validateBody({ symbol_id: requireUUID }),
    safeHandler(async (req, res) => {
        const invariants = await contractEngine.getInvariantsForSymbol(req.body.symbol_id);
        res.json({ invariants, count: invariants.length });
    })
);

// ────────── Tool 7: Find Homologs ──────────

app.post('/scg_find_homologs',
    JSON_QUERY,
    validateBody({
        symbol_version_id: requireUUID,
        snapshot_id: requireUUID,
        confidence_threshold: optionalConfidence,
    }),
    safeHandler(async (req, res) => {
        const { symbol_version_id, snapshot_id, confidence_threshold = 0.70 } = req.body;

        const homologs = await homologInferenceEngine.findHomologs(
            symbol_version_id, snapshot_id, confidence_threshold
        );

        res.json({ homologs, count: homologs.length });
    })
);

// ────────── Tool 8: Blast Radius ──────────

app.post('/scg_blast_radius',
    JSON_QUERY,
    validateBody({
        symbol_version_ids: requireUUIDArray,
        snapshot_id: requireUUID,
        depth: requireBoundedInt(1, MAX_GRAPH_DEPTH),
    }),
    safeHandler(async (req, res) => {
        const { symbol_version_ids, snapshot_id, depth = 2 } = req.body;

        const report = await blastRadiusEngine.computeBlastRadius(
            snapshot_id, symbol_version_ids, depth
        );

        res.json({ report });
    })
);

// ────────── Tool 9: Compile Context Capsule ──────────

app.post('/scg_compile_context_capsule',
    JSON_QUERY,
    validateBody({
        symbol_version_id: requireUUID,
        snapshot_id: requireUUID,
        mode: optionalEnum('minimal', 'standard', 'strict'),
        token_budget: requireBoundedInt(100, MAX_TOKEN_BUDGET),
    }),
    safeHandler(async (req, res) => {
        const { symbol_version_id, snapshot_id, mode = 'standard', token_budget } = req.body;

        // Resolve repo base path from DB — never from request body
        const basePathResult = await db.query(
            `SELECT r.base_path FROM repositories r
             JOIN symbols s ON s.repo_id = r.repo_id
             JOIN symbol_versions sv ON sv.symbol_id = s.symbol_id
             WHERE sv.symbol_version_id = $1`,
            [symbol_version_id]
        );
        const repoBasePath = basePathResult.rows[0]?.base_path as string | undefined;

        const capsule = await capsuleCompiler.compile(
            symbol_version_id, snapshot_id, mode as CapsuleMode, token_budget, repoBasePath
        );

        res.json({ capsule });
    })
);

// ────────── Tool 10: Get Uncertainty Report ──────────

app.post('/scg_get_uncertainty',
    JSON_QUERY,
    validateBody({ snapshot_id: requireUUID }),
    safeHandler(async (req, res) => {
        const report = await uncertaintyTracker.getSnapshotUncertainty(req.body.snapshot_id);
        res.json({ report });
    })
);

// ────────── Tool 11: Ingest Repository ──────────
// Requires prior registration via scg_register_repo.
// Accepts repo_id (not raw path) — path resolved from DB.

app.post('/scg_ingest_repo',
    JSON_INGEST,
    validateBody({
        repo_id: requireUUID,
        commit_sha: requireString,
        branch: optionalString,
    }),
    safeHandler(async (req, res) => {
        const { repo_id, commit_sha, branch = 'main' } = req.body;

        // Resolve repo path from DB — never from request body
        const repo = await coreDataService.getRepository(repo_id);
        if (!repo) {
            res.status(404).json({ error: 'Repository not found. Register it first via /scg_register_repo' });
            return;
        }

        const repoBasePath = repo.base_path as string | undefined;
        if (!repoBasePath) {
            res.status(400).json({
                error: 'Repository base path not configured. Register it first via /scg_register_repo',
            });
            return;
        }

        const repoName = repo.name as string;
        const result = await ingestor.ingestRepo(repoBasePath, repoName, commit_sha, branch);
        res.json({ result });
    })
);

// ────────── Tool 12: Create Change Transaction ──────────

app.post('/scg_create_change_transaction',
    JSON_DEFAULT,
    validateBody({
        repo_id: requireUUID,
        base_snapshot_id: requireUUID,
        created_by: optionalString,
        target_symbol_version_ids: requireUUIDArray,
        task_description: optionalString,
    }),
    safeHandler(async (req, res) => {
        const { repo_id, base_snapshot_id, created_by, target_symbol_version_ids, task_description } = req.body;

        const txnId = await transactionalChangeEngine.createTransaction(
            repo_id, base_snapshot_id, created_by || 'api',
            target_symbol_version_ids
        );

        if (task_description) {
            await db.query(`
                UPDATE change_transactions
                SET impact_report_ref = $1, updated_at = NOW()
                WHERE txn_id = $2
            `, [JSON.stringify({ task_description }), txnId]);
        }

        res.json({ txn_id: txnId, state: 'planned' });
    })
);

// ────────── Tool 13: Apply Patch ──────────

app.post('/scg_apply_patch',
    JSON_PATCH,
    validateBody({
        txn_id: requireUUID,
        patches: requirePatchArray,
    }),
    safeHandler(async (req, res) => {
        const { txn_id, patches } = req.body;

        const repoBasePath = await resolveRepoBasePathForTxn(txn_id);
        if (!repoBasePath) {
            res.status(400).json({ error: 'Repository base path not configured' });
            return;
        }

        await transactionalChangeEngine.applyPatch(txn_id, patches, repoBasePath);
        res.json({ txn_id, state: 'patched' });
    })
);

// ────────── Tool 14: Validate Change ──────────

app.post('/scg_validate_change',
    JSON_DEFAULT,
    validateBody({
        txn_id: requireUUID,
        mode: optionalEnum('quick', 'standard', 'strict'),
    }),
    safeHandler(async (req, res) => {
        const { txn_id, mode = 'standard' } = req.body;

        const repoBasePath = await resolveRepoBasePathForTxn(txn_id);
        if (!repoBasePath) {
            res.status(400).json({ error: 'Repository base path not configured' });
            return;
        }

        const report = await transactionalChangeEngine.validate(txn_id, repoBasePath, mode as ValidationMode);
        res.json({ report });
    })
);

// ────────── Tool 15: Commit Change ──────────

app.post('/scg_commit_change',
    JSON_DEFAULT,
    validateBody({ txn_id: requireUUID }),
    safeHandler(async (req, res) => {
        await transactionalChangeEngine.commit(req.body.txn_id);
        res.json({ txn_id: req.body.txn_id, state: 'committed' });
    })
);

// ────────── Tool 16: Rollback Change ──────────

app.post('/scg_rollback_change',
    JSON_DEFAULT,
    validateBody({ txn_id: requireUUID }),
    safeHandler(async (req, res) => {
        await transactionalChangeEngine.rollback(req.body.txn_id);
        res.json({ txn_id: req.body.txn_id, state: 'rolled_back' });
    })
);

// ────────── Tool 17: Get Transaction Status ──────────

app.post('/scg_get_transaction',
    JSON_QUERY,
    validateBody({ txn_id: requireUUID }),
    safeHandler(async (req, res) => {
        const txn = await transactionalChangeEngine.getTransaction(req.body.txn_id);
        if (!txn) {
            res.status(404).json({ error: 'Transaction not found' });
            return;
        }
        res.json({ transaction: txn });
    })
);

// ────────── Tool 18: Compute Propagation Proposals ──────────

app.post('/scg_propagation_proposals',
    JSON_QUERY,
    validateBody({
        txn_id: requireUUID,
        snapshot_id: requireUUID,
    }),
    safeHandler(async (req, res) => {
        const { txn_id, snapshot_id } = req.body;

        const proposals = await transactionalChangeEngine.computePropagationProposals(
            txn_id, snapshot_id
        );

        res.json({ proposals, count: proposals.length });
    })
);

// ────────── Tool 19: Incremental Index ──────────

app.post('/scg_incremental_index',
    JSON_DEFAULT,
    validateBody({
        repo_id: requireUUID,
        snapshot_id: requireUUID,
        changed_paths: requireSafePathArray(),
    }),
    safeHandler(async (req, res) => {
        const { repo_id, snapshot_id, changed_paths } = req.body;
        const result = await ingestor.ingestIncremental(repo_id, snapshot_id, changed_paths);
        res.json({ result });
    })
);

// ────────── Tool 20: Batch Embed Snapshot ──────────

app.post('/scg_batch_embed',
    JSON_INGEST,
    validateBody({ snapshot_id: requireUUID }),
    safeHandler(async (req, res) => {
        const { semanticEngine } = await import('../semantic-engine');
        const embedded = await semanticEngine.batchEmbedSnapshot(req.body.snapshot_id);
        res.json({ snapshot_id: req.body.snapshot_id, symbols_embedded: embedded });
    })
);

// ────────── Tool 21: Cache Stats ──────────

app.get('/scg_cache_stats', safeHandler(async (_req, res) => {
    const { symbolCache, profileCache, capsuleCache, homologCache, queryCache } = await import('../cache');
    res.json({
        symbol: symbolCache.stats(),
        profile: profileCache.stats(),
        capsule: capsuleCache.stats(),
        homolog: homologCache.stats(),
        query: queryCache.stats(),
    });
}));

// ────────── Utility: List Snapshots ──────────

app.post('/scg_list_snapshots',
    JSON_QUERY,
    validateBody({
        repo_id: requireUUID,
        limit: requireBoundedInt(1, MAX_LIST_LIMIT),
        offset: requireBoundedInt(0, 100_000),
    }),
    safeHandler(async (req, res) => {
        const { repo_id, limit = 20, offset = 0 } = req.body;

        const result = await db.query(`
            SELECT * FROM snapshots
            WHERE repo_id = $1
            ORDER BY indexed_at DESC
            LIMIT $2 OFFSET $3
        `, [repo_id, limit, offset]);

        res.json({ snapshots: result.rows, count: result.rowCount });
    })
);

// ────────── Utility: List Repositories ──────────

app.post('/scg_list_repos',
    JSON_QUERY,
    validateBody({
        limit: requireBoundedInt(1, MAX_LIST_LIMIT),
        offset: requireBoundedInt(0, 100_000),
    }),
    safeHandler(async (req, res) => {
        const { limit = 20, offset = 0 } = req.body;

        const result = await db.query(
            `SELECT * FROM repositories ORDER BY updated_at DESC LIMIT $1 OFFSET $2`,
            [limit, offset]
        );
        res.json({ repositories: result.rows, count: result.rowCount });
    })
);

// ────────── Utility: Get Snapshot Stats ──────────

app.post('/scg_snapshot_stats',
    JSON_QUERY,
    validateBody({ snapshot_id: requireUUID }),
    safeHandler(async (req, res) => {
        const { snapshot_id } = req.body;

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

        res.json({
            snapshot_id,
            files: parseInt(fileCount.rows[0]?.cnt as string || '0', 10),
            symbols: parseInt(symbolCount.rows[0]?.cnt as string || '0', 10),
            relations: parseInt(relationCount.rows[0]?.cnt as string || '0', 10),
            uncertainty: uncertaintyReport,
        });
    })
);

// ────────── Utility: Persist Homologs ──────────

app.post('/scg_persist_homologs',
    JSON_QUERY,
    validateBody({
        source_symbol_version_id: requireUUID,
        snapshot_id: requireUUID,
        confidence_threshold: optionalConfidence,
    }),
    safeHandler(async (req, res) => {
        const { source_symbol_version_id, snapshot_id, confidence_threshold = 0.70 } = req.body;

        const homologs = await homologInferenceEngine.findHomologs(
            source_symbol_version_id, snapshot_id, confidence_threshold
        );

        const persisted = await homologInferenceEngine.persistHomologs(
            source_symbol_version_id, homologs, snapshot_id
        );

        res.json({ homologs_found: homologs.length, persisted });
    })
);

// ────────── Tool 23: Read Source Code ──────────

app.post('/scg_read_source',
    JSON_QUERY,
    validateBody({
        repo_id: requireUUID,
        symbol_version_id: optionalUUID,
        file_path: optionalString,
        start_line: requireBoundedInt(1, 100_000),
        end_line: requireBoundedInt(1, 100_000),
        context_lines: requireBoundedInt(0, 50),
    }),
    safeHandler(async (req, res) => {
        const { repo_id, symbol_version_id, file_path: reqFilePath, start_line, end_line, context_lines = 0 } = req.body;

        if (!symbol_version_id && !reqFilePath) {
            res.status(400).json({ error: 'Either symbol_version_id or file_path is required' });
            return;
        }

        const repo = await coreDataService.getRepository(repo_id);
        if (!repo) { res.status(404).json({ error: 'Repository not found' }); return; }
        const basePath = repo.base_path as string;
        if (!basePath) { res.status(400).json({ error: 'Repository base path not configured' }); return; }

        let resolvedPath: string;
        let rangeStart = start_line as number | undefined;
        let rangeEnd = end_line as number | undefined;
        let symbolMeta: Record<string, unknown> | null = null;

        if (symbol_version_id) {
            const svResult = await db.query(`
                SELECT sv.range_start_line, sv.range_end_line, sv.signature, sv.summary,
                       s.canonical_name, s.kind, f.path as file_path
                FROM symbol_versions sv
                JOIN symbols s ON s.symbol_id = sv.symbol_id
                JOIN files f ON f.file_id = sv.file_id
                WHERE sv.symbol_version_id = $1
            `, [symbol_version_id]);
            if (svResult.rows.length === 0) { res.status(404).json({ error: 'Symbol version not found' }); return; }
            const sv = svResult.rows[0] as Record<string, unknown>;
            resolvedPath = path.resolve(basePath, sv.file_path as string);
            rangeStart = rangeStart ?? (sv.range_start_line as number) - context_lines;
            rangeEnd = rangeEnd ?? (sv.range_end_line as number) + context_lines;
            symbolMeta = { canonical_name: sv.canonical_name, kind: sv.kind, signature: sv.signature, summary: sv.summary, file_path: sv.file_path };
        } else {
            resolvedPath = path.resolve(basePath, reqFilePath);
        }

        const realBase = fs.realpathSync(basePath);
        if (!resolvedPath.startsWith(realBase + path.sep) && resolvedPath !== realBase) {
            res.status(403).json({ error: 'Path traversal blocked' }); return;
        }

        try {
            const content = fs.readFileSync(resolvedPath, 'utf-8');
            const lines = content.split('\n');
            let outputLines: string[];
            if (rangeStart && rangeEnd) {
                const s = Math.max(1, rangeStart);
                const e = Math.min(lines.length, rangeEnd);
                outputLines = lines.slice(s - 1, e).map((line, i) => `${s + i}: ${line}`);
            } else {
                const cap = Math.min(lines.length, 500);
                outputLines = lines.slice(0, cap).map((line, i) => `${i + 1}: ${line}`);
                if (lines.length > 500) outputLines.push(`... (${lines.length - 500} more lines truncated)`);
            }
            res.json({ ...(symbolMeta ? { symbol: symbolMeta } : {}), total_lines: lines.length, source: outputLines.join('\n') });
        } catch {
            res.status(404).json({ error: 'File not readable' });
        }
    })
);

// ────────── Tool 24: Search Code ──────────

app.post('/scg_search_code',
    JSON_QUERY,
    validateBody({
        repo_id: requireUUID,
        pattern: requireString,
        file_pattern: optionalString,
        max_results: requireBoundedInt(1, 100),
        context_lines: requireBoundedInt(0, 5),
    }),
    safeHandler(async (req, res) => {
        const { repo_id, pattern, file_pattern, max_results = 30, context_lines: ctxLines = 2 } = req.body;

        const repo = await coreDataService.getRepository(repo_id);
        if (!repo) { res.status(404).json({ error: 'Repository not found' }); return; }
        const basePath = repo.base_path as string;
        if (!basePath) { res.status(400).json({ error: 'Repository base path not configured' }); return; }

        const filesResult = await db.query(`
            SELECT DISTINCT f.path FROM files f
            JOIN snapshots snap ON snap.snapshot_id = f.snapshot_id
            WHERE snap.repo_id = $1 ORDER BY f.path
        `, [repo_id]);

        let regex: RegExp;
        try { regex = new RegExp(pattern, 'gi'); }
        catch { regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'); }

        const matches: { file: string; line: number; match: string; context: string }[] = [];
        const realBase = fs.realpathSync(basePath);

        for (const row of filesResult.rows as { path: string }[]) {
            if (matches.length >= max_results) break;
            if (file_pattern && !row.path.toLowerCase().includes(file_pattern.toLowerCase())) continue;

            const fullPath = path.resolve(basePath, row.path);
            if (!fullPath.startsWith(realBase + path.sep)) continue;

            try {
                const content = fs.readFileSync(fullPath, 'utf-8');
                const lines = content.split('\n');
                for (let i = 0; i < lines.length && matches.length < max_results; i++) {
                    regex.lastIndex = 0;
                    if (regex.test(lines[i]!)) {
                        const ctxStart = Math.max(0, i - ctxLines);
                        const ctxEnd = Math.min(lines.length - 1, i + ctxLines);
                        const contextArr: string[] = [];
                        for (let c = ctxStart; c <= ctxEnd; c++) {
                            contextArr.push(`${c === i ? '>' : ' '} ${c + 1}: ${lines[c]}`);
                        }
                        matches.push({ file: row.path, line: i + 1, match: (lines[i] ?? '').trim(), context: contextArr.join('\n') });
                    }
                }
            } catch { continue; }
        }

        res.json({ pattern, total_matches: matches.length, matches });
    })
);

// ────────── Tool 25: Codebase Overview ──────────

app.post('/scg_codebase_overview',
    JSON_QUERY,
    validateBody({
        repo_id: requireUUID,
        snapshot_id: requireUUID,
    }),
    safeHandler(async (req, res) => {
        const { repo_id, snapshot_id } = req.body;

        // File structure
        const filesResult = await db.query(`SELECT path, language FROM files WHERE snapshot_id = $1 ORDER BY path`, [snapshot_id]);
        const files = filesResult.rows as { path: string; language: string }[];
        const dirCounts: Record<string, number> = {};
        const langCounts: Record<string, number> = {};
        for (const f of files) {
            const dir = f.path.split('/').slice(0, -1).join('/') || '.';
            dirCounts[dir] = (dirCounts[dir] || 0) + 1;
            langCounts[f.language || 'unknown'] = (langCounts[f.language || 'unknown'] || 0) + 1;
        }

        // Symbols
        const symbolsResult = await db.query(`
            SELECT s.kind, sv.visibility, s.canonical_name, f.path as file_path
            FROM symbol_versions sv JOIN symbols s ON s.symbol_id = sv.symbol_id JOIN files f ON f.file_id = sv.file_id
            WHERE sv.snapshot_id = $1 ORDER BY s.kind, s.canonical_name
        `, [snapshot_id]);
        const symbols = symbolsResult.rows as { kind: string; visibility: string; canonical_name: string; file_path: string }[];
        const kindCounts: Record<string, number> = {};
        const publicSymbols: string[] = [];
        for (const s of symbols) {
            kindCounts[s.kind] = (kindCounts[s.kind] || 0) + 1;
            if (s.visibility === 'public') publicSymbols.push(`${s.kind}:${s.canonical_name} (${s.file_path})`);
        }

        // Behavioral profile
        const behaviorResult = await db.query(`
            SELECT bp.purity_class, COUNT(*) as cnt FROM behavioral_profiles bp
            JOIN symbol_versions sv ON sv.symbol_version_id = bp.symbol_version_id
            WHERE sv.snapshot_id = $1 GROUP BY bp.purity_class
        `, [snapshot_id]);
        const purityDist = Object.fromEntries(
            (behaviorResult.rows as { purity_class: string; cnt: string }[]).map(r => [r.purity_class, parseInt(r.cnt, 10)])
        );

        // High-risk symbols
        const riskyResult = await db.query(`
            SELECT s.canonical_name, s.kind, f.path, bp.purity_class, bp.network_calls, bp.db_writes, bp.file_io
            FROM behavioral_profiles bp JOIN symbol_versions sv ON sv.symbol_version_id = bp.symbol_version_id
            JOIN symbols s ON s.symbol_id = sv.symbol_id JOIN files f ON f.file_id = sv.file_id
            WHERE sv.snapshot_id = $1 AND bp.purity_class IN ('side_effecting','read_write')
            AND (array_length(bp.network_calls,1)>0 OR array_length(bp.db_writes,1)>0 OR array_length(bp.file_io,1)>0)
            LIMIT 30
        `, [snapshot_id]);

        // Test coverage
        const testResult = await db.query(`
            SELECT COUNT(DISTINCT ta.symbol_version_id) as tested FROM test_artifacts ta
            JOIN symbol_versions sv ON sv.symbol_version_id = ta.symbol_version_id WHERE sv.snapshot_id = $1
        `, [snapshot_id]);
        const testedCount = parseInt((testResult.rows[0] as { tested: string })?.tested || '0', 10);

        // Uncertainty
        const uncertainty = await uncertaintyTracker.getSnapshotUncertainty(snapshot_id);

        res.json({
            summary: { total_files: files.length, total_symbols: symbols.length, languages: langCounts,
                       directories: Object.entries(dirCounts).sort((a, b) => b[1] - a[1]).slice(0, 20) },
            symbols: { by_kind: kindCounts, public_api_count: publicSymbols.length, entry_points: publicSymbols.slice(0, 30) },
            behavioral_profile: { purity_distribution: purityDist, high_risk_symbols: (riskyResult.rows as Record<string, unknown>[]).map(r => ({
                name: r.canonical_name, kind: r.kind, file: r.path, purity: r.purity_class,
                risks: [...((r.network_calls as string[]) || []).map(c => `network:${c}`),
                        ...((r.db_writes as string[]) || []).map(c => `db_write:${c}`),
                        ...((r.file_io as string[]) || []).map(c => `file_io:${c}`)],
            })) },
            test_coverage: { symbols_tested: testedCount, symbols_total: symbols.length,
                           coverage_percent: symbols.length > 0 ? ((testedCount / symbols.length) * 100).toFixed(1) + '%' : '0%' },
            uncertainty: { overall_confidence: uncertainty.overall_confidence, total_annotations: uncertainty.total_annotations,
                         by_source: uncertainty.by_source, most_uncertain: uncertainty.most_uncertain_symbols.slice(0, 10) },
        });
    })
);

// ────────── Server Start ──────────

const PORT = parseInt(process.env['SCG_PORT'] || '3100', 10);
const HOST = process.env['SCG_HOST'] || '0.0.0.0';

let server: ReturnType<typeof app.listen>;

async function startServer(): Promise<void> {
    // Run pending migrations before accepting traffic
    try {
        await runPendingMigrations();
    } catch (err) {
        log.fatal('Migration failed — refusing to start', err instanceof Error ? err : new Error(String(err)));
        process.exit(1);
    }

    server = app.listen(PORT, HOST, () => {
        log.info('ContextZero API interface started', {
            host: HOST,
            port: PORT,
            allowed_base_paths: ALLOWED_BASE_PATHS.length > 0 ? ALLOWED_BASE_PATHS : ['NONE — repos will be rejected'],
            cors_origins: CORS_ORIGINS.length > 0 ? CORS_ORIGINS : ['NONE — all origins rejected'],
        });
    });
}

startServer().catch((err) => {
    log.fatal('Failed to start server', err instanceof Error ? err : new Error(String(err)));
    process.exit(1);
});

// Graceful shutdown
function shutdown(signal: string): void {
    log.info(`Received ${signal}, shutting down gracefully`);
    if (!server) {
        process.exit(0);
        return;
    }
    server.close(async () => {
        await db.close();
        log.info('Server closed');
        process.exit(0);
    });
    // Force kill after 10s
    setTimeout(() => {
        log.fatal('Forced shutdown after timeout');
        process.exit(1);
    }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Global error boundaries — prevent silent crashes
process.on('uncaughtException', (err: Error) => {
    log.fatal('Uncaught exception — process will exit', err);
    process.exit(1);
});
process.on('unhandledRejection', (reason: unknown) => {
    log.error('Unhandled promise rejection', reason instanceof Error ? reason : new Error(String(reason)));
});

export { app };
