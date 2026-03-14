/**
 * ContextZero — Homolog Inference Engine
 *
 * Multi-evidence, weighted scoring model for detecting parallel code logic.
 * 7-dimension weighted scoring with contradiction detection.
 *
 * Dimensions:
 *   1. Semantic intent similarity     — 0.20
 *   2. Normalized logic similarity    — 0.20
 *   3. Signature/type similarity      — 0.15
 *   4. Behavioral overlap             — 0.15
 *   5. Contract overlap               — 0.15
 *   6. Test overlap                   — 0.10
 *   7. History co-change              — 0.05
 *
 * Candidate generation uses 5 buckets:
 *   - body_hash exact match
 *   - ast_hash exact match
 *   - Name similarity (pg_trgm)
 *   - Behavioral profile overlap
 *   - Contract profile overlap
 *
 * Minimum 2 evidence families required. Confidence threshold: 0.70.
 *
 * Contradiction detection flags:
 *   - side_effects_differ
 *   - exception_semantics_differ
 *   - security_context_differs
 *   - io_shape_diverges
 */

import { db } from '../db-driver';
import { BatchLoader } from '../db-driver/batch-loader';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../logger';
import { semanticEngine } from '../semantic-engine';
import { profileCache } from '../cache';
import type { PoolClient } from 'pg';
import type {
    HomologCandidate, EvidenceScores, InferredRelationType,
    BehavioralProfile, ContractProfile,
} from '../types';
import {
    HOMOLOG_WEIGHTS, MIN_EVIDENCE_FAMILIES,
    DEFAULT_HOMOLOG_CONFIDENCE_THRESHOLD,
} from '../types';

const log = new Logger('homolog-engine');

interface CandidateRow {
    symbol_version_id: string;
    symbol_id: string;
    canonical_name: string;
    stable_key: string;
    body_hash: string;
    ast_hash: string;
    normalized_ast_hash: string | null;
    signature: string;
    kind: string;
}

export class HomologInferenceEngine {

    /**
     * Find homologs for a given symbol version within the snapshot.
     */
    public async findHomologs(
        targetSymbolVersionId: string,
        snapshotId: string,
        confidenceThreshold: number = DEFAULT_HOMOLOG_CONFIDENCE_THRESHOLD
    ): Promise<HomologCandidate[]> {
        const timer = log.startTimer('findHomologs', {
            targetSymbolVersionId, snapshotId, confidenceThreshold,
        });

        // Load target symbol data
        const target = await this.loadSymbolData(targetSymbolVersionId);
        if (!target) {
            timer({ result: 'target_not_found' });
            return [];
        }

        // Generate candidates from 5 buckets
        const candidates = await this.generateCandidates(target, snapshotId);

        if (candidates.length === 0) {
            timer({ result: 'no_candidates' });
            return [];
        }

        // Pre-load ALL behavioral and contract profiles for target + candidates
        // in 2 bulk queries. This pre-warms profileCache so that all subsequent
        // calls to loadBehavioralProfile/loadContractProfile hit cache instead of DB.
        const allSvIds = [target.symbol_version_id, ...candidates.map(c => c.symbol_version_id)];
        const loader = new BatchLoader();
        const [allBehavioral, allContracts] = await Promise.all([
            loader.loadBehavioralProfiles(allSvIds),
            loader.loadContractProfiles(allSvIds),
        ]);
        for (const [svId, bp] of allBehavioral) {
            profileCache.set(`bp:${svId}`, bp);
        }
        for (const [svId, cp] of allContracts) {
            profileCache.set(`cp:${svId}`, cp);
        }

        // Score each candidate across 7 dimensions
        const scored: HomologCandidate[] = [];

        for (const candidate of candidates) {
            if (candidate.symbol_version_id === targetSymbolVersionId) continue;

            const evidence = await this.scoreCandidate(target, candidate, snapshotId);

            // Check minimum evidence families
            if (evidence.evidence_family_count < MIN_EVIDENCE_FAMILIES) continue;
            if (evidence.weighted_total < confidenceThreshold) continue;

            // Detect contradictions
            const contradictions = await this.detectContradictions(target, candidate);

            // Classify relation type
            const relationType = await this.classifyRelationType(target, candidate, evidence);

            scored.push({
                symbol_id: candidate.symbol_id,
                symbol_version_id: candidate.symbol_version_id,
                symbol_name: candidate.canonical_name,
                relation_type: relationType,
                confidence: evidence.weighted_total,
                evidence,
                contradiction_flags: contradictions,
            });
        }

        // Sort by confidence descending
        scored.sort((a, b) => b.confidence - a.confidence);

        timer({ candidates_generated: candidates.length, homologs_found: scored.length });
        return scored;
    }

