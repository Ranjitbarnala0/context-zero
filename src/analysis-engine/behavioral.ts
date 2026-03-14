/**
 * ContextZero — Behavioral Fingerprint Engine
 *
 * Processes adapter behavior hints into structured behavioral profiles.
 * Every function is classified on a four-tier purity ladder:
 *   pure < read_only < read_write < side_effecting
 *
 * Classification:
 *   - Network or transaction operations → side_effecting
 *   - DB writes, state mutations, file I/O → read_write
 *   - Only reads (DB, cache, auth) → read_only
 *   - No I/O at all → pure
 */

import { db } from '../db-driver';
import { coreDataService } from '../db-driver/core_data';
import { Logger } from '../logger';
import type { BehaviorHint, BehavioralProfile, PurityClass } from '../types';

const log = new Logger('behavioral-engine');

export class BehavioralEngine {

    /**
     * Process raw behavior hints from adapter into structured profiles
     * and persist to DB.
     */
    public async extractBehavioralProfiles(
        symbolVersionId: string,
        hints: BehaviorHint[]
    ): Promise<Omit<BehavioralProfile, 'behavior_profile_id'>> {
        const timer = log.startTimer('extractBehavioralProfiles', {
            symbolVersionId,
            hintCount: hints.length,
        });

        const dbReads: string[] = [];
        const dbWrites: string[] = [];
        const networkCalls: string[] = [];
        const fileIo: string[] = [];
        const cacheOps: string[] = [];
        const authOps: string[] = [];
        const validationOps: string[] = [];
        const exceptions: string[] = [];
        const stateMutations: string[] = [];
        const transactions: string[] = [];
        const allResources: string[] = [];

        for (const hint of hints) {
            const detail = hint.detail;
            switch (hint.hint_type) {
                case 'db_read':
                    dbReads.push(detail);
                    allResources.push(`db:read:${detail}`);
                    break;
                case 'db_write':
                    dbWrites.push(detail);
                    allResources.push(`db:write:${detail}`);
                    break;
                case 'network_call':
                    networkCalls.push(detail);
                    allResources.push(`network:${detail}`);
                    break;
                case 'file_io':
                    fileIo.push(detail);
                    allResources.push(`file:${detail}`);
                    break;
                case 'cache_op':
                    cacheOps.push(detail);
                    allResources.push(`cache:${detail}`);
                    break;
                case 'auth_check':
                    authOps.push(detail);
                    allResources.push(`auth:${detail}`);
                    break;
                case 'validation':
                    validationOps.push(detail);
                    break;
                case 'throws':
                case 'catches':
                    exceptions.push(`${hint.hint_type}:${detail}`);
                    break;
                case 'state_mutation':
                    stateMutations.push(detail);
                    allResources.push(`state:${detail}`);
                    break;
                case 'transaction':
                    transactions.push(detail);
                    allResources.push(`txn:${detail}`);
                    break;
                case 'logging':
                    break;
            }
        }

        const purityClass = this.classifyPurity({
            hasNetworkCalls: networkCalls.length > 0,
            hasTransactions: transactions.length > 0,
            hasDbWrites: dbWrites.length > 0,
            hasStateMutations: stateMutations.length > 0,
            hasFileIo: fileIo.length > 0,
            hasCacheOps: cacheOps.length > 0,
            hasDbReads: dbReads.length > 0,
            hasAuthOps: authOps.length > 0,
        });

        const profile: Omit<BehavioralProfile, 'behavior_profile_id'> = {
            symbol_version_id: symbolVersionId,
            purity_class: purityClass,
            resource_touches: [...new Set(allResources)],
            db_reads: [...new Set(dbReads)],
            db_writes: [...new Set(dbWrites)],
            network_calls: [...new Set(networkCalls)],
            cache_ops: [...new Set(cacheOps)],
            file_io: [...new Set(fileIo)],
            auth_operations: [...new Set(authOps)],
            validation_operations: [...new Set(validationOps)],
            exception_profile: [...new Set(exceptions)],
            state_mutation_profile: [...new Set(stateMutations)],
            transaction_profile: [...new Set(transactions)],
        };

        await coreDataService.upsertBehavioralProfile(profile);
        timer({ purityClass });
        return profile;
    }

