/**
 * ContextZero — Uncertainty Tracking Engine
 *
 * Tracks and quantifies uncertainty across all ContextZero analysis outputs.
 * Every layer surfaces what it does not know.
 *
 * 12 known uncertainty source types:
 * - parse_error, type_inference_failure, dynamic_dispatch
 * - reflection_usage, eval_usage, external_dependency
 * - incomplete_type_info, ambiguous_override, circular_reference
 * - untested_path, config_dependent, runtime_only_behavior
 */

import { db } from '../db-driver';
import type { UncertaintyAnnotation } from '../types';

export type UncertaintySource =
    | 'parse_error' | 'type_inference_failure' | 'dynamic_dispatch'
    | 'reflection_usage' | 'eval_usage' | 'external_dependency'
    | 'incomplete_type_info' | 'ambiguous_override' | 'circular_reference'
    | 'untested_path' | 'config_dependent' | 'runtime_only_behavior';

/** Confidence impact per source type (higher = more damaging) */
const SOURCE_IMPACT: Record<UncertaintySource, number> = {
    parse_error: 0.30,
    type_inference_failure: 0.15,
    dynamic_dispatch: 0.20,
    reflection_usage: 0.25,
    eval_usage: 0.35,
    external_dependency: 0.10,
    incomplete_type_info: 0.12,
    ambiguous_override: 0.18,
    circular_reference: 0.15,
    untested_path: 0.08,
    config_dependent: 0.10,
    runtime_only_behavior: 0.22,
};

export class UncertaintyTracker {

    public createAnnotation(
        source: UncertaintySource,
        affectedSymbolId: string | null,
        description: string
    ): UncertaintyAnnotation {
        return {
            source,
            affected_symbol_id: affectedSymbolId,
            description,
            confidence_impact: SOURCE_IMPACT[source],
            recommended_evidence: this.recommendEvidence(source),
        };
    }

    /**
     * Compute the overall confidence score for a snapshot.
     * Starts at 1.0 and deducts based on uncertainty annotations.
     * Floor is 0.10 — never report zero confidence.
     */
    public computeSnapshotConfidence(annotations: UncertaintyAnnotation[]): number {
        if (annotations.length === 0) return 1.0;

        let confidence = 1.0;
        const uniqueSources = new Set<string>();

        for (const ann of annotations) {
            if (uniqueSources.has(ann.source)) {
                confidence -= ann.confidence_impact * 0.3;
            } else {
                confidence -= ann.confidence_impact;
                uniqueSources.add(ann.source);
            }
        }

        return Math.max(0.10, Math.min(1.0, confidence));
    }

    /**
     * Compute per-symbol confidence based on that symbol's uncertainty flags.
     */
    public computeSymbolConfidence(uncertaintyFlags: string[]): number {
        if (uncertaintyFlags.length === 0) return 1.0;
        let confidence = 1.0;
        for (const flag of uncertaintyFlags) {
            const impact = SOURCE_IMPACT[flag as UncertaintySource];
            if (impact) {
                confidence -= impact;
            } else {
                confidence -= 0.05;
            }
        }
        return Math.max(0.10, Math.min(1.0, confidence));
    }

