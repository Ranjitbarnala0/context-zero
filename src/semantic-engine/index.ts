/**
 * ContextZero — Semantic Engine
 *
 * Orchestrates multi-view embedding generation, IDF corpus computation,
 * MinHash indexing, and semantic similarity queries.
 *
 * This is the native replacement for external embedding APIs.
 * It powers Homolog Dimension 1 (semantic intent similarity) and
 * provides candidates for Dimension 2 (normalized logic similarity).
 */

import { v4 as uuidv4 } from 'uuid';
import { db } from '../db-driver';
import { BatchLoader } from '../db-driver/batch-loader';
import { Logger } from '../logger';
import { BehaviorHint, ContractHint } from '../types';
import {
    tokenizeName,
    tokenizeBody,
    tokenizeSignature,
    tokenizeBehavior,
    tokenizeContract,
} from './tokenizer';
import {
    SparseVector,
    computeTF,
    computeIDF,
    computeTFIDF,
    generateMinHash,
    estimateJaccardFromMinHash,
    multiViewSimilarity,
    computeBandHashes,
    LSH_ROWS_PER_BAND,
} from './similarity';

const log = new Logger('semantic-engine');

/** The five semantic view types used by the engine */
const VIEW_TYPES = ['name', 'body', 'signature', 'behavior', 'contract'] as const;
type ViewType = typeof VIEW_TYPES[number];

/** Default weights for multi-view similarity (aligned with HOMOLOG_WEIGHTS dimension 1) */
const DEFAULT_VIEW_WEIGHTS: Record<string, number> = {
    name: 0.25,
    body: 0.30,
    signature: 0.20,
    behavior: 0.15,
    contract: 0.10,
};

/** Number of MinHash permutations for LSH */
const MINHASH_PERMUTATIONS = 128;

class SemanticEngine {
    /**
     * Compute IDF statistics for an entire snapshot, per view type.
     * Loads all tokens from semantic_vectors for the given snapshot,
     * computes IDF, and upserts into idf_corpus.
     */
    async computeSnapshotIDF(snapshotId: string): Promise<void> {
        const done = log.startTimer('computeSnapshotIDF', { snapshotId });

        try {
            for (const viewType of VIEW_TYPES) {
                // Load all sparse vectors for this view type within the snapshot
                const result = await db.query(
                    `SELECT sv.sparse_vector
                     FROM semantic_vectors sv
                     JOIN symbol_versions symv ON symv.symbol_version_id = sv.symbol_version_id
                     WHERE symv.snapshot_id = $1 AND sv.view_type = $2`,
                    [snapshotId, viewType],
                );

                const rows = result.rows;
                const totalDocs = rows.length;

                if (totalDocs === 0) {
                    log.debug('No documents found for IDF computation', { snapshotId, viewType });
                    continue;
                }

                // Build token sets from sparse vector keys
                const tokenSets: Set<string>[] = [];
                for (const row of rows) {
                    const sparseVec: Record<string, number> =
                        typeof row.sparse_vector === 'string'
                            ? JSON.parse(row.sparse_vector)
                            : row.sparse_vector;
                    tokenSets.push(new Set(Object.keys(sparseVec)));
                }

                // Compute IDF
                const idfScores = computeIDF(tokenSets, totalDocs);

                // Build document count map for storage
                const tokenDocCounts: Record<string, number> = {};
                for (const tokenSet of tokenSets) {
                    for (const token of tokenSet) {
                        tokenDocCounts[token] = (tokenDocCounts[token] || 0) + 1;
                    }
                }

                // Upsert into idf_corpus
                const corpusId = uuidv4();
                await db.query(
                    `INSERT INTO idf_corpus (corpus_id, snapshot_id, view_type, document_count, token_document_counts)
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (snapshot_id, view_type)
                     DO UPDATE SET document_count = $4, token_document_counts = $5, computed_at = NOW()`,
                    [corpusId, snapshotId, viewType, totalDocs, JSON.stringify(tokenDocCounts)],
                );

                log.debug('IDF computed for view', {
                    snapshotId,
                    viewType,
                    totalDocs,
                    uniqueTokens: Object.keys(idfScores).length,
                });
            }

            done();
        } catch (error) {
            log.error('Failed to compute snapshot IDF', error, { snapshotId });
            throw error;
        }
    }