    /**
     * Persist discovered homolog relations to the database.
     */
    public async persistHomologs(
        sourceSymbolVersionId: string,
        homologs: HomologCandidate[],
        snapshotId: string
    ): Promise<number> {
        if (homologs.length === 0) return 0;

        // Single transaction for all homologs — atomic batch persistence
        await db.transaction(async (client: PoolClient) => {
            for (const hom of homologs) {
                const bundleId = uuidv4();

                // Create evidence bundle
                await db.queryWithClient(client, `
                    INSERT INTO evidence_bundles (
                        evidence_bundle_id, semantic_score, structural_score,
                        behavioral_score, contract_score, test_score, history_score,
                        contradiction_flags, feature_payload
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                `, [
                    bundleId,
                    hom.evidence.semantic_intent_similarity,
                    hom.evidence.normalized_logic_similarity,
                    hom.evidence.behavioral_overlap,
                    hom.evidence.contract_overlap,
                    hom.evidence.test_overlap,
                    hom.evidence.history_co_change,
                    hom.contradiction_flags,
                    JSON.stringify(hom.evidence),
                ]);

                // Create inferred relation
                const relationId = uuidv4();
                await db.queryWithClient(client, `
                    INSERT INTO inferred_relations (
                        inferred_relation_id, src_symbol_version_id, dst_symbol_version_id,
                        relation_type, confidence, review_state,
                        evidence_bundle_id, valid_from_snapshot_id
                    ) VALUES ($1, $2, $3, $4, $5, 'unreviewed', $6, $7)
                    ON CONFLICT (src_symbol_version_id, dst_symbol_version_id, relation_type, valid_from_snapshot_id)
                    DO UPDATE SET confidence = GREATEST(inferred_relations.confidence, EXCLUDED.confidence)
                `, [
                    relationId, sourceSymbolVersionId, hom.symbol_version_id,
                    hom.relation_type, hom.confidence,
                    bundleId, snapshotId,
                ]);
            }
        });

        return homologs.length;
    }

