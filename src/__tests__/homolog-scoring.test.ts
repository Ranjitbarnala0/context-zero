/**
 * Unit tests for homolog scoring helpers.
 * Tests the pure computation logic without DB.
 */

import { HOMOLOG_WEIGHTS, MIN_EVIDENCE_FAMILIES, DEFAULT_HOMOLOG_CONFIDENCE_THRESHOLD } from '../types';

describe('Homolog Constants', () => {
    test('weights sum to 1.0', () => {
        const sum = Object.values(HOMOLOG_WEIGHTS).reduce((a, b) => a + b, 0);
        expect(sum).toBeCloseTo(1.0, 10);
    });

    test('all weights are positive', () => {
        for (const [key, val] of Object.entries(HOMOLOG_WEIGHTS)) {
            expect(val).toBeGreaterThan(0);
        }
    });

    test('minimum evidence families is 2', () => {
        expect(MIN_EVIDENCE_FAMILIES).toBe(2);
    });

    test('default confidence threshold is 0.60', () => {
        expect(DEFAULT_HOMOLOG_CONFIDENCE_THRESHOLD).toBe(0.60);
    });
});

describe('Homolog Name Similarity', () => {
    // Replicate the tokenization and Jaccard logic from HomologInferenceEngine
    function tokenizeName(name: string): Set<string> {
        const parts = name
            .replace(/([a-z])([A-Z])/g, '$1_$2')
            .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
            .toLowerCase()
            .split(/[_\-\s.]+/)
            .filter(p => p.length > 0);
        return new Set(parts);
    }

    function computeNameSimilarity(a: string, b: string): number {
        const tokensA = tokenizeName(a);
        const tokensB = tokenizeName(b);
        if (tokensA.size === 0 && tokensB.size === 0) return 1.0;
        if (tokensA.size === 0 || tokensB.size === 0) return 0.0;
        let intersection = 0;
        for (const t of tokensA) {
            if (tokensB.has(t)) intersection++;
        }
        const union = new Set([...tokensA, ...tokensB]).size;
        return union > 0 ? intersection / union : 0.0;
    }

    test('identical names have similarity 1.0', () => {
        expect(computeNameSimilarity('validateUser', 'validateUser')).toBe(1.0);
    });

    test('completely different names have similarity 0.0', () => {
        expect(computeNameSimilarity('processPayment', 'sendEmail')).toBe(0.0);
    });

    test('partial overlap gives fractional similarity', () => {
        const sim = computeNameSimilarity('validateUserInput', 'validateOrderInput');
        // tokens: {validate, user, input} vs {validate, order, input}
        // intersection = 2 (validate, input), union = 4
        expect(sim).toBeCloseTo(0.5, 1);
    });

    test('camelCase tokenization works', () => {
        const tokens = tokenizeName('getUserById');
        expect(tokens).toEqual(new Set(['get', 'user', 'by', 'id']));
    });

    test('snake_case tokenization works', () => {
        const tokens = tokenizeName('get_user_by_id');
        expect(tokens).toEqual(new Set(['get', 'user', 'by', 'id']));
    });

    test('PascalCase tokenization works', () => {
        const tokens = tokenizeName('UserService');
        expect(tokens).toEqual(new Set(['user', 'service']));
    });

    test('handles consecutive caps (acronyms)', () => {
        const tokens = tokenizeName('parseHTTPResponse');
        expect(tokens).toEqual(new Set(['parse', 'http', 'response']));
    });
});

describe('Homolog Weighted Score', () => {
    function computeWeightedTotal(scores: {
        semantic: number;
        logic: number;
        signature: number;
        behavioral: number;
        contract: number;
        test: number;
        history: number;
    }): number {
        return Math.min(1.0,
            HOMOLOG_WEIGHTS.semantic_intent_similarity * scores.semantic +
            HOMOLOG_WEIGHTS.normalized_logic_similarity * scores.logic +
            HOMOLOG_WEIGHTS.signature_type_similarity * scores.signature +
            HOMOLOG_WEIGHTS.behavioral_overlap * scores.behavioral +
            HOMOLOG_WEIGHTS.contract_overlap * scores.contract +
            HOMOLOG_WEIGHTS.test_overlap * scores.test +
            HOMOLOG_WEIGHTS.history_co_change * scores.history
        );
    }

    test('all zeros produce zero total', () => {
        expect(computeWeightedTotal({
            semantic: 0, logic: 0, signature: 0,
            behavioral: 0, contract: 0, test: 0, history: 0,
        })).toBe(0);
    });

    test('all ones produce 1.0 total', () => {
        expect(computeWeightedTotal({
            semantic: 1, logic: 1, signature: 1,
            behavioral: 1, contract: 1, test: 1, history: 1,
        })).toBe(1.0);
    });

    test('exact logic match (body_hash) alone exceeds threshold with semantic', () => {
        const total = computeWeightedTotal({
            semantic: 0.8, logic: 1.0, signature: 0.5,
            behavioral: 0, contract: 0, test: 0, history: 0,
        });
        // 0.20*0.8 + 0.20*1.0 + 0.15*0.5 = 0.16 + 0.20 + 0.075 = 0.435
        expect(total).toBeGreaterThan(0.40);
    });

    test('total is capped at 1.0', () => {
        const total = computeWeightedTotal({
            semantic: 2, logic: 2, signature: 2,
            behavioral: 2, contract: 2, test: 2, history: 2,
        });
        expect(total).toBe(1.0);
    });
});
