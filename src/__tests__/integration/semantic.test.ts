/**
 * Integration test — Semantic Engine end-to-end.
 *
 * Validates:
 *   - Code tokenizer: camelCase/snake_case splitting, noise removal, stemming
 *   - TF-IDF computation: term frequencies, IDF calculation, L2 normalization
 *   - MinHash generation: signature length, determinism, Jaccard estimation
 *   - Cosine similarity: identical vectors, orthogonal vectors, similar code
 *   - Multi-view similarity: weighted combination across views
 *   - LSH band hash computation
 */

import {
    tokenizeName,
    tokenizeBody,
    tokenizeSignature,
    tokenizeBehavior,
    tokenizeContract,
    normalizeToken,
} from '../../semantic-engine/tokenizer';

import {
    computeTF,
    computeIDF,
    computeTFIDF,
    cosineSimilarity,
    generateMinHash,
    estimateJaccardFromMinHash,
    multiViewSimilarity,
    computeBandHashes,
    LSH_ROWS_PER_BAND,
} from '../../semantic-engine/similarity';

// ── Tokenizer Tests ────────────────────────────────────────────────

describe('Semantic Integration — Code Tokenizer', () => {
    test('tokenizeName splits camelCase identifiers', () => {
        const tokens = tokenizeName('getUserById');
        expect(tokens).toContain('get');
        expect(tokens).toContain('user');
        expect(tokens).toContain('by');
        expect(tokens).toContain('id');
    });

    test('tokenizeName splits PascalCase identifiers', () => {
        const tokens = tokenizeName('UserRepository');
        expect(tokens).toContain('user');
        expect(tokens).toContain('repo');  // 'repository' is stemmed to 'repo'
    });

    test('tokenizeName splits snake_case identifiers', () => {
        const tokens = tokenizeName('get_user_by_id');
        expect(tokens).toContain('get');
        expect(tokens).toContain('user');
        expect(tokens).toContain('by');
        expect(tokens).toContain('id');
    });

    test('tokenizeName handles SCREAMING_SNAKE_CASE', () => {
        const tokens = tokenizeName('MAX_RETRY_COUNT');
        expect(tokens).toContain('max');
        expect(tokens).toContain('retry');
        expect(tokens).toContain('count');
    });

    test('tokenizeName applies suffix stemming', () => {
        expect(tokenizeName('UserHandler')).toContain('handle');
        expect(tokenizeName('OrderService')).toContain('serve');
        expect(tokenizeName('PaymentValidator')).toContain('valid');
        expect(tokenizeName('DataSerializer')).toContain('serial');
    });

    test('normalizeToken removes trailing digits', () => {
        expect(normalizeToken('item1')).toBe('item');
        expect(normalizeToken('handler2')).toBe('handle');
    });

    test('normalizeToken rejects tokens shorter than 2 chars', () => {
        expect(normalizeToken('a')).toBe('');
        expect(normalizeToken('x')).toBe('');
    });

    test('tokenizeBody extracts identifiers and removes noise words', () => {
        const code = `
            const userId = getUserId();
            if (userId) {
                return fetchUserProfile(userId);
            }
        `;
        const tokens = tokenizeBody(code);
        // Should include meaningful identifiers
        expect(tokens).toContain('user');
        expect(tokens).toContain('id');
        // Should not include JS keywords
        expect(tokens).not.toContain('const');
        expect(tokens).not.toContain('if');
        expect(tokens).not.toContain('return');
    });

    test('tokenizeBody strips comments', () => {
        const code = `
            // This is a comment about secret keys
            const result = process();
            /* Multi-line comment
               with keywords like function and return */
        `;
        const tokens = tokenizeBody(code);
        expect(tokens).not.toContain('comment');
        expect(tokens).not.toContain('secret');
        expect(tokens).not.toContain('keys');
    });

    test('tokenizeBody strips string literals', () => {
        const code = `
            const msg = "hello world";
            const sql = 'SELECT * FROM users';
        `;
        const tokens = tokenizeBody(code);
        expect(tokens).not.toContain('hello');
        expect(tokens).not.toContain('world');
        expect(tokens).not.toContain('select');
    });

    test('tokenizeBody deduplicates tokens', () => {
        const code = `
            fetchUser(userId);
            fetchUser(userId);
            fetchUser(userId);
        `;
        const tokens = tokenizeBody(code);
        const fetchCount = tokens.filter(t => t === 'fetch').length;
        expect(fetchCount).toBeLessThanOrEqual(1);
    });

    test('tokenizeSignature extracts parameter and type info', () => {
        const sig = 'createOrder(userId: string, items: OrderItem[]): Promise<Order>';
        const tokens = tokenizeSignature(sig);
        expect(tokens).toContain('create');
        expect(tokens).toContain('order');
        expect(tokens).toContain('user');
        expect(tokens).toContain('id');
        expect(tokens).toContain('items');
    });

    test('tokenizeBehavior processes hint types and details', () => {
        const hints = [
            { hint_type: 'db_read', detail: 'users_table' },
            { hint_type: 'network_call', detail: 'external_api' },
        ];
        const tokens = tokenizeBehavior(hints);
        expect(tokens).toContain('db');
        expect(tokens).toContain('read');
        expect(tokens).toContain('network');
        expect(tokens).toContain('call');
        expect(tokens).toContain('users');
        expect(tokens).toContain('table');
    });

    test('tokenizeContract processes type signatures', () => {
        const hint = {
            input_types: ['string', 'OrderInput'],
            output_type: 'Promise<OrderResult>',
            thrown_types: ['ValidationError'],
            decorators: ['@Post("/orders")'],
        };
        const tokens = tokenizeContract(hint);
        expect(tokens).toContain('order');
        expect(tokens).toContain('input');
        expect(tokens).toContain('result');
        expect(tokens).toContain('validation');
    });
});