    /**
     * Embed a single symbol version: generate 5 view token streams,
     * compute TF-IDF vectors, generate MinHash signatures, persist to DB.
     */
    async embedSymbol(
        symbolVersionId: string,
        code: string,
        name: string,
        signature: string,
        behaviorHints: BehaviorHint[],
        contractHint: ContractHint | null,
    ): Promise<void> {
        const done = log.startTimer('embedSymbol', { symbolVersionId });

        try {
            // Step 1: Generate token streams for all 5 views
            const viewTokens: Record<ViewType, string[]> = {
                name: tokenizeName(name),
                body: tokenizeBody(code),
                signature: tokenizeSignature(signature),
                behavior: tokenizeBehavior(
                    behaviorHints.map((h) => ({ hint_type: h.hint_type, detail: h.detail })),
                ),
                contract: contractHint
                    ? tokenizeContract({
                          input_types: contractHint.input_types,
                          output_type: contractHint.output_type,
                          thrown_types: contractHint.thrown_types,
                          decorators: contractHint.decorators,
                      })
                    : [],
            };

            // Step 2: Load IDF from DB (try to find corpus for this symbol's snapshot)
            const snapshotResult = await db.query(
                `SELECT snapshot_id FROM symbol_versions WHERE symbol_version_id = $1`,
                [symbolVersionId],
            );
            const snapshotId = snapshotResult.rows[0]?.snapshot_id;

            // Load IDF per view type if available
            const idfByView: Record<string, Record<string, number>> = {};
            if (snapshotId) {
                const idfResult = await db.query(
                    `SELECT view_type, document_count, token_document_counts
                     FROM idf_corpus
                     WHERE snapshot_id = $1`,
                    [snapshotId],
                );
                for (const row of idfResult.rows) {
                    const docCounts: Record<string, number> =
                        typeof row.token_document_counts === 'string'
                            ? JSON.parse(row.token_document_counts)
                            : row.token_document_counts;
                    const totalDocs = row.document_count as number;

                    // Reconstruct IDF from stored doc counts
                    const idf: Record<string, number> = {};
                    for (const [token, freq] of Object.entries(docCounts)) {
                        idf[token] = Math.log(1 + totalDocs / (1 + freq));
                    }
                    idfByView[row.view_type as string] = idf;
                }
            }

            // Step 3: Compute TF-IDF and MinHash for each view, prepare batch insert
            const statements: { text: string; params: unknown[] }[] = [];

            for (const viewType of VIEW_TYPES) {
                const tokens = viewTokens[viewType];
                const tf = computeTF(tokens);
                const idf = idfByView[viewType] || {};
                const tfidf = computeTFIDF(tf, idf);

                const tokenSet = new Set(tokens);
                const minhash = generateMinHash(tokenSet, MINHASH_PERMUTATIONS);

                const vectorId = uuidv4();
                statements.push({
                    text: `INSERT INTO semantic_vectors
                           (vector_id, symbol_version_id, view_type, sparse_vector, minhash_signature, token_count)
                           VALUES ($1, $2, $3, $4, $5, $6)
                           ON CONFLICT (symbol_version_id, view_type)
                           DO UPDATE SET sparse_vector = $4, minhash_signature = $5, token_count = $6, created_at = NOW()`,
                    params: [
                        vectorId,
                        symbolVersionId,
                        viewType,
                        JSON.stringify(tfidf),
                        minhash,
                        tokens.length,
                    ],
                });

                // Compute LSH band hashes and insert into lsh_bands for sub-linear retrieval
                const bandHashes = computeBandHashes(minhash, LSH_ROWS_PER_BAND);
                for (let b = 0; b < bandHashes.length; b++) {
                    statements.push({
                        text: `INSERT INTO lsh_bands (symbol_version_id, view_type, band_index, band_hash)
                               VALUES ($1, $2, $3, $4)
                               ON CONFLICT (symbol_version_id, view_type, band_index)
                               DO UPDATE SET band_hash = $4`,
                        params: [symbolVersionId, viewType, b, bandHashes[b]],
                    });
                }
            }

            // Step 4: Batch insert all 5 views in a single transaction
            await db.batchInsert(statements);

            done({ views: VIEW_TYPES.length, totalTokens: Object.values(viewTokens).reduce((s, t) => s + t.length, 0) });
        } catch (error) {
            log.error('Failed to embed symbol', error, { symbolVersionId });
            throw error;
        }
    }

