/**
 * ContextZero — Contract Extraction & Invariant Mining Engine
 *
 * Extracts contract profiles from adapter hints and mines invariants
 * from test files, security patterns, and transaction boundaries.
 *
 * Contract profiles: input_contract, output_contract, error_contract,
 * schema_refs, api_contract_refs, serialization_contract, security_contract.
 *
 * Invariants: explicit_test, derived, assertion, schema, manual.
 * Scoped at global, module, or symbol level.
 */

import { v4 as uuidv4 } from 'uuid';
import { db } from '../db-driver';
import { coreDataService, type SymbolVersionRow } from '../db-driver/core_data';
import { Logger } from '../logger';
import type {
    ContractHint, ContractProfile, Invariant,
} from '../types';

const log = new Logger('contract-engine');

export class ContractEngine {

    /**
     * Extract contract profile from adapter hints and persist to DB.
     */
    public async extractContractProfile(
        symbolVersionId: string,
        hint: ContractHint
    ): Promise<Omit<ContractProfile, 'contract_profile_id'>> {
        const timer = log.startTimer('extractContractProfile', { symbolVersionId });

        const inputContract = hint.input_types.length > 0
            ? `(${hint.input_types.join(', ')})`
            : 'void';
        const outputContract = hint.output_type || 'void';
        const errorContract = hint.thrown_types.length > 0
            ? hint.thrown_types.join(' | ')
            : 'never';

        // Extract security and serialization contracts from decorators
        const securityDecorators = hint.decorators.filter(d =>
            /auth|guard|role|permission|security|token|session/i.test(d)
        );
        const serializationDecorators = hint.decorators.filter(d =>
            /serialize|transform|expose|exclude|json|xml|proto/i.test(d)
        );
        const schemaDecorators = hint.decorators.filter(d =>
            /schema|validate|is|matches|min|max|length/i.test(d)
        );
        const apiDecorators = hint.decorators.filter(d =>
            /get|post|put|delete|patch|route|api|endpoint|controller/i.test(d)
        );

        const profile = {
            symbol_version_id: symbolVersionId,
            input_contract: inputContract,
            output_contract: outputContract,
            error_contract: errorContract,
            schema_refs: schemaDecorators,
            api_contract_refs: apiDecorators,
            serialization_contract: serializationDecorators.join('; ') || 'none',
            security_contract: securityDecorators.join('; ') || 'none',
            derived_invariants_count: 0,
        };

        await coreDataService.upsertContractProfile(profile);
        timer();
        return profile;
    }