    /**
     * Get aggregated uncertainty report for a snapshot.
     */
    public async getSnapshotUncertainty(snapshotId: string): Promise<{
        total_annotations: number;
        by_source: Record<string, number>;
        most_uncertain_symbols: { symbol_version_id: string; flag_count: number }[];
        overall_confidence: number;
    }> {
        const result = await db.query(`
            SELECT symbol_version_id, uncertainty_flags
            FROM symbol_versions
            WHERE snapshot_id = $1 AND array_length(uncertainty_flags, 1) > 0
            ORDER BY array_length(uncertainty_flags, 1) DESC
        `, [snapshotId]);

        const bySource: Record<string, number> = {};
        let totalAnnotations = 0;
        const allAnnotations: UncertaintyAnnotation[] = [];
        const symbolUncertainties: { symbol_version_id: string; flag_count: number }[] = [];

        for (const row of result.rows as { symbol_version_id: string; uncertainty_flags: string[] }[]) {
            const flags = row.uncertainty_flags;
            symbolUncertainties.push({
                symbol_version_id: row.symbol_version_id,
                flag_count: flags.length,
            });
            for (const flag of flags) {
                bySource[flag] = (bySource[flag] || 0) + 1;
                totalAnnotations++;
                allAnnotations.push(this.createAnnotation(
                    flag as UncertaintySource,
                    row.symbol_version_id,
                    `Symbol has ${flag} uncertainty`
                ));
            }
        }

        // BUG-008 fix: Also detect structural indicators of uncertainty
        // that aren't captured by extraction flags. The behavioral profiler
        // uses heuristic pattern matching — flag this as inherent uncertainty.

        // Check: how many symbols have behavioral profiles vs total
        const totalSymbols = await db.query(
            `SELECT COUNT(*) as cnt FROM symbol_versions WHERE snapshot_id = $1`,
            [snapshotId]
        );
        const profiledSymbols = await db.query(
            `SELECT COUNT(*) as cnt FROM behavioral_profiles bp
             JOIN symbol_versions sv ON sv.symbol_version_id = bp.symbol_version_id
             WHERE sv.snapshot_id = $1`,
            [snapshotId]
        );
        const total = parseInt(totalSymbols.rows[0]?.cnt as string || '0', 10);
        const profiled = parseInt(profiledSymbols.rows[0]?.cnt as string || '0', 10);

        // If many symbols lack behavioral profiles, flag as uncertain
        if (total > 0 && profiled < total * 0.5) {
            const coverage = ((profiled / total) * 100).toFixed(0);
            bySource['incomplete_behavioral_coverage'] = total - profiled;
            totalAnnotations += 1;
            allAnnotations.push(this.createAnnotation(
                'untested_path' as UncertaintySource,
                null,
                `Only ${coverage}% of symbols have behavioral profiles (${profiled}/${total})`
            ));
        }

        // Check: are behavioral profiles using heuristic pattern matching?
        // (All current profiles are heuristic-based, so flag this if we have any)
        if (profiled > 0) {
            bySource['heuristic_behavioral_analysis'] = profiled;
            totalAnnotations += 1;
            allAnnotations.push({
                source: 'config_dependent',
                affected_symbol_id: null,
                description: `${profiled} behavioral profiles derived from heuristic pattern matching — purity classifications may be imprecise for framework-specific code`,
                confidence_impact: 0.05,
                recommended_evidence: 'Add framework-specific behavioral patterns or runtime trace data',
            });
        }

        // Check: are there symbols with no test coverage at all?
        const testedSymbols = await db.query(
            `SELECT COUNT(DISTINCT ta.symbol_version_id) as cnt
             FROM test_artifacts ta
             JOIN symbol_versions sv ON sv.symbol_version_id = ta.symbol_version_id
             WHERE sv.snapshot_id = $1`,
            [snapshotId]
        );
        const tested = parseInt(testedSymbols.rows[0]?.cnt as string || '0', 10);
        if (total > 0 && tested === 0) {
            bySource['no_test_coverage'] = total;
            totalAnnotations += 1;
            allAnnotations.push(this.createAnnotation(
                'untested_path' as UncertaintySource,
                null,
                `No test artifacts found — invariant mining and test-based validation are unavailable`
            ));
        }

        return {
            total_annotations: totalAnnotations,
            by_source: bySource,
            most_uncertain_symbols: symbolUncertainties.slice(0, 20),
            overall_confidence: this.computeSnapshotConfidence(allAnnotations),
        };
    }

    private recommendEvidence(source: UncertaintySource): string {
        switch (source) {
            case 'parse_error':
                return 'Fix syntax errors in source file and re-index';
            case 'type_inference_failure':
                return 'Add explicit type annotations to the symbol';
            case 'dynamic_dispatch':
                return 'Add runtime trace data or explicit interface annotations';
            case 'reflection_usage':
                return 'Document reflected types/fields manually or add test coverage';
            case 'eval_usage':
                return 'Replace eval with structured alternatives or document behavior';
            case 'external_dependency':
                return 'Pin dependency version and document its contract';
            case 'incomplete_type_info':
                return 'Install @types packages or add declaration files';
            case 'ambiguous_override':
                return 'Clarify inheritance hierarchy with explicit override markers';
            case 'circular_reference':
                return 'Refactor circular dependency or document the cycle';
            case 'untested_path':
                return 'Add test coverage for untested code paths';
            case 'config_dependent':
                return 'Document configuration dependencies and default values';
            case 'runtime_only_behavior':
                return 'Add integration tests or runtime trace data';
        }
    }
}

export const uncertaintyTracker = new UncertaintyTracker();