    /**
     * Generate candidates from 5 buckets.
     */
    private async generateCandidates(
        target: CandidateRow,
        snapshotId: string
    ): Promise<CandidateRow[]> {
        const candidateMap = new Map<string, CandidateRow>();

        const addRows = (rows: CandidateRow[]) => {
            for (const row of rows) candidateMap.set(row.symbol_version_id, row);
        };

        const SV_COLS = `sv.symbol_version_id, sv.symbol_id, s.canonical_name,
                   s.stable_key, sv.body_hash, sv.ast_hash, sv.normalized_ast_hash, sv.signature, s.kind`;

        // Buckets 1-4, 6-7 are independent DB queries — run in parallel
        const [bodyMatches, astMatches, normalizedMatches, nameMatches, behaviorMatches, kindMatches] =
            await Promise.all([
                // Bucket 1: body_hash exact match
                db.query(`
                    SELECT ${SV_COLS}
                    FROM symbol_versions sv
                    JOIN symbols s ON s.symbol_id = sv.symbol_id
                    WHERE sv.snapshot_id = $1 AND sv.body_hash = $2
                    AND sv.symbol_version_id != $3
                    LIMIT 50
                `, [snapshotId, target.body_hash, target.symbol_version_id]),

                // Bucket 2: ast_hash exact match
                db.query(`
                    SELECT ${SV_COLS}
                    FROM symbol_versions sv
                    JOIN symbols s ON s.symbol_id = sv.symbol_id
                    WHERE sv.snapshot_id = $1 AND sv.ast_hash = $2
                    AND sv.symbol_version_id != $3
                    LIMIT 50
                `, [snapshotId, target.ast_hash, target.symbol_version_id]),

                // Bucket 3: normalized_ast_hash (no-op if null)
                target.normalized_ast_hash
                    ? db.query(`
                        SELECT ${SV_COLS}
                        FROM symbol_versions sv
                        JOIN symbols s ON s.symbol_id = sv.symbol_id
                        WHERE sv.snapshot_id = $1 AND sv.normalized_ast_hash = $2
                        AND sv.symbol_version_id != $3
                        LIMIT 50
                    `, [snapshotId, target.normalized_ast_hash, target.symbol_version_id])
                    : Promise.resolve({ rows: [] as unknown[], rowCount: 0, command: '', oid: 0, fields: [] }),

                // Bucket 4: Name similarity via pg_trgm
                db.query(`
                    SELECT ${SV_COLS},
                           similarity(s.canonical_name, $2) as name_sim
                    FROM symbol_versions sv
                    JOIN symbols s ON s.symbol_id = sv.symbol_id
                    WHERE sv.snapshot_id = $1
                    AND s.canonical_name % $2
                    AND sv.symbol_version_id != $3
                    ORDER BY name_sim DESC
                    LIMIT 30
                `, [snapshotId, target.canonical_name, target.symbol_version_id]),

                // Bucket 6: Behavioral profile overlap (same purity class + kind)
                db.query(`
                    SELECT ${SV_COLS}
                    FROM symbol_versions sv
                    JOIN symbols s ON s.symbol_id = sv.symbol_id
                    JOIN behavioral_profiles bp1 ON bp1.symbol_version_id = sv.symbol_version_id
                    JOIN behavioral_profiles bp2 ON bp2.symbol_version_id = $2
                    WHERE sv.snapshot_id = $1
                    AND bp1.purity_class = bp2.purity_class
                    AND sv.symbol_version_id != $2
                    AND s.kind = $3
                    LIMIT 30
                `, [snapshotId, target.symbol_version_id, target.kind]),

                // Bucket 7: Same kind symbols (fallback for low-signal repos)
                db.query(`
                    SELECT ${SV_COLS}
                    FROM symbol_versions sv
                    JOIN symbols s ON s.symbol_id = sv.symbol_id
                    WHERE sv.snapshot_id = $1 AND s.kind = $2
                    AND sv.symbol_version_id != $3
                    LIMIT 20
                `, [snapshotId, target.kind, target.symbol_version_id]),
            ]);

        addRows(bodyMatches.rows as CandidateRow[]);
        addRows(astMatches.rows as CandidateRow[]);
        addRows(normalizedMatches.rows as CandidateRow[]);
        addRows(nameMatches.rows as CandidateRow[]);
        addRows(behaviorMatches.rows as CandidateRow[]);
        addRows(kindMatches.rows as CandidateRow[]);

        // Bucket 5: Semantic candidates via MinHash LSH
        // Kept sequential — depends on external engine state + per-candidate loadSymbolData
        try {
            const semanticCandidates = await semanticEngine.findSemanticCandidates(
                target.symbol_version_id, snapshotId, 30
            );
            for (const sc of semanticCandidates) {
                if (!candidateMap.has(sc.svId)) {
                    const scRow = await this.loadSymbolData(sc.svId);
                    if (scRow) candidateMap.set(sc.svId, scRow);
                }
            }
        } catch {
            log.debug('Semantic candidate generation skipped (no vectors)', { snapshotId });
        }

        return Array.from(candidateMap.values());
    }

