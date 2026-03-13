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