// ── TF-IDF Tests ───────────────────────────────────────────────────

describe('Semantic Integration — TF-IDF Computation', () => {
    test('computeTF yields 1 + log(count) for each token', () => {
        const tokens = ['user', 'get', 'user', 'user'];
        const tf = computeTF(tokens);

        // 'user' appears 3 times: TF = 1 + log(3)
        expect(tf['user']).toBeCloseTo(1 + Math.log(3), 5);
        // 'get' appears 1 time: TF = 1 + log(1) = 1
        expect(tf['get']).toBeCloseTo(1.0, 5);
    });

    test('computeTF handles single-token input', () => {
        const tf = computeTF(['only']);
        expect(tf['only']).toBeCloseTo(1.0, 5);
    });

    test('computeIDF uses smooth IDF formula', () => {
        const docs = [
            new Set(['user', 'get']),
            new Set(['user', 'set']),
            new Set(['order', 'get']),
        ];
        const idf = computeIDF(docs, 3);

        // 'user' appears in 2 of 3 docs: IDF = log(1 + 3 / (1 + 2))
        expect(idf['user']).toBeCloseTo(Math.log(1 + 3 / (1 + 2)), 5);
        // 'order' appears in 1 of 3 docs: IDF = log(1 + 3 / (1 + 1))
        expect(idf['order']).toBeCloseTo(Math.log(1 + 3 / (1 + 1)), 5);
    });

    test('computeTFIDF produces L2-normalized vectors', () => {
        const tf = computeTF(['alpha', 'beta', 'gamma']);
        const idf = { alpha: 1.5, beta: 2.0, gamma: 0.8 };
        const tfidf = computeTFIDF(tf, idf);

        // Verify L2 norm is 1.0
        let magnitude = 0;
        for (const val of Object.values(tfidf)) {
            magnitude += val * val;
        }
        expect(Math.sqrt(magnitude)).toBeCloseTo(1.0, 5);
    });

    test('computeTFIDF uses default IDF of 1.0 for missing tokens', () => {
        const tf = { 'rare_token': 1.0 };
        const idf = {}; // no entries
        const tfidf = computeTFIDF(tf, idf);

        // Should still produce a non-zero value using default IDF = 1.0
        expect(tfidf['rare_token']).toBeGreaterThan(0);
    });

    test('computeTFIDF returns empty-like vector for empty input', () => {
        const tf = computeTF([]);
        const idf = {};
        const tfidf = computeTFIDF(tf, idf);
        expect(Object.keys(tfidf).length).toBe(0);
    });
});

// ── Cosine Similarity Tests ────────────────────────────────────────