    /**
     * Classify purity based on observed resource access patterns.
     *
     * Purity ladder:
     *   pure → read_only → read_write → side_effecting
     *
     * Network/transaction → always side_effecting (external world mutation)
     * DB writes, state mutations, file I/O → read_write
     * Only DB reads, cache reads, auth checks → read_only
     * Nothing → pure
     */
    private classifyPurity(signals: {
        hasNetworkCalls: boolean;
        hasTransactions: boolean;
        hasDbWrites: boolean;
        hasStateMutations: boolean;
        hasFileIo: boolean;
        hasCacheOps: boolean;
        hasDbReads: boolean;
        hasAuthOps: boolean;
    }): PurityClass {
        // Tier 1: Network calls or transaction operations are always side_effecting
        if (signals.hasNetworkCalls || signals.hasTransactions) {
            return 'side_effecting';
        }

        // Tier 2: DB writes, state mutations, or file I/O → read_write
        if (signals.hasDbWrites || signals.hasStateMutations || signals.hasFileIo) {
            return 'read_write';
        }

        // Tier 3: Only reads (DB, cache, auth checks) → read_only
        if (signals.hasDbReads || signals.hasCacheOps || signals.hasAuthOps) {
            return 'read_only';
        }

        // Tier 4: No I/O at all → pure
        return 'pure';
    }

    /**
     * Get behavioral profile for a symbol version.
     */
    public async getProfile(symbolVersionId: string): Promise<BehavioralProfile | null> {
        const result = await db.query(
            `SELECT * FROM behavioral_profiles WHERE symbol_version_id = $1`,
            [symbolVersionId]
        );
        return result.rows[0] as BehavioralProfile ?? null;
    }

    /**
     * Propagate behavioral profiles transitively through the call graph.
     *
     * Problem: if main() calls train() and train() calls torch.save(),
     * pattern matching only sees torch.save() in train()'s body. main()
     * gets classified as "pure" even though it transitively does file I/O.
     *
     * Solution: walk the call graph bottom-up. For each caller, merge
     * the callee's profile into the caller's profile. Repeat until no
     * changes (fixed-point). This propagates side effects upward through
     * the entire call chain.
     */
    public async propagateTransitive(snapshotId: string): Promise<number> {
        const timer = log.startTimer('propagateTransitive', { snapshotId });

        const purityOrder: Record<PurityClass, number> = {
            pure: 0, read_only: 1, read_write: 2, side_effecting: 3,
        };

        // Load all behavioral profiles for this snapshot
        const profileResult = await db.query(`
            SELECT bp.*, sv.symbol_version_id as svid
            FROM behavioral_profiles bp
            JOIN symbol_versions sv ON sv.symbol_version_id = bp.symbol_version_id
            WHERE sv.snapshot_id = $1
        `, [snapshotId]);

        const profiles = new Map<string, {
            purity_class: PurityClass;
            resource_touches: string[];
            db_reads: string[];
            db_writes: string[];
            network_calls: string[];
            cache_ops: string[];
            file_io: string[];
            state_mutation_profile: string[];
            transaction_profile: string[];
        }>();

        for (const row of profileResult.rows as Record<string, unknown>[]) {
            profiles.set(row.symbol_version_id as string, {
                purity_class: row.purity_class as PurityClass,
                resource_touches: (row.resource_touches as string[]) || [],
                db_reads: (row.db_reads as string[]) || [],
                db_writes: (row.db_writes as string[]) || [],
                network_calls: (row.network_calls as string[]) || [],
                cache_ops: (row.cache_ops as string[]) || [],
                file_io: (row.file_io as string[]) || [],
                state_mutation_profile: (row.state_mutation_profile as string[]) || [],
                transaction_profile: (row.transaction_profile as string[]) || [],
            });
        }

        // Load call graph edges for this snapshot
        const callResult = await db.query(`
            SELECT sr.src_symbol_version_id, sr.dst_symbol_version_id
            FROM structural_relations sr
            JOIN symbol_versions sv ON sv.symbol_version_id = sr.src_symbol_version_id
            WHERE sv.snapshot_id = $1
            AND sr.relation_type = 'calls'
        `, [snapshotId]);

        // Build adjacency: caller → [callees]
        const callGraph = new Map<string, string[]>();
        for (const row of callResult.rows as { src_symbol_version_id: string; dst_symbol_version_id: string }[]) {
            const existing = callGraph.get(row.src_symbol_version_id) || [];
            existing.push(row.dst_symbol_version_id);
            callGraph.set(row.src_symbol_version_id, existing);
        }

        // Fixed-point iteration: propagate callee effects to callers
        // Max iterations = call graph depth (bounded to prevent infinite loops)
        let updated = 0;
        const MAX_ITERATIONS = 10;

        for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
            let changed = false;

            for (const [callerId, callees] of callGraph) {
                const callerProfile = profiles.get(callerId);
                if (!callerProfile) continue;

                const callerLevel = purityOrder[callerProfile.purity_class];

                for (const calleeId of callees) {
                    const calleeProfile = profiles.get(calleeId);
                    if (!calleeProfile) continue;

                    const calleeLevel = purityOrder[calleeProfile.purity_class];

                    // Escalate caller's purity if callee is less pure
                    if (calleeLevel > callerLevel) {
                        callerProfile.purity_class = calleeProfile.purity_class;
                        changed = true;
                    }

                    // Merge callee's resource touches into caller
                    const mergeUnique = (target: string[], source: string[]): boolean => {
                        let merged = false;
                        for (const item of source) {
                            if (!target.includes(item)) {
                                target.push(item);
                                merged = true;
                            }
                        }
                        return merged;
                    };

                    if (mergeUnique(callerProfile.resource_touches, calleeProfile.resource_touches)) changed = true;
                    if (mergeUnique(callerProfile.db_reads, calleeProfile.db_reads)) changed = true;
                    if (mergeUnique(callerProfile.db_writes, calleeProfile.db_writes)) changed = true;
                    if (mergeUnique(callerProfile.network_calls, calleeProfile.network_calls)) changed = true;
                    if (mergeUnique(callerProfile.file_io, calleeProfile.file_io)) changed = true;
                    if (mergeUnique(callerProfile.state_mutation_profile, calleeProfile.state_mutation_profile)) changed = true;
                    if (mergeUnique(callerProfile.transaction_profile, calleeProfile.transaction_profile)) changed = true;
                }
            }

            if (!changed) break;
        }

