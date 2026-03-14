/**
 * ContextZero — MCP Stdio Bridge
 *
 * Entry point for the Model Context Protocol stdio transport.
 * Creates an MCP Server, registers all 22 ContextZero tools, and
 * connects via StdioServerTransport (JSON-RPC over stdin/stdout).
 *
 * All logging goes to stderr — stdout is reserved for the MCP protocol.
 *
 * Usage:
 *   node dist/mcp-bridge/index.js
 *
 * In Claude Desktop / Claude Code MCP config:
 *   { "command": "node", "args": ["dist/mcp-bridge/index.js"] }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
    handleResolveSymbol,
    handleGetSymbolDetails,
    handleGetSymbolRelations,
    handleGetBehavioralProfile,
    handleGetContractProfile,
    handleGetInvariants,
    handleGetUncertainty,
    handleFindHomologs,
    handleBlastRadius,
    handleCompileContextCapsule,
    handleCreateChangeTransaction,
    handleApplyPatch,
    handleValidateChange,
    handleCommitChange,
    handleRollbackChange,
    handlePropagationProposals,
    handleGetTransaction,
    handleIngestRepo,
    handleListRepos,
    handleListSnapshots,
    handleSnapshotStats,
    handlePersistHomologs,
} from './handlers';

// ────────── MCP-Safe Logger (stderr only) ──────────
//
// The standard Logger writes info/debug to stdout, which would corrupt
// the MCP JSON-RPC stream. This logger writes everything to stderr.

export interface McpLogger {
    debug(message: string, data?: Record<string, unknown>): void;
    info(message: string, data?: Record<string, unknown>): void;
    warn(message: string, data?: Record<string, unknown>): void;
    error(message: string, err?: unknown, data?: Record<string, unknown>): void;
}

function createMcpLogger(subsystem: string): McpLogger {
    const minLevel = (process.env['LOG_LEVEL'] || 'info') as string;
    const LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 };
    const minOrd = LEVELS[minLevel] ?? 1;

    function emit(level: string, message: string, data?: Record<string, unknown>, err?: unknown): void {
        if ((LEVELS[level] ?? 0) < minOrd) return;
        const entry: Record<string, unknown> = {
            timestamp: new Date().toISOString(),
            level,
            subsystem,
            message,
        };
        if (data && Object.keys(data).length > 0) entry.data = data;
        if (err instanceof Error) {
            entry.error = err.message;
            entry.stack = err.stack;
        } else if (err !== undefined) {
            entry.error = String(err);
        }
        process.stderr.write(JSON.stringify(entry) + '\n');
    }

    return {
        debug: (msg, data) => emit('debug', msg, data),
        info: (msg, data) => emit('info', msg, data),
        warn: (msg, data) => emit('warn', msg, data),
        error: (msg, err, data) => emit('error', msg, data, err),
    };
}

const log = createMcpLogger('mcp-bridge');

// ────────── MCP Result Type ──────────

interface McpTextContent {
    type: 'text';
    text: string;
}

interface McpCallToolResult {
    content: McpTextContent[];
    isError?: boolean;
    [key: string]: unknown;
}

// ────────── Safe Tool Execution Wrapper ──────────

type ToolHandler = (args: Record<string, unknown>, log: McpLogger) => Promise<McpCallToolResult>;

function safeTool(handler: ToolHandler): (args: Record<string, unknown>) => Promise<McpCallToolResult> {
    return async (args: Record<string, unknown>) => {
        try {
            return await handler(args, log);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            log.error('Tool execution failed', err);
            return {
                content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
                isError: true,
            };
        }
    };
}

// ────────── MCP Server Setup ──────────

const SERVER_NAME = 'contextzero';
const SERVER_VERSION = process.env['SCG_VERSION'] || '1.0.0';

const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
        capabilities: {
            tools: {},
        },
    },
);

// ────────── Tool Registration ──────────
//
// Each tool is registered with:
//   - name: matches the REST endpoint name (scg_*)
//   - description: what the tool does
//   - inputSchema: zod shape for argument validation
//   - callback: safeTool-wrapped handler from handlers.ts

// Tool 1: Resolve Symbol
server.registerTool(
    'scg_resolve_symbol',
    {
        description: 'Fuzzy symbol search — find symbols by name in a repository. Returns ranked matches with similarity scores.',
        inputSchema: {
            query: z.string().describe('Search query string (symbol name or partial name)'),
            repo_id: z.string().uuid().describe('Repository UUID'),
            snapshot_id: z.string().uuid().optional().describe('Optional snapshot UUID to scope the search'),
            kind_filter: z.string().optional().describe('Filter by symbol kind (function, class, method, etc.)'),
            limit: z.number().int().min(1).max(100).optional().describe('Max results to return (default 10, max 100)'),
        },
    },
    async (args) => safeTool(handleResolveSymbol)(args as unknown as Record<string, unknown>),
);

// Tool 2: Get Symbol Details
server.registerTool(
    'scg_get_symbol_details',
    {
        description: 'Get detailed information about a symbol version, including behavioral and contract profiles.',
        inputSchema: {
            symbol_version_id: z.string().uuid().describe('Symbol version UUID'),
            view_mode: z.enum(['code', 'summary', 'signature']).optional().describe('Detail level: code (full), summary (with profiles), or signature (minimal). Default: summary'),
        },
    },
    async (args) => safeTool(handleGetSymbolDetails)(args as unknown as Record<string, unknown>),
);

// Tool 3: Get Symbol Relations
server.registerTool(
    'scg_get_symbol_relations',
    {
        description: 'Get structural relations (calls, imports, inherits, etc.) for a symbol version.',
        inputSchema: {
            symbol_version_id: z.string().uuid().describe('Symbol version UUID'),
            direction: z.enum(['inbound', 'outbound', 'both']).optional().describe('Relation direction filter. Default: both'),
        },
    },
    async (args) => safeTool(handleGetSymbolRelations)(args as unknown as Record<string, unknown>),
);

// Tool 4: Get Behavioral Profile
server.registerTool(
    'scg_get_behavioral_profile',
    {
        description: 'Get the behavioral profile of a symbol — purity class, resource touches, DB ops, network calls, side effects.',
        inputSchema: {
            symbol_version_id: z.string().uuid().describe('Symbol version UUID'),
        },
    },
    async (args) => safeTool(handleGetBehavioralProfile)(args as unknown as Record<string, unknown>),
);

// Tool 5: Get Contract Profile
server.registerTool(
    'scg_get_contract_profile',
    {
        description: 'Get the contract profile of a symbol — input/output contracts, error contracts, schema refs, security contract.',
        inputSchema: {
            symbol_version_id: z.string().uuid().describe('Symbol version UUID'),
        },
    },
    async (args) => safeTool(handleGetContractProfile)(args as unknown as Record<string, unknown>),
);

// Tool 6: Get Invariants
server.registerTool(
    'scg_get_invariants',
    {
        description: 'Get invariants scoped to a symbol — explicit tests, derived constraints, assertions.',
        inputSchema: {
            symbol_id: z.string().uuid().describe('Symbol UUID (not symbol_version_id)'),
        },
    },
    async (args) => safeTool(handleGetInvariants)(args as unknown as Record<string, unknown>),
);

// Tool 7: Get Uncertainty Report
server.registerTool(
    'scg_get_uncertainty',
    {
        description: 'Get the uncertainty report for a snapshot — areas where analysis confidence is low or evidence is insufficient.',
        inputSchema: {
            snapshot_id: z.string().uuid().describe('Snapshot UUID'),
        },
    },
    async (args) => safeTool(handleGetUncertainty)(args as unknown as Record<string, unknown>),
);

// Tool 8: Find Homologs
server.registerTool(
    'scg_find_homologs',
    {
        description: 'Find homologous symbols — code clones, near-duplicates, validators with parallel logic, co-changed peers.',
        inputSchema: {
            symbol_version_id: z.string().uuid().describe('Source symbol version UUID to find homologs for'),
            snapshot_id: z.string().uuid().describe('Snapshot UUID defining the search scope'),
            confidence_threshold: z.number().min(0).max(1).optional().describe('Minimum confidence score (0-1). Default: 0.70'),
        },
    },
    async (args) => safeTool(handleFindHomologs)(args as unknown as Record<string, unknown>),
);

// Tool 9: Blast Radius
server.registerTool(
    'scg_blast_radius',
    {
        description: 'Compute blast radius — impact analysis showing structural, behavioral, contract, and homolog impacts of changing symbols.',
        inputSchema: {
            symbol_version_ids: z.array(z.string().uuid()).min(1).describe('Array of symbol version UUIDs to analyze impact for'),
            snapshot_id: z.string().uuid().describe('Snapshot UUID'),
            depth: z.number().int().min(1).max(5).optional().describe('Graph traversal depth (1-5). Default: 2'),
        },
    },
    async (args) => safeTool(handleBlastRadius)(args as unknown as Record<string, unknown>),
);

// Tool 10: Compile Context Capsule
server.registerTool(
    'scg_compile_context_capsule',
    {
        description: 'Compile a token-budgeted context capsule for a symbol — includes code, dependencies, callers, tests, contracts, and homologs, prioritized to fit within a token budget.',
        inputSchema: {
            symbol_version_id: z.string().uuid().describe('Target symbol version UUID'),
            snapshot_id: z.string().uuid().describe('Snapshot UUID'),
            mode: z.enum(['minimal', 'standard', 'strict']).optional().describe('Capsule compilation mode. Default: standard'),
            token_budget: z.number().int().min(100).max(100000).optional().describe('Maximum token budget (100-100000). Default: 8000'),
        },
    },
    async (args) => safeTool(handleCompileContextCapsule)(args as unknown as Record<string, unknown>),
);

// Tool 11: Create Change Transaction
server.registerTool(
    'scg_create_change_transaction',
    {
        description: 'Create a new change transaction — a tracked unit of work targeting specific symbols in a repository.',
        inputSchema: {
            repo_id: z.string().uuid().describe('Repository UUID'),
            base_snapshot_id: z.string().uuid().describe('Base snapshot UUID for the change'),
            created_by: z.string().optional().describe('Creator identifier. Default: mcp'),
            target_symbol_version_ids: z.array(z.string().uuid()).min(1).describe('Symbol version UUIDs being modified'),
            task_description: z.string().optional().describe('Human-readable description of the change task'),
        },
    },
    async (args) => safeTool(handleCreateChangeTransaction)(args as unknown as Record<string, unknown>),
);

// Tool 12: Apply Patch
server.registerTool(
    'scg_apply_patch',
    {
        description: 'Apply file patches to a change transaction — provides new file content for changed files.',
        inputSchema: {
            txn_id: z.string().uuid().describe('Transaction UUID'),
            patches: z.array(z.object({
                file_path: z.string().describe('Relative file path within the repository'),
                new_content: z.string().describe('Complete new content for the file'),
            })).min(1).describe('Array of file patches to apply'),
        },
    },
    async (args) => safeTool(handleApplyPatch)(args as unknown as Record<string, unknown>),
);

// Tool 13: Validate Change
server.registerTool(
    'scg_validate_change',
    {
        description: 'Run 6-level validation on a change transaction — syntax, semantic, contract, invariant, behavioral, and propagation checks.',
        inputSchema: {
            txn_id: z.string().uuid().describe('Transaction UUID'),
            mode: z.enum(['quick', 'standard', 'strict']).optional().describe('Validation thoroughness. Default: standard'),
        },
    },
    async (args) => safeTool(handleValidateChange)(args as unknown as Record<string, unknown>),
);

// Tool 14: Commit Change
server.registerTool(
    'scg_commit_change',
    {
        description: 'Commit a validated change transaction, finalizing all patches.',
        inputSchema: {
            txn_id: z.string().uuid().describe('Transaction UUID'),
        },
    },
    async (args) => safeTool(handleCommitChange)(args as unknown as Record<string, unknown>),
);

// Tool 15: Rollback Change
server.registerTool(
    'scg_rollback_change',
    {
        description: 'Rollback a change transaction, reverting all patches.',
        inputSchema: {
            txn_id: z.string().uuid().describe('Transaction UUID'),
        },
    },
    async (args) => safeTool(handleRollbackChange)(args as unknown as Record<string, unknown>),
);

// Tool 16: Propagation Proposals
server.registerTool(
    'scg_propagation_proposals',
    {
        description: 'Compute homolog co-change proposals — suggests changes to homologous symbols that may need parallel updates.',
        inputSchema: {
            txn_id: z.string().uuid().describe('Transaction UUID'),
            snapshot_id: z.string().uuid().describe('Snapshot UUID'),
        },
    },
    async (args) => safeTool(handlePropagationProposals)(args as unknown as Record<string, unknown>),
);

// Tool 17: Get Transaction
server.registerTool(
    'scg_get_transaction',
    {
        description: 'Get the current status and details of a change transaction.',
        inputSchema: {
            txn_id: z.string().uuid().describe('Transaction UUID'),
        },
    },
    async (args) => safeTool(handleGetTransaction)(args as unknown as Record<string, unknown>),
);

// Tool 18: Ingest Repository
server.registerTool(
    'scg_ingest_repo',
    {
        description: 'Ingest (index) a repository at a specific commit — parses all files, extracts symbols, relations, behavioral and contract hints.',
        inputSchema: {
            repo_id: z.string().uuid().describe('Repository UUID (must be registered first)'),
            commit_sha: z.string().describe('Git commit SHA to ingest'),
            branch: z.string().optional().describe('Branch name. Default: main'),
        },
    },
    async (args) => safeTool(handleIngestRepo)(args as unknown as Record<string, unknown>),
);

// Tool 19: List Repositories
server.registerTool(
    'scg_list_repos',
    {
        description: 'List registered repositories, ordered by most recently updated.',
        inputSchema: {
            limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20, max 100)'),
            offset: z.number().int().min(0).max(100000).optional().describe('Pagination offset (default 0)'),
        },
    },
    async (args) => safeTool(handleListRepos)(args as unknown as Record<string, unknown>),
);

// Tool 20: List Snapshots
server.registerTool(
    'scg_list_snapshots',
    {
        description: 'List snapshots for a repository, ordered by most recent.',
        inputSchema: {
            repo_id: z.string().uuid().describe('Repository UUID'),
            limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20, max 100)'),
            offset: z.number().int().min(0).max(100000).optional().describe('Pagination offset (default 0)'),
        },
    },
    async (args) => safeTool(handleListSnapshots)(args as unknown as Record<string, unknown>),
);

// Tool 21: Snapshot Stats
server.registerTool(
    'scg_snapshot_stats',
    {
        description: 'Get statistics for a snapshot — file count, symbol count, relation count, and uncertainty report.',
        inputSchema: {
            snapshot_id: z.string().uuid().describe('Snapshot UUID'),
        },
    },
    async (args) => safeTool(handleSnapshotStats)(args as unknown as Record<string, unknown>),
);

// Tool 22: Persist Homologs
server.registerTool(
    'scg_persist_homologs',
    {
        description: 'Discover and persist homolog relations for a symbol — runs homolog detection and saves results to the database.',
        inputSchema: {
            source_symbol_version_id: z.string().uuid().describe('Source symbol version UUID'),
            snapshot_id: z.string().uuid().describe('Snapshot UUID'),
            confidence_threshold: z.number().min(0).max(1).optional().describe('Minimum confidence threshold (0-1). Default: 0.70'),
        },
    },
    async (args) => safeTool(handlePersistHomologs)(args as unknown as Record<string, unknown>),
);

// ────────── Server Startup ──────────

async function main(): Promise<void> {
    log.info('Starting ContextZero MCP bridge', { version: SERVER_VERSION });

    const transport = new StdioServerTransport();

    // Handle transport-level errors
    transport.onerror = (error: Error) => {
        log.error('MCP transport error', error);
    };

    try {
        await server.connect(transport);
        log.info('MCP bridge connected and ready', {
            server: SERVER_NAME,
            version: SERVER_VERSION,
            tools_registered: 22,
        });
    } catch (err: unknown) {
        log.error('Failed to start MCP bridge', err);
        process.exit(1);
    }
}

// ────────── Graceful Shutdown ──────────

async function shutdown(signal: string): Promise<void> {
    log.info(`Received ${signal}, shutting down MCP bridge`);
    try {
        await server.close();
    } catch (err: unknown) {
        log.error('Error during MCP server close', err);
    }

    // Close DB connections
    try {
        const { db } = await import('../db-driver');
        await db.close();
    } catch {
        // DB may not have been initialized
    }

    log.info('MCP bridge shutdown complete');
    process.exit(0);
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });

// Prevent unhandled rejections from crashing the process
process.on('unhandledRejection', (reason: unknown) => {
    log.error('Unhandled promise rejection', reason instanceof Error ? reason : new Error(String(reason)));
});

process.on('uncaughtException', (err: Error) => {
    log.error('Uncaught exception', err);
    // For uncaught exceptions, exit after logging — the process state may be corrupted
    process.exit(1);
});

// Start the server
main().catch((err: unknown) => {
    log.error('Fatal error in main', err instanceof Error ? err : new Error(String(err)));
    process.exit(1);
});