    /**
     * Find semantic candidates for a symbol using LSH banding.
     * Computes band hashes from the target's MinHash signatures, queries the
     * lsh_bands table for symbols sharing at least one band, then re-scores
     * matches with weighted Jaccard for accurate ranking.
     *
     * Falls back to linear scan if no LSH bands exist (graceful degradation).
     */
    async findSemanticCandidates(
        symbolVersionId: string,
        snapshotId: string,
        topK: number = 50,
    ): Promise<{ svId: string; estimatedSimilarity: number }[]> {
        const done = log.startTimer('findSemanticCandidates', { symbolVersionId, snapshotId, topK });

        try {
            // Step 1: Load target MinHash signatures (all views)
            const targetResult = await db.query(
                `SELECT view_type, minhash_signature
                 FROM semantic_vectors
                 WHERE symbol_version_id = $1`,
                [symbolVersionId],
            );

            if (targetResult.rows.length === 0) {
                log.warn('No semantic vectors found for target symbol', { symbolVersionId });
                done({ candidates: 0 });
                return [];
            }

            const targetMinHashes: Record<string, number[]> = {};
            for (const row of targetResult.rows) {
                targetMinHashes[row.view_type as string] = row.minhash_signature as number[];
            }

            // Step 2: Compute band hashes for the target's MinHash signatures
            const targetBandHashes: Record<string, number[]> = {};
            for (const [viewType, minhash] of Object.entries(targetMinHashes)) {
                targetBandHashes[viewType] = computeBandHashes(minhash, LSH_ROWS_PER_BAND);
            }

            // Step 3: Check if LSH bands have been built; if not, fall back to linear scan
            const lshCheck = await db.query(
                `SELECT 1 FROM lsh_bands lb
                 JOIN symbol_versions sv ON sv.symbol_version_id = lb.symbol_version_id
                 WHERE sv.snapshot_id = $1
                 LIMIT 1`,
                [snapshotId],
            );

            if (lshCheck.rows.length === 0) {
                log.info('No LSH bands found for snapshot, falling back to linear scan', { snapshotId });
                const result = await this._findSemanticCandidatesLinear(
                    symbolVersionId, snapshotId, topK, targetMinHashes,
                );
                done({ candidates: result.length, mode: 'linear-fallback' });
                return result;
            }

            // Step 4: For each view type, query lsh_bands for candidate matches
            const viewTypes = Object.keys(targetBandHashes);
            const candidateSvIds = new Set<string>();

            const bandQueries = viewTypes.map(async (viewType) => {
                const bands = targetBandHashes[viewType]!;
                if (bands.length === 0) return;

                // Build VALUES list for (band_index, band_hash) tuples
                const valueEntries: string[] = [];
                const queryParams: unknown[] = [snapshotId, symbolVersionId, viewType];
                let paramIdx = 4; // $1=snapshotId, $2=symbolVersionId, $3=viewType

                for (let b = 0; b < bands.length; b++) {
                    valueEntries.push(`($${paramIdx}::smallint, $${paramIdx + 1}::int)`);
                    queryParams.push(b, bands[b]);
                    paramIdx += 2;
                }

                const query = `
                    SELECT DISTINCT lb.symbol_version_id
                    FROM lsh_bands lb
                    JOIN symbol_versions sv ON sv.symbol_version_id = lb.symbol_version_id
                    WHERE sv.snapshot_id = $1
                    AND lb.symbol_version_id != $2
                    AND lb.view_type = $3
                    AND (lb.band_index, lb.band_hash) IN (VALUES ${valueEntries.join(', ')})
                `;

                const result = await db.query(query, queryParams);
                for (const row of result.rows) {
                    candidateSvIds.add(row.symbol_version_id as string);
                }
            });

            await Promise.all(bandQueries);

            if (candidateSvIds.size === 0) {
                log.debug('LSH banding found no candidates', { symbolVersionId, snapshotId });
                done({ candidates: 0, mode: 'lsh' });
                return [];
            }

            // Step 5: Load MinHash signatures for LSH candidate symbols (chunked)
            const candidateIds = Array.from(candidateSvIds);
            const CHUNK_SIZE = 5000;
            const candidateMinHashes: Map<string, Record<string, number[]>> = new Map();

            for (let i = 0; i < candidateIds.length; i += CHUNK_SIZE) {
                const chunk = candidateIds.slice(i, i + CHUNK_SIZE);
                const placeholders = chunk.map((_, j) => `$${j + 1}`).join(', ');
                const minhashResult = await db.query(
                    `SELECT symbol_version_id, view_type, minhash_signature
                     FROM semantic_vectors
                     WHERE symbol_version_id IN (${placeholders})`,
                    chunk,
                );

                for (const row of minhashResult.rows) {
                    const svId = row.symbol_version_id as string;
                    if (!candidateMinHashes.has(svId)) {
                        candidateMinHashes.set(svId, {});
                    }
                    candidateMinHashes.get(svId)![row.view_type as string] = row.minhash_signature as number[];
                }
            }

            // Step 6: Re-score candidates with weighted Jaccard similarity
            const scores: { svId: string; estimatedSimilarity: number }[] = [];

            for (const [svId, viewMinHashes] of candidateMinHashes) {
                let totalSim = 0;
                let totalWeight = 0;

                for (const [viewType, weight] of Object.entries(DEFAULT_VIEW_WEIGHTS)) {
                    const targetSig = targetMinHashes[viewType];
                    const candidateSig = viewMinHashes[viewType];

                    totalWeight += weight;

                    if (targetSig && candidateSig) {
                        totalSim += weight * estimateJaccardFromMinHash(targetSig, candidateSig);
                    }
                }

                const estimatedSimilarity = totalWeight > 0 ? totalSim / totalWeight : 0;
                scores.push({ svId, estimatedSimilarity });
            }

            // Sort by similarity descending, take top-K
            scores.sort((a, b) => b.estimatedSimilarity - a.estimatedSimilarity);
            const topCandidates = scores.slice(0, topK);

            done({
                candidates: topCandidates.length,
                lshMatches: candidateSvIds.size,
                mode: 'lsh',
            });
            return topCandidates;
        } catch (error) {
            log.error('Failed to find semantic candidates', error, { symbolVersionId, snapshotId });
            throw error;
        }
    }

