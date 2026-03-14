/**
 * ContextZero — Blast Radius Engine
 *
 * 5-dimensional impact analysis for code changes:
 *   1. Structural — callers, importers, type dependents
 *   2. Behavioral — purity changes, new side effects
 *   3. Contract — broken contracts, weakened invariants
 *   4. Homolog — parallel logic that may need co-change
 *   5. Historical — files/symbols that historically co-change
 *
 * All 5 dimensions are computed in parallel via Promise.all.
 */

import { db } from '../db-driver';
import { Logger } from '../logger';
import type {
    BlastRadiusReport, BlastRadiusImpact, ValidationMode,
} from '../types';

const log = new Logger('blast-radius');

export class BlastRadiusEngine {

    /**
     * Compute full 5-dimensional blast radius for a set of target symbols.
     */
    /** Hard ceiling on graph traversal depth — prevents runaway BFS regardless of caller */
    private static readonly MAX_INTERNAL_DEPTH = 5;

    public async computeBlastRadius(
        snapshotId: string,
        targetSymbolVersionIds: string[],
        depth: number = 2
    ): Promise<BlastRadiusReport> {
        // Enforce internal depth cap — defense in depth against unbounded traversal
        depth = Math.min(Math.max(1, depth), BlastRadiusEngine.MAX_INTERNAL_DEPTH);

        const timer = log.startTimer('computeBlastRadius', {
            snapshotId,
            targets: targetSymbolVersionIds.length,
            depth,
        });

        // Compute all 5 dimensions in parallel
        const [structural, behavioral, contract, homolog, historical] = await Promise.all([
            this.computeStructuralImpact(snapshotId, targetSymbolVersionIds, depth),
            this.computeBehavioralImpact(targetSymbolVersionIds),
            this.computeContractImpact(targetSymbolVersionIds),
            this.computeHomologImpact(snapshotId, targetSymbolVersionIds),
            this.computeHistoricalImpact(targetSymbolVersionIds),
        ]);

        const totalCount = structural.length + behavioral.length +
            contract.length + homolog.length + historical.length;

        const validationScope = this.recommendValidationScope(totalCount, structural, behavioral, contract);

        const report: BlastRadiusReport = {
            target_symbols: targetSymbolVersionIds,
            structural_impacts: structural,
            behavioral_impacts: behavioral,
            contract_impacts: contract,
            homolog_impacts: homolog,
            historical_impacts: historical,
            total_impact_count: totalCount,
            recommended_validation_scope: validationScope,
        };

        timer({ total_impacts: totalCount, validation_scope: validationScope });
        return report;
    }

    /**
     * Dimension 1: Structural impact — walk the call/reference/import graph.
     */
    private async computeStructuralImpact(
        snapshotId: string,
        targetIds: string[],
        depth: number
    ): Promise<BlastRadiusImpact[]> {
        const impacts: BlastRadiusImpact[] = [];
        const visited = new Set<string>(targetIds);
        let frontier = [...targetIds];

        for (let d = 0; d < depth && frontier.length > 0; d++) {
            const visitedArray = Array.from(visited);
            const placeholders = frontier.map((_, i) => `$${i + 1}`).join(',');
            const result = await db.query(`
                SELECT sr.src_symbol_version_id, sr.relation_type, sr.confidence,
                       s.canonical_name, sv.symbol_id,
                       f.path as file_path, sv.range_start_line, sv.range_end_line
                FROM structural_relations sr
                JOIN symbol_versions sv ON sv.symbol_version_id = sr.src_symbol_version_id
                JOIN symbols s ON s.symbol_id = sv.symbol_id
                JOIN files f ON f.file_id = sv.file_id
                WHERE sr.dst_symbol_version_id IN (${placeholders})
                AND sr.src_symbol_version_id != ALL($${frontier.length + 1}::uuid[])
            `, [...frontier, visitedArray]);

            const nextFrontier: string[] = [];

            for (const row of result.rows as {
                src_symbol_version_id: string;
                relation_type: string;
                confidence: number;
                canonical_name: string;
                symbol_id: string;
                file_path: string;
                range_start_line: number;
                range_end_line: number;
            }[]) {
                if (visited.has(row.src_symbol_version_id)) continue;
                visited.add(row.src_symbol_version_id);
                nextFrontier.push(row.src_symbol_version_id);

                impacts.push({
                    symbol_id: row.symbol_id,
                    symbol_name: row.canonical_name,
                    file_path: row.file_path,
                    start_line: row.range_start_line,
                    end_line: row.range_end_line,
                    impact_type: 'structural',
                    relation_type: row.relation_type,
                    confidence: row.confidence * (1 - d * 0.2),
                    severity: d === 0 ? 'high' : d === 1 ? 'medium' : 'low',
                    evidence: `${row.relation_type} at depth ${d + 1}`,
                    recommended_action: d === 0 ? 'rerun_test' : 'manual_review',
                });
            }

            frontier = nextFrontier;
        }

        return impacts;
    }