    /**
     * Score a candidate across 7 dimensions.
     */
    private async scoreCandidate(
        target: CandidateRow,
        candidate: CandidateRow,
        _snapshotId: string
    ): Promise<EvidenceScores> {
        let familyCount = 0;

        // Dimension 1: Semantic intent similarity (TF-IDF cosine via native semantic engine)
        let semanticSim: number;
        try {
            semanticSim = await semanticEngine.computeSemanticSimilarity(
                target.symbol_version_id, candidate.symbol_version_id
            );
        } catch {
            // Fallback to name-based Jaccard if semantic vectors unavailable
            semanticSim = this.computeNameSimilarity(target.canonical_name, candidate.canonical_name);
        }
        if (semanticSim > 0.1) familyCount++;

        // Dimension 2: Normalized logic similarity (graduated hash comparison)
        let logicSim: number;
        if (target.body_hash === candidate.body_hash) {
            logicSim = 1.0; // Identical body
        } else if (target.normalized_ast_hash && candidate.normalized_ast_hash
                   && target.normalized_ast_hash === candidate.normalized_ast_hash) {
            logicSim = 0.90; // Rename-invariant structural match
        } else if (target.ast_hash === candidate.ast_hash) {
            logicSim = 0.85; // AST match (whitespace-sensitive)
        } else {
            logicSim = 0.0;
        }
        if (logicSim > 0.1) familyCount++;

        // Dimension 3: Signature/type similarity
        const sigSim = this.computeSignatureSimilarity(target.signature, candidate.signature);
        if (sigSim > 0.1) familyCount++;

        // Dimension 4: Behavioral overlap
        const behavioralOverlap = await this.computeBehavioralOverlap(
            target.symbol_version_id, candidate.symbol_version_id
        );
        if (behavioralOverlap > 0.1) familyCount++;

        // Dimension 5: Contract overlap
        const contractOverlap = await this.computeContractOverlap(
            target.symbol_version_id, candidate.symbol_version_id
        );
        if (contractOverlap > 0.1) familyCount++;

        // Dimension 6: Test overlap
        const testOverlap = await this.computeTestOverlap(
            target.symbol_version_id, candidate.symbol_version_id
        );
        if (testOverlap > 0.1) familyCount++;

        // Dimension 7: History co-change
        const historySim = await this.computeHistoryCoChange(
            target.symbol_id, candidate.symbol_id
        );
        if (historySim > 0.1) familyCount++;

        // Weighted total
        let weightedTotal =
            HOMOLOG_WEIGHTS.semantic_intent_similarity * semanticSim +
            HOMOLOG_WEIGHTS.normalized_logic_similarity * logicSim +
            HOMOLOG_WEIGHTS.signature_type_similarity * sigSim +
            HOMOLOG_WEIGHTS.behavioral_overlap * behavioralOverlap +
            HOMOLOG_WEIGHTS.contract_overlap * contractOverlap +
            HOMOLOG_WEIGHTS.test_overlap * testOverlap +
            HOMOLOG_WEIGHTS.history_co_change * historySim;

        // BUG-007 fix: Structural identity override.
        // When logicSim >= 0.85, the function bodies are structurally identical
        // (matching body_hash, normalized_ast_hash, or ast_hash). This is
        // definitive near-duplicate evidence that implies semantic, signature,
        // and behavioral similarity. Without this override, a structurally
        // identical pair can be filtered out by MIN_EVIDENCE_FAMILIES (needs >= 2)
        // or by the confidence threshold (0.70) when other dimensions lack data
        // (e.g., no semantic vectors, no behavioral profiles).
        if (logicSim >= 0.85) {
            weightedTotal = Math.max(weightedTotal, 0.85);
            familyCount = Math.max(familyCount, 3);
        }

        return {
            semantic_intent_similarity: semanticSim,
            normalized_logic_similarity: logicSim,
            signature_type_similarity: sigSim,
            behavioral_overlap: behavioralOverlap,
            contract_overlap: contractOverlap,
            test_overlap: testOverlap,
            history_co_change: historySim,
            weighted_total: Math.min(1.0, weightedTotal),
            evidence_family_count: familyCount,
            rationale: this.buildRationale(semanticSim, logicSim, sigSim,
                behavioralOverlap, contractOverlap, testOverlap, historySim),
        };
    }