    /**
     * Linear fallback for findSemanticCandidates when LSH bands haven't been built.
     * Loads ALL MinHash signatures in the snapshot and compares O(N).
     * Kept as graceful degradation for snapshots without LSH band data.
     */
    private async _findSemanticCandidatesLinear(
        symbolVersionId: string,
        snapshotId: string,
        topK: number,
        targetMinHashes: Record<string, number[]>,
    ): Promise<{ svId: string; estimatedSimilarity: number }[]> {
        // Load all other symbols' MinHash signatures in the same snapshot
        const candidatesResult = await db.query(
            `SELECT sv.symbol_version_id, sv.view_type, sv.minhash_signature
             FROM semantic_vectors sv
             JOIN symbol_versions symv ON symv.symbol_version_id = sv.symbol_version_id
             WHERE symv.snapshot_id = $1 AND sv.symbol_version_id != $2`,
            [snapshotId, symbolVersionId],
        );

        // Group by symbol_version_id
        const candidateMinHashes: Map<string, Record<string, number[]>> = new Map();
        for (const row of candidatesResult.rows) {
            const svId = row.symbol_version_id as string;
            if (!candidateMinHashes.has(svId)) {
                candidateMinHashes.set(svId, {});
            }
            candidateMinHashes.get(svId)![row.view_type as string] = row.minhash_signature as number[];
        }

        // Compute estimated similarity for each candidate
        const scores: { svId: string; estimatedSimilarity: number }[] = [];

        for (const [svId, viewMinHashes] of candidateMinHashes) {
            let totalSim = 0;
            let totalWeight = 0;

            for (const [viewType, weight] of Object.entries(DEFAULT_VIEW_WEIGHTS)) {
                const targetSig = targetMinHashes[viewType];
                const candidateSig = viewMinHashes[viewType];

                totalWeight += weight;

                if (targetSig && candidateSig) {
                    totalSim += weight * estimateJaccardFromMinHash(targetSig, candidateSig);
                }
            }

            const estimatedSimilarity = totalWeight > 0 ? totalSim / totalWeight : 0;
            scores.push({ svId, estimatedSimilarity });
        }

        // Sort by similarity descending, take top-K
        scores.sort((a, b) => b.estimatedSimilarity - a.estimatedSimilarity);
        return scores.slice(0, topK);
    }