    /**
     * Dimension 2: Behavioral impact — detect purity escalation or new side effects.
     */
    private async computeBehavioralImpact(
        targetIds: string[]
    ): Promise<BlastRadiusImpact[]> {
        const impacts: BlastRadiusImpact[] = [];
        if (targetIds.length === 0) return impacts;

        const placeholders = targetIds.map((_, i) => `$${i + 1}`).join(',');

        // Get behavioral profiles of callers of target symbols
        const result = await db.query(`
            SELECT sr.src_symbol_version_id, s.canonical_name, sv.symbol_id,
                   f.path as file_path, sv.range_start_line, sv.range_end_line,
                   bp.purity_class, bp.network_calls, bp.db_writes
            FROM structural_relations sr
            JOIN symbol_versions sv ON sv.symbol_version_id = sr.src_symbol_version_id
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            JOIN files f ON f.file_id = sv.file_id
            LEFT JOIN behavioral_profiles bp ON bp.symbol_version_id = sr.src_symbol_version_id
            WHERE sr.dst_symbol_version_id IN (${placeholders})
            AND sr.relation_type IN ('calls', 'references')
        `, targetIds);

        for (const row of result.rows as {
            src_symbol_version_id: string;
            canonical_name: string;
            symbol_id: string;
            file_path: string;
            range_start_line: number;
            range_end_line: number;
            purity_class: string | null;
            network_calls: string[] | null;
            db_writes: string[] | null;
        }[]) {
            if (!row.purity_class) continue;

            // Callers with pure/read_only purity that call into changed code are at risk
            if (row.purity_class === 'pure' || row.purity_class === 'read_only') {
                impacts.push({
                    symbol_id: row.symbol_id,
                    symbol_name: row.canonical_name,
                    file_path: row.file_path,
                    start_line: row.range_start_line,
                    end_line: row.range_end_line,
                    impact_type: 'behavioral',
                    relation_type: 'purity_assumption',
                    confidence: 0.80,
                    severity: 'high',
                    evidence: `Caller has purity=${row.purity_class} but calls changed symbol`,
                    recommended_action: 'validate_contract',
                });
            }
        }

        return impacts;
    }

    /**
     * Dimension 3: Contract impact — find symbols whose contracts depend on targets.
     */
    private async computeContractImpact(
        targetIds: string[]
    ): Promise<BlastRadiusImpact[]> {
        const impacts: BlastRadiusImpact[] = [];
        if (targetIds.length === 0) return impacts;

        const placeholders = targetIds.map((_, i) => `$${i + 1}`).join(',');

        // Find invariants scoped to the target symbols.
        // The join path: target symbol_version_ids → symbol_versions → symbols → invariants.
        // We constrain sv to the exact target versions (not arbitrary versions of the same symbol).
        const result = await db.query(`
            SELECT i.invariant_id, i.expression, i.source_type, i.strength,
                   s.canonical_name, s.symbol_id,
                   f.path as file_path, sv.range_start_line, sv.range_end_line
            FROM symbol_versions sv
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            JOIN invariants i ON i.scope_symbol_id = s.symbol_id
            JOIN files f ON f.file_id = sv.file_id
            WHERE sv.symbol_version_id IN (${placeholders})
        `, targetIds);

        for (const row of result.rows as {
            invariant_id: string;
            expression: string;
            source_type: string;
            strength: number;
            canonical_name: string;
            symbol_id: string;
            file_path: string;
            range_start_line: number;
            range_end_line: number;
        }[]) {
            impacts.push({
                symbol_id: row.symbol_id,
                symbol_name: row.canonical_name,
                file_path: row.file_path,
                start_line: row.range_start_line,
                end_line: row.range_end_line,
                impact_type: 'contract',
                relation_type: `invariant:${row.source_type}`,
                confidence: row.strength,
                severity: row.strength >= 0.9 ? 'critical' : row.strength >= 0.7 ? 'high' : 'medium',
                evidence: `Invariant may be violated: ${row.expression}`,
                recommended_action: 'validate_contract',
            });
        }

        return impacts;
    }