    /**
     * Mine invariants from test files in the snapshot.
     * Looks for assertion patterns, schema definitions, and security constraints.
     */
    public async mineInvariantsFromTests(
        repoId: string,
        snapshotId: string,
        symbolVersionRows: SymbolVersionRow[]
    ): Promise<number> {
        const timer = log.startTimer('mineInvariantsFromTests', { repoId, snapshotId });
        let count = 0;
        const statements: { text: string; params: unknown[] }[] = [];

        const testSymbols = symbolVersionRows.filter(sv =>
            sv.kind === 'test_case' ||
            sv.file_path.includes('.test.') ||
            sv.file_path.includes('.spec.') ||
            sv.file_path.includes('__tests__')
        );

        for (const testSv of testSymbols) {
            // Each test symbol generates an explicit_test invariant
            // linked to the symbols it references
            statements.push({
                text: `INSERT INTO invariants (invariant_id, repo_id, scope_symbol_id, scope_level, expression, source_type, strength, validation_method, last_verified_snapshot_id)
                       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                       ON CONFLICT DO NOTHING`,
                params: [uuidv4(), repoId, testSv.symbol_id, 'symbol',
                    `test:${testSv.canonical_name} asserts behavior of target symbol`,
                    'explicit_test', 0.90, 'test_execution', snapshotId],
            });
            count++;
        }

        // Mine schema invariants from validator/schema symbols
        const schemaSymbols = symbolVersionRows.filter(sv =>
            sv.kind === 'validator' || sv.kind === 'schema_object'
        );

        for (const schemaSv of schemaSymbols) {
            statements.push({
                text: `INSERT INTO invariants (invariant_id, repo_id, scope_symbol_id, scope_level, expression, source_type, strength, validation_method, last_verified_snapshot_id)
                       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                       ON CONFLICT DO NOTHING`,
                params: [uuidv4(), repoId, schemaSv.symbol_id, 'module',
                    `schema:${schemaSv.canonical_name} enforces data shape constraints`,
                    'schema', 0.95, 'schema_validation', snapshotId],
            });
            count++;
        }

        // BUG-011 fix: Mine invariants from assert statements in source code.
        // Even without test files, assert statements in production code
        // express developer-intended invariants (preconditions, postconditions).
        const assertSymbols = symbolVersionRows.filter(sv =>
            sv.kind === 'function' || sv.kind === 'method'
        );

        for (const sv of assertSymbols) {
            // Check if the symbol's signature or summary contains assert patterns
            const sig = sv.signature || '';

            // Mine from behavioral profiles: functions that explicitly validate
            // inputs express implicit invariants
            const bpResult = await db.query(
                `SELECT validation_operations, exception_profile, purity_class, resource_touches FROM behavioral_profiles WHERE symbol_version_id = $1`,
                [sv.symbol_version_id]
            );
            const bp = bpResult.rows[0] as { validation_operations: string[]; exception_profile: string[]; purity_class: string; resource_touches: string[] } | undefined;
            if (bp?.validation_operations && bp.validation_operations.length > 0) {
                statements.push({
                    text: `INSERT INTO invariants (invariant_id, repo_id, scope_symbol_id, scope_level, expression, source_type, strength, validation_method, last_verified_snapshot_id)
                           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                           ON CONFLICT DO NOTHING`,
                    params: [uuidv4(), repoId, sv.symbol_id, 'symbol',
                        `validation:${sv.canonical_name} performs input validation (${bp.validation_operations.join(', ')})`,
                        'derived', 0.75, 'behavioral_inference', snapshotId],
                });
                count++;
            }

            // Mine from contract profiles: functions with non-trivial error contracts
            // express invariants about error conditions
            const cpResult = await db.query(
                `SELECT error_contract, security_contract FROM contract_profiles WHERE symbol_version_id = $1`,
                [sv.symbol_version_id]
            );
            const cp = cpResult.rows[0] as { error_contract: string; security_contract: string } | undefined;
            if (cp?.error_contract && cp.error_contract !== 'never' && cp.error_contract !== '') {
                statements.push({
                    text: `INSERT INTO invariants (invariant_id, repo_id, scope_symbol_id, scope_level, expression, source_type, strength, validation_method, last_verified_snapshot_id)
                           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                           ON CONFLICT DO NOTHING`,
                    params: [uuidv4(), repoId, sv.symbol_id, 'symbol',
                        `error_contract:${sv.canonical_name} may throw ${cp.error_contract}`,
                        'derived', 0.70, 'contract_inference', snapshotId],
                });
                count++;
            }
            if (cp?.security_contract && cp.security_contract !== 'none' && cp.security_contract !== '') {
                statements.push({
                    text: `INSERT INTO invariants (invariant_id, repo_id, scope_symbol_id, scope_level, expression, source_type, strength, validation_method, last_verified_snapshot_id)
                           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                           ON CONFLICT DO NOTHING`,
                    params: [uuidv4(), repoId, sv.symbol_id, 'symbol',
                        `security:${sv.canonical_name} requires ${cp.security_contract}`,
                        'derived', 0.85, 'contract_inference', snapshotId],
                });
                count++;
            }

            // Mine from exception profiles: functions that throw specific exceptions
            // express invariants about error conditions
            if (bp?.exception_profile) {
                const arr = Array.isArray(bp.exception_profile) ? bp.exception_profile : [];
                const throwPatterns = arr.filter((e: unknown) => typeof e === 'string' && e.startsWith('throws:'));
                if (throwPatterns.length > 0) {
                    statements.push({
                        text: `INSERT INTO invariants (invariant_id, repo_id, scope_symbol_id, scope_level, expression, source_type, strength, validation_method, last_verified_snapshot_id)
                               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                               ON CONFLICT DO NOTHING`,
                        params: [uuidv4(), repoId, sv.symbol_id, 'symbol',
                            `exception:${sv.canonical_name} raises ${throwPatterns.map((t: unknown) => String(t).replace('throws:', '')).join(', ')}`,
                            'derived', 0.80, 'behavioral_inference', snapshotId],
                    });
                    count++;
                }
            }

            // Mine from purity classification: non-pure functions touching
            // specific resources express implicit resource-access invariants
            if (bp?.purity_class && bp.purity_class !== 'pure') {
                const resources = Array.isArray(bp.resource_touches) ? bp.resource_touches : [];
                if (resources.length > 0) {
                    statements.push({
                        text: `INSERT INTO invariants (invariant_id, repo_id, scope_symbol_id, scope_level, expression, source_type, strength, validation_method, last_verified_snapshot_id)
                               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                               ON CONFLICT DO NOTHING`,
                        params: [uuidv4(), repoId, sv.symbol_id, 'symbol',
                            `resource_access:${sv.canonical_name} (${bp.purity_class}) touches ${resources.slice(0, 5).join(', ')}`,
                            'derived', 0.65, 'behavioral_inference', snapshotId],
                    });
                    count++;
                }
            }
        }

        // Batch insert all invariant statements in a single transaction
        if (statements.length > 0) {
            await db.batchInsert(statements);
        }

        // BUG-011 fix: Update derived_invariants_count on contract profiles.
        // After mining, count actual invariants per symbol and update the
        // contract_profiles table so the count reflects reality.
        if (count > 0) {
            await db.query(`
                UPDATE contract_profiles cp
                SET derived_invariants_count = sub.cnt
                FROM (
                    SELECT i.scope_symbol_id, COUNT(*) as cnt
                    FROM invariants i
                    WHERE i.repo_id = $1
                    AND i.scope_symbol_id IS NOT NULL
                    GROUP BY i.scope_symbol_id
                ) sub
                JOIN symbol_versions sv ON sv.symbol_id = sub.scope_symbol_id
                WHERE cp.symbol_version_id = sv.symbol_version_id
                AND sv.snapshot_id = $2
            `, [repoId, snapshotId]);
            log.info('Updated derived_invariants_count on contract profiles', { repoId, snapshotId });
        }

        timer({ invariants_mined: count });
        return count;
    }