    /**
     * Compute precise semantic similarity between two symbol versions
     * using multi-view weighted cosine similarity on TF-IDF vectors.
     */
    async computeSemanticSimilarity(
        svIdA: string,
        svIdB: string,
    ): Promise<number> {
        try {
            // Load TF-IDF vectors for both symbols
            const [resultA, resultB] = await Promise.all([
                db.query(
                    `SELECT view_type, sparse_vector FROM semantic_vectors WHERE symbol_version_id = $1`,
                    [svIdA],
                ),
                db.query(
                    `SELECT view_type, sparse_vector FROM semantic_vectors WHERE symbol_version_id = $1`,
                    [svIdB],
                ),
            ]);

            if (resultA.rows.length === 0 || resultB.rows.length === 0) {
                log.warn('Missing semantic vectors for similarity computation', {
                    svIdA,
                    svIdB,
                    vectorsA: resultA.rows.length,
                    vectorsB: resultB.rows.length,
                });
                return 0;
            }

            const viewsA: Map<string, SparseVector> = new Map();
            for (const row of resultA.rows) {
                const vec: SparseVector =
                    typeof row.sparse_vector === 'string'
                        ? JSON.parse(row.sparse_vector)
                        : row.sparse_vector;
                viewsA.set(row.view_type as string, vec);
            }

            const viewsB: Map<string, SparseVector> = new Map();
            for (const row of resultB.rows) {
                const vec: SparseVector =
                    typeof row.sparse_vector === 'string'
                        ? JSON.parse(row.sparse_vector)
                        : row.sparse_vector;
                viewsB.set(row.view_type as string, vec);
            }

            return multiViewSimilarity(viewsA, viewsB, DEFAULT_VIEW_WEIGHTS);
        } catch (error) {
            log.error('Failed to compute semantic similarity', error, { svIdA, svIdB });
            throw error;
        }
    }

    /**
     * Compute body-only similarity between two symbols using MinHash Jaccard.
     * This gives graduated similarity (0.0–1.0) for function bodies that share
     * logic but aren't byte-identical — unlike hash comparison which is binary.
     */
    async computeBodySimilarity(svIdA: string, svIdB: string): Promise<number> {
        const [resultA, resultB] = await Promise.all([
            db.query(
                `SELECT minhash_signature FROM semantic_vectors WHERE symbol_version_id = $1 AND view_type = 'body'`,
                [svIdA],
            ),
            db.query(
                `SELECT minhash_signature FROM semantic_vectors WHERE symbol_version_id = $1 AND view_type = 'body'`,
                [svIdB],
            ),
        ]);

        if (resultA.rows.length === 0 || resultB.rows.length === 0) return 0;

        const sigA = resultA.rows[0].minhash_signature as number[];
        const sigB = resultB.rows[0].minhash_signature as number[];

        if (!sigA || !sigB) return 0;

        return estimateJaccardFromMinHash(sigA, sigB);
    }