    /**
     * Dimension 4: Homolog impact — parallel logic that may need co-change.
     */
    private async computeHomologImpact(
        snapshotId: string,
        targetIds: string[]
    ): Promise<BlastRadiusImpact[]> {
        const impacts: BlastRadiusImpact[] = [];
        if (targetIds.length === 0) return impacts;

        const placeholders = targetIds.map((_, i) => `$${i + 1}`).join(',');

        const result = await db.query(`
            SELECT ir.dst_symbol_version_id, ir.relation_type, ir.confidence,
                   s.canonical_name, sv.symbol_id,
                   f.path as file_path, sv.range_start_line, sv.range_end_line
            FROM inferred_relations ir
            JOIN symbol_versions sv ON sv.symbol_version_id = ir.dst_symbol_version_id
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            JOIN files f ON f.file_id = sv.file_id
            WHERE ir.src_symbol_version_id IN (${placeholders})
            AND ir.confidence >= 0.60
            AND ir.review_state != 'rejected'
            AND ir.valid_to_snapshot_id IS NULL
        `, targetIds);

        for (const row of result.rows as {
            dst_symbol_version_id: string;
            relation_type: string;
            confidence: number;
            canonical_name: string;
            symbol_id: string;
            file_path: string;
            range_start_line: number;
            range_end_line: number;
        }[]) {
            impacts.push({
                symbol_id: row.symbol_id,
                symbol_name: row.canonical_name,
                file_path: row.file_path,
                start_line: row.range_start_line,
                end_line: row.range_end_line,
                impact_type: 'homolog',
                relation_type: row.relation_type,
                confidence: row.confidence,
                severity: row.confidence >= 0.85 ? 'high' : 'medium',
                evidence: `Homolog relation (${row.relation_type}) — may need parallel change`,
                recommended_action: 'propagation',
            });
        }

        return impacts;
    }

    /**
     * Dimension 5: Historical co-change analysis.
     * Finds symbols that historically changed together with the targets.
     */
    private async computeHistoricalImpact(
        targetIds: string[]
    ): Promise<BlastRadiusImpact[]> {
        const impacts: BlastRadiusImpact[] = [];
        if (targetIds.length === 0) return impacts;

        // Historical co-change is derived from inferred_relations with type co_changed_with
        const placeholders = targetIds.map((_, i) => `$${i + 1}`).join(',');

        const result = await db.query(`
            SELECT ir.dst_symbol_version_id, ir.confidence,
                   s.canonical_name, sv.symbol_id,
                   f.path as file_path, sv.range_start_line, sv.range_end_line
            FROM inferred_relations ir
            JOIN symbol_versions sv ON sv.symbol_version_id = ir.dst_symbol_version_id
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            JOIN files f ON f.file_id = sv.file_id
            WHERE ir.src_symbol_version_id IN (${placeholders})
            AND ir.relation_type = 'co_changed_with'
            AND ir.confidence >= 0.50
            AND ir.valid_to_snapshot_id IS NULL
        `, targetIds);

        for (const row of result.rows as {
            dst_symbol_version_id: string;
            confidence: number;
            canonical_name: string;
            symbol_id: string;
            file_path: string;
            range_start_line: number;
            range_end_line: number;
        }[]) {
            impacts.push({
                symbol_id: row.symbol_id,
                symbol_name: row.canonical_name,
                file_path: row.file_path,
                start_line: row.range_start_line,
                end_line: row.range_end_line,
                impact_type: 'historical',
                relation_type: 'co_changed_with',
                confidence: row.confidence,
                severity: row.confidence >= 0.80 ? 'medium' : 'low',
                evidence: `Historically co-changed with target symbol`,
                recommended_action: 'manual_review',
            });
        }

        return impacts;
    }

    /**
     * Recommend validation scope based on blast radius severity.
     */
    private recommendValidationScope(
        totalCount: number,
        structural: BlastRadiusImpact[],
        behavioral: BlastRadiusImpact[],
        contract: BlastRadiusImpact[]
    ): ValidationMode {
        const hasCritical = [...structural, ...behavioral, ...contract]
            .some(i => i.severity === 'critical');
        const highCount = [...structural, ...behavioral, ...contract]
            .filter(i => i.severity === 'high').length;

        if (hasCritical || highCount >= 5 || totalCount >= 20) {
            return 'strict';
        }
        if (highCount >= 2 || totalCount >= 8) {
            return 'standard';
        }
        return 'quick';
    }
}

export const blastRadiusEngine = new BlastRadiusEngine();