    /**
     * Detect contradictions between target and candidate.
     */
    private async detectContradictions(
        target: CandidateRow,
        candidate: CandidateRow
    ): Promise<string[]> {
        const flags: string[] = [];

        // Load behavioral profiles for comparison
        const [targetBp, candidateBp] = await Promise.all([
            this.loadBehavioralProfile(target.symbol_version_id),
            this.loadBehavioralProfile(candidate.symbol_version_id),
        ]);

        if (targetBp && candidateBp) {
            // side_effects_differ: different purity classes
            if (targetBp.purity_class !== candidateBp.purity_class) {
                flags.push('side_effects_differ');
            }

            // exception_semantics_differ: different exception profiles
            const targetExc = targetBp.exception_profile || [];
            const candidateExc = candidateBp.exception_profile || [];
            if ([...targetExc].sort().join(',') !== [...candidateExc].sort().join(',')) {
                flags.push('exception_semantics_differ');
            }

            // security_context_differs: different auth operations
            const targetAuth = targetBp.auth_operations || [];
            const candidateAuth = candidateBp.auth_operations || [];
            if (targetAuth.length !== candidateAuth.length) {
                flags.push('security_context_differs');
            }

            // io_shape_diverges: different DB/network patterns
            const targetIo = [...(targetBp.db_reads || []), ...(targetBp.db_writes || []), ...(targetBp.network_calls || [])].sort().join(',');
            const candidateIo = [...(candidateBp.db_reads || []), ...(candidateBp.db_writes || []), ...(candidateBp.network_calls || [])].sort().join(',');
            if (targetIo !== candidateIo && targetIo.length > 0 && candidateIo.length > 0) {
                flags.push('io_shape_diverges');
            }
        }

        return flags;
    }

    /**
     * Classify the type of homolog relation based on evidence.
     */
    private async classifyRelationType(
        target: CandidateRow,
        candidate: CandidateRow,
        evidence: EvidenceScores
    ): Promise<InferredRelationType> {
        // Near-duplicate if logic similarity is very high
        if (evidence.normalized_logic_similarity >= 0.85) {
            return 'near_duplicate_logic';
        }

        // Kind-based classification
        if (target.kind === 'validator' && candidate.kind === 'validator') {
            return 'validator_homolog';
        }
        if (target.kind === 'serializer' && candidate.kind === 'serializer') {
            return 'serializer_homolog';
        }
        if (target.kind === 'query_builder' && candidate.kind === 'query_builder') {
            return 'query_logic_duplicate';
        }

        // Auth policy peers: both involve auth operations with high behavioral overlap
        if (evidence.behavioral_overlap >= 0.60) {
            const [targetBp, candidateBp] = await Promise.all([
                this.loadBehavioralProfile(target.symbol_version_id),
                this.loadBehavioralProfile(candidate.symbol_version_id),
            ]);
            if (targetBp?.auth_operations?.length && candidateBp?.auth_operations?.length) {
                return 'auth_policy_peer';
            }
        }

        // Error mapping peers: both throw/catch with similar exception profiles
        if (evidence.contract_overlap >= 0.50) {
            const [targetBp, candidateBp] = await Promise.all([
                this.loadBehavioralProfile(target.symbol_version_id),
                this.loadBehavioralProfile(candidate.symbol_version_id),
            ]);
            if (targetBp?.exception_profile?.length && candidateBp?.exception_profile?.length) {
                const targetThrows = targetBp.exception_profile.filter(e => e.startsWith('throws:'));
                const candidateThrows = candidateBp.exception_profile.filter(e => e.startsWith('throws:'));
                if (targetThrows.length > 0 && candidateThrows.length > 0) {
                    return 'error_mapping_peer';
                }
            }
        }

        // Behavioral overlap suggests parallel business logic
        if (evidence.behavioral_overlap >= 0.70 && evidence.contract_overlap >= 0.50) {
            return 'business_rule_parallel';
        }

        // Contract siblings share similar contracts but different implementations
        if (evidence.contract_overlap >= 0.70) {
            return 'contract_sibling';
        }

        // Normalization homolog if signatures are very similar
        if (evidence.signature_type_similarity >= 0.80) {
            return 'normalization_homolog';
        }

        // Default: near_duplicate_logic for high overall scores
        return 'near_duplicate_logic';
    }