    /**
     * Batch-embed all symbols in a snapshot, then compute IDF.
     * Returns the number of symbols embedded.
     */
    async batchEmbedSnapshot(snapshotId: string): Promise<number> {
        const done = log.startTimer('batchEmbedSnapshot', { snapshotId });

        try {
            // Load all symbol versions for this snapshot with their data
            const symbolsResult = await db.query(
                `SELECT
                    symv.symbol_version_id,
                    symv.signature,
                    symv.summary,
                    s.canonical_name,
                    f.path AS file_path
                 FROM symbol_versions symv
                 JOIN symbols s ON s.symbol_id = symv.symbol_id
                 JOIN files f ON f.file_id = symv.file_id
                 WHERE symv.snapshot_id = $1`,
                [snapshotId],
            );

            const symbols = symbolsResult.rows;
            log.info('Starting batch embedding', { snapshotId, symbolCount: symbols.length });

            // Pre-load ALL behavioral and contract profiles in 2 bulk queries
            const allSvIds = symbols.map(s => s.symbol_version_id as string);
            const loader = new BatchLoader();
            const allBehavioral = await loader.loadBehavioralProfiles(allSvIds);
            const allContracts = await loader.loadContractProfiles(allSvIds);

            let embedded = 0;

            for (const sym of symbols) {
                const svId = sym.symbol_version_id as string;
                const name = sym.canonical_name as string;
                const signature = sym.signature as string;

                // Convert behavioral profile to BehaviorHint format (from pre-loaded data)
                const behaviorHints: BehaviorHint[] = [];
                const bp = allBehavioral.get(svId);
                if (bp) {
                    const addHints = (items: string[], hintType: BehaviorHint['hint_type']) => {
                        const arr = Array.isArray(items) ? items : [];
                        for (const detail of arr) {
                            behaviorHints.push({
                                symbol_key: name,
                                hint_type: hintType,
                                detail,
                                line: 0,
                            });
                        }
                    };
                    addHints(bp.db_reads, 'db_read');
                    addHints(bp.db_writes, 'db_write');
                    addHints(bp.network_calls, 'network_call');
                    addHints(bp.file_io, 'file_io');
                    addHints(bp.cache_ops, 'cache_op');
                    addHints(bp.auth_operations, 'auth_check');
                    addHints(bp.validation_operations, 'validation');
                    addHints(bp.exception_profile, 'throws');
                }

                // Use pre-loaded contract profile
                let contractHint: ContractHint | null = null;
                const cp = allContracts.get(svId);
                if (cp) {
                    contractHint = {
                        symbol_key: name,
                        input_types: Array.isArray(cp.input_contract) ? cp.input_contract : [String(cp.input_contract || '')],
                        output_type: String(cp.output_contract || ''),
                        thrown_types: Array.isArray(cp.error_contract) ? cp.error_contract : [String(cp.error_contract || '')],
                        decorators: Array.isArray(cp.schema_refs) ? cp.schema_refs : [],
                    };
                }

                // Use the symbol's summary as a proxy for code body
                // (actual source code may not be stored in DB; summary captures intent)
                const codeBody = (sym.summary as string) || '';

                await this.embedSymbol(svId, codeBody, name, signature, behaviorHints, contractHint);
                embedded++;

                if (embedded % 100 === 0) {
                    log.info('Batch embedding progress', { snapshotId, embedded, total: symbols.length });
                }
            }

            // After all symbols are embedded, compute IDF for the snapshot
            log.info('All symbols embedded, computing IDF', { snapshotId, embedded });
            await this.computeSnapshotIDF(snapshotId);

            done({ embedded });
            return embedded;
        } catch (error) {
            log.error('Failed to batch embed snapshot', error, { snapshotId });
            throw error;
        }
    }
}

export const semanticEngine = new SemanticEngine();
