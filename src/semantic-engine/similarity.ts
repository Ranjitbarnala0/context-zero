/**
 * ContextZero — Native Similarity Engine
 *
 * TF-IDF sparse vectors + MinHash signatures + Cosine similarity.
 * No external dependencies. Pure math.
 *
 * MinHash uses 128 random hash permutations for LSH candidate generation.
 * TF-IDF uses log-normalized term frequency with smooth IDF.
 */

/**
 * Sparse vector: maps token -> TF-IDF score.
 * After L2 normalization, the dot product of two sparse vectors equals cosine similarity.
 */
export type SparseVector = Record<string, number>;

// --------------------------------------------------------------------------
// Hash function: FNV-1a 32-bit — fast, deterministic, no dependencies
// --------------------------------------------------------------------------

function fnv1a(input: string): number {
    let hash = 0x811c9dc5; // FNV offset basis
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        // FNV prime: multiply by 16777619, keep within 32-bit unsigned range
        hash = Math.imul(hash, 0x01000193);
    }
    // Convert to unsigned 32-bit
    return hash >>> 0;
}

// --------------------------------------------------------------------------
// MinHash permutation coefficients — deterministic from a fixed seed
// --------------------------------------------------------------------------

const LARGE_PRIME = 4294967291; // Largest prime < 2^32
const LARGE_PRIME_BIG = BigInt(LARGE_PRIME);
const MAX_PERMUTATIONS = 256;

/**
 * Pre-computed permutation coefficients for MinHash.
 * Each permutation is defined by h_i(x) = (a_i * hash(x) + b_i) % LARGE_PRIME.
 * Coefficients are derived deterministically from a seed using a simple LCG.
 *
 * Stored as BigInt to prevent overflow in permutation computation:
 * a and h can each be up to ~2^32, so a*h can reach ~2^64, which exceeds
 * Number.MAX_SAFE_INTEGER (2^53). BigInt handles arbitrary precision.
 */
const PERM_A: bigint[] = [];
const PERM_B: bigint[] = [];

(function initPermutations(): void {
    // Simple LCG for deterministic coefficient generation
    // seed = 42 (the answer to everything)
    let state = 42;
    function nextRand(): number {
        // LCG: state = (state * 1664525 + 1013904223) mod 2^32
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state;
    }

    for (let i = 0; i < MAX_PERMUTATIONS; i++) {
        // a must be non-zero
        let a = nextRand() % (LARGE_PRIME - 1);
        if (a === 0) a = 1;
        const b = nextRand() % LARGE_PRIME;
        PERM_A.push(BigInt(a));
        PERM_B.push(BigInt(b));
    }
})();

// --------------------------------------------------------------------------
// TF-IDF functions
// --------------------------------------------------------------------------

/**
 * Compute log-normalized term frequency.
 * TF(t) = 1 + log(count(t)) for each token t in the document.
 */
export function computeTF(tokens: string[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const token of tokens) {
        counts[token] = (counts[token] || 0) + 1;
    }

    const tf: Record<string, number> = {};
    for (const [token, count] of Object.entries(counts)) {
        tf[token] = 1 + Math.log(count);
    }
    return tf;
}

/**
 * Compute smooth inverse document frequency.
 * IDF(t) = log(1 + totalDocs / (1 + docFreq(t)))
 *
 * @param documentTokenSets Array of token sets, one per document
 * @param totalDocs Total number of documents in the corpus
 */
export function computeIDF(
    documentTokenSets: Set<string>[],
    totalDocs: number,
): Record<string, number> {
    // Count how many documents contain each token
    const docFreq: Record<string, number> = {};
    for (const tokenSet of documentTokenSets) {
        for (const token of tokenSet) {
            docFreq[token] = (docFreq[token] || 0) + 1;
        }
    }

    const idf: Record<string, number> = {};
    for (const [token, freq] of Object.entries(docFreq)) {
        idf[token] = Math.log(1 + totalDocs / (1 + freq));
    }
    return idf;
}

/**
 * Compute TF-IDF sparse vector, then L2-normalize the result.
 * If a token has no IDF entry, it is assigned a default IDF of 1.0.
 */
export function computeTFIDF(
    tf: Record<string, number>,
    idf: Record<string, number>,
): SparseVector {
    const raw: SparseVector = {};

    for (const [token, tfValue] of Object.entries(tf)) {
        const idfValue = idf[token] ?? 1.0;
        raw[token] = tfValue * idfValue;
    }

    // L2 normalize
    let magnitude = 0;
    for (const value of Object.values(raw)) {
        magnitude += value * value;
    }
    magnitude = Math.sqrt(magnitude);

    if (magnitude === 0) {
        return raw;
    }

    const normalized: SparseVector = {};
    for (const [token, value] of Object.entries(raw)) {
        normalized[token] = value / magnitude;
    }

    return normalized;
}

// --------------------------------------------------------------------------
// Cosine similarity
// --------------------------------------------------------------------------

/**
 * Compute cosine similarity between two L2-normalized sparse vectors.
 * Since vectors are L2-normalized, dot product = cosine similarity.
 */
export function cosineSimilarity(a: SparseVector, b: SparseVector): number {
    // Iterate over the smaller vector for efficiency
    let dotProduct = 0;
    const [smaller, larger] = Object.keys(a).length <= Object.keys(b).length
        ? [a, b]
        : [b, a];

    for (const [token, valueA] of Object.entries(smaller)) {
        const valueB = larger[token];
        if (valueB !== undefined) {
            dotProduct += valueA * valueB;
        }
    }

    // Clamp to [0, 1] to handle floating-point noise
    return Math.max(0, Math.min(1, dotProduct));
}

// --------------------------------------------------------------------------
// MinHash
// --------------------------------------------------------------------------