    // ────────── Scoring Helpers ──────────

    private computeNameSimilarity(a: string, b: string): number {
        // Jaccard similarity on name tokens
        const tokensA = this.tokenizeName(a);
        const tokensB = this.tokenizeName(b);
        if (tokensA.size === 0 && tokensB.size === 0) return 1.0;
        if (tokensA.size === 0 || tokensB.size === 0) return 0.0;

        let intersection = 0;
        for (const t of tokensA) {
            if (tokensB.has(t)) intersection++;
        }
        const union = new Set([...tokensA, ...tokensB]).size;
        return union > 0 ? intersection / union : 0.0;
    }

    private tokenizeName(name: string): Set<string> {
        // Split camelCase, PascalCase, snake_case
        const parts = name
            .replace(/([a-z])([A-Z])/g, '$1_$2')
            .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
            .toLowerCase()
            .split(/[_\-\s.]+/)
            .filter(p => p.length > 0);
        return new Set(parts);
    }

    private computeSignatureSimilarity(a: string, b: string): number {
        if (!a || !b) return 0.0;
        if (a === b) return 1.0;

        // Compare parameter count and return type similarity
        const paramsA = (a.match(/\((.*?)\)/)?.[1] || '').split(',').filter(Boolean);
        const paramsB = (b.match(/\((.*?)\)/)?.[1] || '').split(',').filter(Boolean);

        const paramCountSim = paramsA.length === paramsB.length ? 0.5 : 0.0;

        // Compare return types
        const retA = a.split(':').pop()?.trim() || '';
        const retB = b.split(':').pop()?.trim() || '';
        const retSim = retA === retB ? 0.5 : 0.0;

        return paramCountSim + retSim;
    }

    private async computeBehavioralOverlap(svIdA: string, svIdB: string): Promise<number> {
        const [a, b] = await Promise.all([
            this.loadBehavioralProfile(svIdA),
            this.loadBehavioralProfile(svIdB),
        ]);
        if (!a || !b) return 0.0;

        // Jaccard on resource_touches
        const setA = new Set(a.resource_touches);
        const setB = new Set(b.resource_touches);
        if (setA.size === 0 && setB.size === 0) {
            // Both pure — behavioral overlap is 1.0 if same purity
            return a.purity_class === b.purity_class ? 1.0 : 0.0;
        }

        let intersection = 0;
        for (const r of setA) {
            if (setB.has(r)) intersection++;
        }
        const union = new Set([...setA, ...setB]).size;
        const jaccard = union > 0 ? intersection / union : 0.0;

        // Boost if same purity class
        const purityBonus = a.purity_class === b.purity_class ? 0.2 : 0.0;
        return Math.min(1.0, jaccard + purityBonus);
    }

    private async computeContractOverlap(svIdA: string, svIdB: string): Promise<number> {
        const [a, b] = await Promise.all([
            this.loadContractProfile(svIdA),
            this.loadContractProfile(svIdB),
        ]);
        if (!a || !b) return 0.0;

        let matches = 0;
        let total = 0;

        if (a.input_contract && b.input_contract) {
            total++;
            if (a.input_contract === b.input_contract) matches++;
        }
        if (a.output_contract && b.output_contract) {
            total++;
            if (a.output_contract === b.output_contract) matches++;
        }
        if (a.error_contract && b.error_contract) {
            total++;
            if (a.error_contract === b.error_contract) matches++;
        }
        if (a.security_contract && b.security_contract) {
            total++;
            if (a.security_contract === b.security_contract) matches++;
        }

        return total > 0 ? matches / total : 0.0;
    }