describe('Semantic Integration — Cosine Similarity', () => {
    test('identical vectors have similarity 1.0', () => {
        const vec = { a: 0.5, b: 0.5, c: 0.7071 };
        expect(cosineSimilarity(vec, vec)).toBeCloseTo(
            0.5 * 0.5 + 0.5 * 0.5 + 0.7071 * 0.7071, 3
        );
    });

    test('orthogonal vectors have similarity 0.0', () => {
        const vecA = { a: 1.0 };
        const vecB = { b: 1.0 };
        expect(cosineSimilarity(vecA, vecB)).toBe(0);
    });

    test('completely disjoint token spaces give similarity 0.0', () => {
        const vecA = { foo: 0.5, bar: 0.5 };
        const vecB = { baz: 0.5, qux: 0.5 };
        expect(cosineSimilarity(vecA, vecB)).toBe(0);
    });

    test('similar code produces higher similarity than different code', () => {
        // Simulate TF-IDF vectors for similar functions
        const fetchUserVec = computeTFIDF(
            computeTF(tokenizeBody('const user = await db.findById(userId); return user;')),
            {}
        );
        const getUserVec = computeTFIDF(
            computeTF(tokenizeBody('const user = await db.findOne(userId); return user;')),
            {}
        );
        const sendEmailVec = computeTFIDF(
            computeTF(tokenizeBody('const template = loadTemplate(); await smtp.send(template);')),
            {}
        );

        const similarScore = cosineSimilarity(fetchUserVec, getUserVec);
        const differentScore = cosineSimilarity(fetchUserVec, sendEmailVec);

        expect(similarScore).toBeGreaterThan(differentScore);
    });

    test('empty vectors produce zero similarity', () => {
        expect(cosineSimilarity({}, {})).toBe(0);
        expect(cosineSimilarity({ a: 1.0 }, {})).toBe(0);
    });

    test('similarity is clamped to [0, 1]', () => {
        // L2-normalized unit vectors: dot product should be at most 1.0
        const vec = { a: 1.0 };
        const score = cosineSimilarity(vec, vec);
        expect(score).toBeLessThanOrEqual(1.0);
        expect(score).toBeGreaterThanOrEqual(0);
    });
});

// ── MinHash Tests ──────────────────────────────────────────────────

describe('Semantic Integration — MinHash Generation', () => {
    test('generates signature of requested length', () => {
        const tokens = new Set(['alpha', 'beta', 'gamma', 'delta']);
        const sig = generateMinHash(tokens, 128);
        expect(sig.length).toBe(128);
    });

    test('generates deterministic signatures', () => {
        const tokens = new Set(['user', 'get', 'profile']);
        const sig1 = generateMinHash(tokens, 64);
        const sig2 = generateMinHash(tokens, 64);
        expect(sig1).toEqual(sig2);
    });

    test('identical token sets produce identical signatures', () => {
        const setA = new Set(['x', 'y', 'z']);
        const setB = new Set(['z', 'x', 'y']); // same elements, different order
        const sigA = generateMinHash(setA, 128);
        const sigB = generateMinHash(setB, 128);
        expect(sigA).toEqual(sigB);
    });

    test('completely different token sets produce low Jaccard estimate', () => {
        const setA = new Set(['alpha', 'beta', 'gamma', 'delta', 'epsilon']);
        const setB = new Set(['one', 'two', 'three', 'four', 'five']);
        const sigA = generateMinHash(setA, 128);
        const sigB = generateMinHash(setB, 128);
        const jaccard = estimateJaccardFromMinHash(sigA, sigB);
        expect(jaccard).toBeLessThan(0.3);
    });

    test('identical token sets produce Jaccard estimate of 1.0', () => {
        const tokens = new Set(['user', 'service', 'handler']);
        const sig = generateMinHash(tokens, 128);
        const jaccard = estimateJaccardFromMinHash(sig, sig);
        expect(jaccard).toBe(1.0);
    });

    test('overlapping sets produce intermediate Jaccard estimate', () => {
        // Sets with 50% overlap should give roughly 0.33 Jaccard
        // (intersection=2, union=6 for these distinct tokens)
        const setA = new Set(['a', 'b', 'c', 'd']);
        const setB = new Set(['c', 'd', 'e', 'f']);
        const sigA = generateMinHash(setA, 128);
        const sigB = generateMinHash(setB, 128);
        const jaccard = estimateJaccardFromMinHash(sigA, sigB);
        // True Jaccard = 2/6 = 0.333
        expect(jaccard).toBeGreaterThan(0.1);
        expect(jaccard).toBeLessThan(0.7);
    });

    test('empty token set produces max-value signature', () => {
        const sig = generateMinHash(new Set(), 64);
        expect(sig.length).toBe(64);
        // All values should be 0xFFFFFFFF (the fill value)
        for (const val of sig) {
            expect(val).toBe(0xFFFFFFFF);
        }
    });

    test('signature values are 32-bit unsigned integers', () => {
        const tokens = new Set(['hello', 'world', 'test']);
        const sig = generateMinHash(tokens, 128);
        for (const val of sig) {
            expect(val).toBeGreaterThanOrEqual(0);
            expect(val).toBeLessThanOrEqual(0xFFFFFFFF);
        }
    });

    test('respects MAX_PERMUTATIONS cap at 256', () => {
        const tokens = new Set(['a', 'b']);
        const sig = generateMinHash(tokens, 512);
        expect(sig.length).toBe(256);
    });
});