        // Persist updated profiles back to DB
        const statements: { text: string; params: unknown[] }[] = [];
        for (const [svId, profile] of profiles) {
            statements.push({
                text: `UPDATE behavioral_profiles SET
                    purity_class = $1,
                    resource_touches = $2,
                    db_reads = $3,
                    db_writes = $4,
                    network_calls = $5,
                    file_io = $6,
                    state_mutation_profile = $7,
                    transaction_profile = $8
                WHERE symbol_version_id = $9`,
                params: [
                    profile.purity_class,
                    profile.resource_touches,
                    profile.db_reads,
                    profile.db_writes,
                    profile.network_calls,
                    profile.file_io,
                    profile.state_mutation_profile,
                    profile.transaction_profile,
                    svId,
                ],
            });
            updated++;
        }

        if (statements.length > 0) {
            await db.batchInsert(statements);
        }

        timer({ profiles_propagated: updated });
        return updated;
    }

    /**
     * Compare two behavioral profiles for semantic equivalence.
     */
    public compareBehavior(
        before: BehavioralProfile,
        after: BehavioralProfile
    ): {
        purityChanged: boolean;
        purityDirection: 'escalated' | 'deescalated' | 'unchanged';
        newResourceTouches: string[];
        removedResourceTouches: string[];
        sideEffectsChanged: boolean;
    } {
        const purityOrder: Record<PurityClass, number> = {
            pure: 0, read_only: 1, read_write: 2, side_effecting: 3,
        };

        const beforeLevel = purityOrder[before.purity_class];
        const afterLevel = purityOrder[after.purity_class];

        const beforeResources = new Set(before.resource_touches);
        const afterResources = new Set(after.resource_touches);
        const newResources = after.resource_touches.filter(r => !beforeResources.has(r));
        const removedResources = before.resource_touches.filter(r => !afterResources.has(r));

        const sideEffectsChanged =
            before.network_calls.join(',') !== after.network_calls.join(',') ||
            before.db_writes.join(',') !== after.db_writes.join(',') ||
            before.file_io.join(',') !== after.file_io.join(',') ||
            before.transaction_profile.join(',') !== after.transaction_profile.join(',');

        return {
            purityChanged: beforeLevel !== afterLevel,
            purityDirection: afterLevel > beforeLevel ? 'escalated'
                : afterLevel < beforeLevel ? 'deescalated'
                : 'unchanged',
            newResourceTouches: newResources,
            removedResourceTouches: removedResources,
            sideEffectsChanged,
        };
    }
}

export const behavioralEngine = new BehavioralEngine();