    private async computeTestOverlap(svIdA: string, svIdB: string): Promise<number> {
        // Count test artifacts whose related_symbols contain BOTH svIdA and svIdB
        const result = await db.query(`
            SELECT COUNT(*) as cnt
            FROM test_artifacts ta
            WHERE $1 = ANY(ta.related_symbols)
            AND $2 = ANY(ta.related_symbols)
        `, [svIdA, svIdB]);

        const count = parseInt(result.rows[0]?.cnt as string || '0', 10);
        return count > 0 ? Math.min(1.0, count * 0.3) : 0.0;
    }

    private async computeHistoryCoChange(symbolIdA: string, symbolIdB: string): Promise<number> {
        // Check inferred co_changed_with relations
        const result = await db.query(`
            SELECT confidence FROM inferred_relations
            WHERE relation_type = 'co_changed_with'
            AND (
                (src_symbol_version_id IN (SELECT symbol_version_id FROM symbol_versions WHERE symbol_id = $1)
                 AND dst_symbol_version_id IN (SELECT symbol_version_id FROM symbol_versions WHERE symbol_id = $2))
                OR
                (src_symbol_version_id IN (SELECT symbol_version_id FROM symbol_versions WHERE symbol_id = $2)
                 AND dst_symbol_version_id IN (SELECT symbol_version_id FROM symbol_versions WHERE symbol_id = $1))
            )
            ORDER BY confidence DESC
            LIMIT 1
        `, [symbolIdA, symbolIdB]);

        return (result.rows[0]?.confidence as number) ?? 0.0;
    }

    // ────────── Data Loaders ──────────

    private async loadSymbolData(svId: string): Promise<CandidateRow | null> {
        const result = await db.query(`
            SELECT sv.symbol_version_id, sv.symbol_id, s.canonical_name,
                   s.stable_key, sv.body_hash, sv.ast_hash, sv.normalized_ast_hash, sv.signature, s.kind
            FROM symbol_versions sv
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            WHERE sv.symbol_version_id = $1
        `, [svId]);
        return result.rows[0] as CandidateRow ?? null;
    }

    private async loadBehavioralProfile(svId: string): Promise<BehavioralProfile | null> {
        const cacheKey = `bp:${svId}`;
        const cached = profileCache.get(cacheKey) as BehavioralProfile | undefined;
        if (cached) return cached;

        const result = await db.query(
            `SELECT * FROM behavioral_profiles WHERE symbol_version_id = $1`,
            [svId]
        );
        const profile = result.rows[0] as BehavioralProfile ?? null;
        if (profile) profileCache.set(cacheKey, profile);
        return profile;
    }

    private async loadContractProfile(svId: string): Promise<ContractProfile | null> {
        const cacheKey = `cp:${svId}`;
        const cached = profileCache.get(cacheKey) as ContractProfile | undefined;
        if (cached) return cached;

        const result = await db.query(
            `SELECT * FROM contract_profiles WHERE symbol_version_id = $1`,
            [svId]
        );
        const profile = result.rows[0] as ContractProfile ?? null;
        if (profile) profileCache.set(cacheKey, profile);
        return profile;
    }

    private buildRationale(
        semantic: number, logic: number, sig: number,
        behavioral: number, contract: number, test: number, history: number
    ): string {
        const parts: string[] = [];
        if (logic >= 0.85) parts.push('near-identical logic');
        else if (logic > 0) parts.push(`logic similarity: ${(logic * 100).toFixed(0)}%`);
        if (semantic >= 0.70) parts.push('strong name similarity');
        if (sig >= 0.70) parts.push('matching signatures');
        if (behavioral >= 0.70) parts.push('overlapping behavior');
        if (contract >= 0.70) parts.push('matching contracts');
        if (test > 0) parts.push('shared test coverage');
        if (history > 0) parts.push('historical co-change');
        return parts.join('; ') || 'weak evidence';
    }
}

export const homologInferenceEngine = new HomologInferenceEngine();
