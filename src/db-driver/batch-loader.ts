/**
 * ContextZero — Batch Query Layer
 *
 * Per-request/per-pass batch loader for efficient bulk DB queries.
 * Uses parameterized IN clauses to batch-load behavioral profiles,
 * contract profiles, and symbol versions.
 *
 * Instantiate per-request/per-pass (not singleton) to prevent stale data.
 * Includes an internal cache Map to avoid re-fetching within the same pass.
 *
 * Automatic chunking: splits large ID sets into chunks of CHUNK_SIZE
 * to stay within PostgreSQL's parameter limit (~32768).
 */

import { db } from './index';
import type { BehavioralProfile, ContractProfile } from '../types';
import type { SymbolVersionRow } from './core_data';
import { Logger } from '../logger';

const log = new Logger('batch-loader');

/** Max parameters per IN clause to stay within PostgreSQL limits */
const CHUNK_SIZE = 5000;

export class BatchLoader {
    /** Internal per-pass cache to avoid re-fetching within the same pass */
    private behavioralCache = new Map<string, BehavioralProfile>();
    private contractCache = new Map<string, ContractProfile>();
    private symbolVersionCache = new Map<string, SymbolVersionRow[]>();

    /** Allowed table/column combinations — prevents SQL injection */
    private static readonly ALLOWED_QUERIES: Record<string, string[]> = {
        'behavioral_profiles': ['symbol_version_id'],
        'contract_profiles': ['symbol_version_id'],
        'symbol_versions': ['symbol_version_id', 'symbol_id'],
    };

    /**
     * Execute a chunked IN query against a table keyed by symbol_version_id.
     * Splits large ID arrays into chunks of CHUNK_SIZE to stay within
     * PostgreSQL's parameter limit. Returns all matched rows merged.
     *
     * Table and column names are validated against an allowlist to prevent
     * SQL injection — they cannot be parameterized in PostgreSQL.
     */
    private async chunkedInQuery<T>(
        table: string,
        column: string,
        ids: string[]
    ): Promise<T[]> {
        if (ids.length === 0) return [];

        // Validate table/column against allowlist
        const allowedCols = BatchLoader.ALLOWED_QUERIES[table];
        if (!allowedCols || !allowedCols.includes(column)) {
            throw new Error(`BatchLoader: disallowed table/column: ${table}.${column}`);
        }

        const allRows: T[] = [];
        for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
            const chunk = ids.slice(i, i + CHUNK_SIZE);
            const placeholders = chunk.map((_, j) => `$${j + 1}`).join(',');
            const result = await db.query(
                `SELECT * FROM ${table} WHERE ${column} IN (${placeholders})`,
                chunk
            );
            allRows.push(...(result.rows as T[]));
        }
        return allRows;
    }

    /**
     * Batch-load behavioral profiles for multiple symbol version IDs.
     * Uses chunked parameterized IN clauses for efficient bulk loading.
     * Results are cached for the lifetime of this BatchLoader instance.
     */
    public async loadBehavioralProfiles(svIds: string[]): Promise<Map<string, BehavioralProfile>> {
        const result = new Map<string, BehavioralProfile>();
        const uncachedIds: string[] = [];

        // Return cached entries and identify uncached ones
        for (const id of svIds) {
            const cached = this.behavioralCache.get(id);
            if (cached) {
                result.set(id, cached);
            } else {
                uncachedIds.push(id);
            }
        }

        if (uncachedIds.length === 0) return result;

        const rows = await this.chunkedInQuery<BehavioralProfile>(
            'behavioral_profiles', 'symbol_version_id', uncachedIds
        );

        for (const row of rows) {
            result.set(row.symbol_version_id, row);
            this.behavioralCache.set(row.symbol_version_id, row);
        }

        log.debug('Batch loaded behavioral profiles', {
            requested: svIds.length,
            cached: svIds.length - uncachedIds.length,
            fetched: rows.length,
        });

        return result;
    }

    /**
     * Batch-load contract profiles for multiple symbol version IDs.
     * Uses chunked parameterized IN clauses for efficient bulk loading.
     * Results are cached for the lifetime of this BatchLoader instance.
     */
    public async loadContractProfiles(svIds: string[]): Promise<Map<string, ContractProfile>> {
        const result = new Map<string, ContractProfile>();
        const uncachedIds: string[] = [];

        // Return cached entries and identify uncached ones
        for (const id of svIds) {
            const cached = this.contractCache.get(id);
            if (cached) {
                result.set(id, cached);
            } else {
                uncachedIds.push(id);
            }
        }

        if (uncachedIds.length === 0) return result;

        const rows = await this.chunkedInQuery<ContractProfile>(
            'contract_profiles', 'symbol_version_id', uncachedIds
        );

        for (const row of rows) {
            result.set(row.symbol_version_id, row);
            this.contractCache.set(row.symbol_version_id, row);
        }

        log.debug('Batch loaded contract profiles', {
            requested: svIds.length,
            cached: svIds.length - uncachedIds.length,
            fetched: rows.length,
        });

        return result;
    }

    /**
     * Bulk-load all symbol versions for a given snapshot.
     * Uses the same query pattern as CoreDataService.getSymbolVersionsForSnapshot
     * but caches the result for re-use within the same pass.
     */
    public async loadSymbolVersionsBySnapshot(snapshotId: string): Promise<SymbolVersionRow[]> {
        const cached = this.symbolVersionCache.get(snapshotId);
        if (cached) return cached;

        const queryResult = await db.query(`
            SELECT sv.*, s.canonical_name, s.kind, s.stable_key, s.repo_id, f.path as file_path
            FROM symbol_versions sv
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            JOIN files f ON f.file_id = sv.file_id
            WHERE sv.snapshot_id = $1
        `, [snapshotId]);

        const rows = queryResult.rows as SymbolVersionRow[];
        this.symbolVersionCache.set(snapshotId, rows);

        log.debug('Batch loaded symbol versions for snapshot', {
            snapshotId,
            count: rows.length,
        });

        return rows;
    }
}