/**
 * Generate a MinHash signature for a set of tokens.
 *
 * For each permutation i, computes:
 *   h_i(x) = (PERM_A[i] * fnv1a(x) + PERM_B[i]) % LARGE_PRIME
 * and takes the minimum across all tokens x in the set.
 *
 * Uses BigInt arithmetic to prevent overflow: a and h can each be up to ~2^32,
 * so a*h can reach ~2^64, which exceeds Number.MAX_SAFE_INTEGER (2^53).
 *
 * @param tokens Set of tokens to hash
 * @param numPermutations Number of hash permutations (default 128, max 256)
 * @returns Array of minimum hash values, one per permutation
 */
export function generateMinHash(
    tokens: Set<string>,
    numPermutations: number = 128,
): number[] {
    const nPerms = Math.min(numPermutations, MAX_PERMUTATIONS);
    const signature: number[] = new Array(nPerms).fill(0xFFFFFFFF);

    if (tokens.size === 0) {
        return signature;
    }

    // Pre-hash all tokens once, store as BigInt for safe arithmetic
    const tokenHashes: bigint[] = [];
    for (const token of tokens) {
        tokenHashes.push(BigInt(fnv1a(token)));
    }

    for (let i = 0; i < nPerms; i++) {
        const a = PERM_A[i]!;
        const b = PERM_B[i]!;
        let minHash = 0xFFFFFFFF;

        for (const h of tokenHashes) {
            // h_i(x) = (a * hash(x) + b) % LARGE_PRIME
            // BigInt arithmetic prevents overflow when a*h exceeds 2^53
            const permuted = Number((a * h + b) % LARGE_PRIME_BIG);
            if (permuted < minHash) {
                minHash = permuted;
            }
        }

        signature[i] = minHash;
    }

    return signature;
}

/**
 * Estimate Jaccard similarity from two MinHash signatures.
 * Counts the fraction of matching positions.
 */
export function estimateJaccardFromMinHash(
    sigA: number[],
    sigB: number[],
): number {
    const length = Math.min(sigA.length, sigB.length);
    if (length === 0) return 0;

    let matches = 0;
    for (let i = 0; i < length; i++) {
        if (sigA[i] === sigB[i]) {
            matches++;
        }
    }

    return matches / length;
}

// --------------------------------------------------------------------------
// LSH Banding — Locality-Sensitive Hashing for sub-linear candidate retrieval
// --------------------------------------------------------------------------

/** Number of consecutive MinHash rows per LSH band */
export const LSH_ROWS_PER_BAND = 8;

/**
 * Compute LSH band hashes from a MinHash signature.
 *
 * Splits the signature into bands of `rowsPerBand` consecutive values.
 * Each band is hashed using FNV-1a over the raw 32-bit integer bytes,
 * producing a single 32-bit hash per band.
 *
 * With 128 permutations and rowsPerBand=8, this yields 16 bands.
 * Two signatures sharing at least one identical band are LSH candidates.
 *
 * @param signature MinHash signature array (e.g., length 128)
 * @param rowsPerBand Number of consecutive MinHash values per band (default: LSH_ROWS_PER_BAND)
 * @returns Array of band hash integers (length = floor(signature.length / rowsPerBand))
 */
export function computeBandHashes(
    signature: number[],
    rowsPerBand: number = LSH_ROWS_PER_BAND,
): number[] {
    const numBands = Math.floor(signature.length / rowsPerBand);
    const bandHashes: number[] = new Array(numBands);

    for (let band = 0; band < numBands; band++) {
        const offset = band * rowsPerBand;

        // FNV-1a over the raw bytes of R consecutive 32-bit integers
        let hash = 0x811c9dc5; // FNV offset basis

        for (let r = 0; r < rowsPerBand; r++) {
            const value = signature[offset + r]!;

            // Process each of the 4 bytes of the 32-bit integer (little-endian)
            hash ^= value & 0xFF;
            hash = Math.imul(hash, 0x01000193);

            hash ^= (value >>> 8) & 0xFF;
            hash = Math.imul(hash, 0x01000193);

            hash ^= (value >>> 16) & 0xFF;
            hash = Math.imul(hash, 0x01000193);

            hash ^= (value >>> 24) & 0xFF;
            hash = Math.imul(hash, 0x01000193);
        }

        // Convert to signed 32-bit integer for PostgreSQL INTEGER column compatibility
        bandHashes[band] = hash | 0;
    }

    return bandHashes;
}

// --------------------------------------------------------------------------
// Multi-view similarity
// --------------------------------------------------------------------------

/**
 * Compute weighted combination of per-view cosine similarities.
 *
 * For each view that exists in both viewsA and viewsB, computes cosine similarity
 * and multiplies by the view's weight. Views missing from either side contribute 0.
 *
 * @param viewsA Map of view_type -> sparse vector for symbol A
 * @param viewsB Map of view_type -> sparse vector for symbol B
 * @param weights Record of view_type -> weight (should sum to ~1.0 for interpretability)
 * @returns Weighted similarity score in [0, 1]
 */
export function multiViewSimilarity(
    viewsA: Map<string, SparseVector>,
    viewsB: Map<string, SparseVector>,
    weights: Record<string, number>,
): number {
    let totalSimilarity = 0;
    let totalWeight = 0;

    for (const [viewType, weight] of Object.entries(weights)) {
        const vecA = viewsA.get(viewType);
        const vecB = viewsB.get(viewType);

        totalWeight += weight;

        if (vecA && vecB) {
            totalSimilarity += weight * cosineSimilarity(vecA, vecB);
        }
        // If either is missing, this view contributes 0 to the total
    }

    // Normalize by total weight to handle missing views gracefully
    if (totalWeight === 0) return 0;
    return totalSimilarity / totalWeight;
}