// ── Multi-View Similarity Tests ────────────────────────────────────

describe('Semantic Integration — Multi-View Similarity', () => {
    test('identical views across all types produce high score', () => {
        const vec = { shared: 0.7, token: 0.7 };
        const viewsA = new Map<string, Record<string, number>>([
            ['name', vec],
            ['body', vec],
            ['signature', vec],
        ]);
        const viewsB = new Map<string, Record<string, number>>([
            ['name', vec],
            ['body', vec],
            ['signature', vec],
        ]);
        const weights = { name: 0.33, body: 0.34, signature: 0.33 };
        const score = multiViewSimilarity(viewsA, viewsB, weights);
        expect(score).toBeGreaterThan(0.5);
    });

    test('missing views contribute zero to weighted score', () => {
        const vec = { token: 1.0 };
        const viewsA = new Map([['name', vec]]);
        const viewsB = new Map([['body', vec]]);
        const weights = { name: 0.5, body: 0.5 };
        const score = multiViewSimilarity(viewsA, viewsB, weights);
        // Neither view is present in both maps -> score = 0
        expect(score).toBe(0);
    });

    test('weighted combination respects weight ratios', () => {
        const perfectMatch = { same: 1.0 };
        const noMatch = { diff: 1.0 };
        const viewsA = new Map([
            ['name', perfectMatch],
            ['body', noMatch],
        ]);
        const viewsB = new Map([
            ['name', perfectMatch],
            ['body', { other: 1.0 }],
        ]);
        const weights = { name: 0.8, body: 0.2 };
        const score = multiViewSimilarity(viewsA, viewsB, weights);
        // name matches perfectly (cosine ~1), body has no overlap (cosine ~0)
        // score = (0.8 * 1.0 + 0.2 * 0.0) / (0.8 + 0.2) = 0.8
        expect(score).toBeCloseTo(0.8, 1);
    });

    test('empty weights produce zero similarity', () => {
        const vec = { token: 1.0 };
        const viewsA = new Map([['name', vec]]);
        const viewsB = new Map([['name', vec]]);
        const score = multiViewSimilarity(viewsA, viewsB, {});
        expect(score).toBe(0);
    });
});

// ── LSH Band Hash Tests ────────────────────────────────────────────