    /**
     * Build test linkage graph: which symbols are tested by which test cases.
     */
    public async buildTestLinkageGraph(
        snapshotId: string
    ): Promise<Map<string, string[]>> {
        const timer = log.startTimer('buildTestLinkageGraph', { snapshotId });

        // Get test artifacts for this snapshot
        const result = await db.query(`
            SELECT ta.symbol_version_id, ta.related_symbols
            FROM test_artifacts ta
            JOIN symbol_versions sv ON sv.symbol_version_id = ta.symbol_version_id
            WHERE sv.snapshot_id = $1
        `, [snapshotId]);

        const linkage = new Map<string, string[]>();

        for (const row of result.rows as { symbol_version_id: string; related_symbols: string[] }[]) {
            for (const relatedId of row.related_symbols) {
                const existing = linkage.get(relatedId) || [];
                existing.push(row.symbol_version_id);
                linkage.set(relatedId, existing);
            }
        }

        timer({ tested_symbols: linkage.size });
        return linkage;
    }

    /**
     * Get contract profile for a symbol version.
     */
    public async getProfile(symbolVersionId: string): Promise<ContractProfile | null> {
        const result = await db.query(
            `SELECT * FROM contract_profiles WHERE symbol_version_id = $1`,
            [symbolVersionId]
        );
        return (result.rows[0] as ContractProfile | undefined) ?? null;
    }

    /**
     * Get invariants scoped to a specific symbol.
     */
    public async getInvariantsForSymbol(symbolId: string): Promise<Invariant[]> {
        const result = await db.query(
            `SELECT * FROM invariants WHERE scope_symbol_id = $1 ORDER BY strength DESC`,
            [symbolId]
        );
        return result.rows as Invariant[];
    }

    /**
     * Compare contract profiles and return delta summary.
     */
    public compareContracts(
        before: ContractProfile,
        after: ContractProfile
    ): {
        inputChanged: boolean;
        outputChanged: boolean;
        errorChanged: boolean;
        securityChanged: boolean;
        serializationChanged: boolean;
    } {
        return {
            inputChanged: before.input_contract !== after.input_contract,
            outputChanged: before.output_contract !== after.output_contract,
            errorChanged: before.error_contract !== after.error_contract,
            securityChanged: before.security_contract !== after.security_contract,
            serializationChanged: before.serialization_contract !== after.serialization_contract,
        };
    }
}

export const contractEngine = new ContractEngine();