describe('Semantic Integration — LSH Band Hashes', () => {
    test('produces correct number of bands', () => {
        const sig = generateMinHash(new Set(['a', 'b', 'c']), 128);
        const bands = computeBandHashes(sig, LSH_ROWS_PER_BAND);
        // 128 / 8 = 16 bands
        expect(bands.length).toBe(16);
    });

    test('identical signatures produce identical band hashes', () => {
        const tokens = new Set(['user', 'service', 'handler']);
        const sig = generateMinHash(tokens, 128);
        const bands1 = computeBandHashes(sig, LSH_ROWS_PER_BAND);
        const bands2 = computeBandHashes(sig, LSH_ROWS_PER_BAND);
        expect(bands1).toEqual(bands2);
    });

    test('different signatures produce mostly different band hashes', () => {
        const sigA = generateMinHash(new Set(['alpha', 'beta']), 128);
        const sigB = generateMinHash(new Set(['gamma', 'delta']), 128);
        const bandsA = computeBandHashes(sigA, LSH_ROWS_PER_BAND);
        const bandsB = computeBandHashes(sigB, LSH_ROWS_PER_BAND);

        let matchCount = 0;
        for (let i = 0; i < bandsA.length; i++) {
            if (bandsA[i] === bandsB[i]) matchCount++;
        }
        // Mostly different
        expect(matchCount).toBeLessThan(bandsA.length);
    });

    test('band hashes are 32-bit signed integers (PostgreSQL compatible)', () => {
        const sig = generateMinHash(new Set(['test', 'data']), 128);
        const bands = computeBandHashes(sig);
        for (const hash of bands) {
            // Signed 32-bit range: [-2147483648, 2147483647]
            expect(hash).toBeGreaterThanOrEqual(-2147483648);
            expect(hash).toBeLessThanOrEqual(2147483647);
        }
    });

    test('custom rows-per-band controls granularity', () => {
        const sig = generateMinHash(new Set(['a', 'b', 'c']), 128);
        const bands4 = computeBandHashes(sig, 4);   // 32 bands
        const bands16 = computeBandHashes(sig, 16); // 8 bands
        expect(bands4.length).toBe(32);
        expect(bands16.length).toBe(8);
    });

    test('identical signatures share all band hashes', () => {
        const tokens = new Set(['user', 'service', 'get', 'fetch', 'query', 'database',
            'handler', 'request', 'response', 'validate']);
        const sig = generateMinHash(tokens, 128);
        const bandsA = computeBandHashes(sig, LSH_ROWS_PER_BAND);
        const bandsB = computeBandHashes(sig, LSH_ROWS_PER_BAND);

        let sharedBands = 0;
        for (let i = 0; i < bandsA.length; i++) {
            if (bandsA[i] === bandsB[i]) sharedBands++;
        }
        expect(sharedBands).toBe(bandsA.length);
    });

    test('highly overlapping token sets share some MinHash positions', () => {
        // Sets with very high overlap: 18 shared out of 20 tokens (Jaccard = 18/22 ~ 0.82)
        const shared = Array.from({ length: 18 }, (_, i) => `token_${i}`);
        const setA = new Set([...shared, 'unique_a1', 'unique_a2']);
        const setB = new Set([...shared, 'unique_b1', 'unique_b2']);

        const sigA = generateMinHash(setA, 128);
        const sigB = generateMinHash(setB, 128);
        const jaccard = estimateJaccardFromMinHash(sigA, sigB);

        // With true Jaccard ~0.82, the estimated Jaccard should be high
        expect(jaccard).toBeGreaterThan(0.5);
    });
});

// ── End-to-End: Tokenize → TF-IDF → Cosine ────────────────────────

describe('Semantic Integration — Full Pipeline', () => {
    test('similar function bodies produce higher cosine similarity than dissimilar ones', () => {
        const codeA = `
            async function getUserProfile(userId) {
                const user = await db.findOne({ id: userId });
                if (!user) throw new Error('Not found');
                return user.profile;
            }
        `;
        const codeB = `
            async function fetchUserDetails(uid) {
                const result = await db.findOne({ id: uid });
                if (!result) throw new Error('Missing');
                return result.details;
            }
        `;
        const codeC = `
            function calculateTax(amount, rate) {
                const tax = amount * rate;
                const total = amount + tax;
                return { tax, total };
            }
        `;

        const tokensA = tokenizeBody(codeA);
        const tokensB = tokenizeBody(codeB);
        const tokensC = tokenizeBody(codeC);

        const allDocs = [new Set(tokensA), new Set(tokensB), new Set(tokensC)];
        const idf = computeIDF(allDocs, 3);

        const vecA = computeTFIDF(computeTF(tokensA), idf);
        const vecB = computeTFIDF(computeTF(tokensB), idf);
        const vecC = computeTFIDF(computeTF(tokensC), idf);

        const simAB = cosineSimilarity(vecA, vecB);
        const simAC = cosineSimilarity(vecA, vecC);

        // getUserProfile and fetchUserDetails are semantically similar
        // calculateTax is completely different
        expect(simAB).toBeGreaterThan(simAC);
    });

    test('name tokenization feeds into consistent TF-IDF vectors', () => {
        const nameTokensA = tokenizeName('processPaymentOrder');
        const nameTokensB = tokenizeName('handlePaymentTransaction');

        const allDocs = [new Set(nameTokensA), new Set(nameTokensB)];
        const idf = computeIDF(allDocs, 2);

        const vecA = computeTFIDF(computeTF(nameTokensA), idf);
        const vecB = computeTFIDF(computeTF(nameTokensB), idf);

        // Both share 'payment' so cosine similarity > 0
        const sim = cosineSimilarity(vecA, vecB);
        expect(sim).toBeGreaterThan(0);
    });
});
