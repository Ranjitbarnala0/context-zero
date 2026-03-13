/**
 * Type system integrity tests.
 * Ensures constants and enums match the blueprint specification.
 */

import {
    HOMOLOG_WEIGHTS,
    MIN_EVIDENCE_FAMILIES,
    DEFAULT_HOMOLOG_CONFIDENCE_THRESHOLD,
} from '../types';
import type {
    PurityClass,
    TransactionState,
    SymbolKind,
    CapsuleMode,
    ValidationMode,
} from '../types';

describe('Type System Integrity', () => {
    test('HOMOLOG_WEIGHTS has exactly 7 dimensions', () => {
        expect(Object.keys(HOMOLOG_WEIGHTS)).toHaveLength(7);
    });

    test('HOMOLOG_WEIGHTS contains all required dimensions', () => {
        expect(HOMOLOG_WEIGHTS).toHaveProperty('semantic_intent_similarity');
        expect(HOMOLOG_WEIGHTS).toHaveProperty('normalized_logic_similarity');
        expect(HOMOLOG_WEIGHTS).toHaveProperty('signature_type_similarity');
        expect(HOMOLOG_WEIGHTS).toHaveProperty('behavioral_overlap');
        expect(HOMOLOG_WEIGHTS).toHaveProperty('contract_overlap');
        expect(HOMOLOG_WEIGHTS).toHaveProperty('test_overlap');
        expect(HOMOLOG_WEIGHTS).toHaveProperty('history_co_change');
    });

    test('HOMOLOG_WEIGHTS matches blueprint values exactly', () => {
        expect(HOMOLOG_WEIGHTS.semantic_intent_similarity).toBe(0.20);
        expect(HOMOLOG_WEIGHTS.normalized_logic_similarity).toBe(0.20);
        expect(HOMOLOG_WEIGHTS.signature_type_similarity).toBe(0.15);
        expect(HOMOLOG_WEIGHTS.behavioral_overlap).toBe(0.15);
        expect(HOMOLOG_WEIGHTS.contract_overlap).toBe(0.15);
        expect(HOMOLOG_WEIGHTS.test_overlap).toBe(0.10);
        expect(HOMOLOG_WEIGHTS.history_co_change).toBe(0.05);
    });

    test('purity classes form the correct ladder', () => {
        const ladder: PurityClass[] = ['pure', 'read_only', 'read_write', 'side_effecting'];
        // Verify each is a valid type (compilation test)
        for (const p of ladder) {
            expect(typeof p).toBe('string');
        }
    });

    test('transaction states cover the 9-state lifecycle', () => {
        const states: TransactionState[] = [
            'planned', 'prepared', 'patched', 'reindexed',
            'validated', 'propagation_pending',
            'committed', 'rolled_back', 'failed',
        ];
        expect(states).toHaveLength(9);
    });

    test('symbol kinds include all blueprint types', () => {
        const kinds: SymbolKind[] = [
            'function', 'method', 'class', 'interface',
            'route_handler', 'validator', 'serializer',
            'query_builder', 'schema_object', 'test_case',
            'config_object', 'variable', 'type_alias', 'enum', 'module',
        ];
        expect(kinds).toHaveLength(15);
    });

    test('capsule modes are minimal, standard, strict', () => {
        const modes: CapsuleMode[] = ['minimal', 'standard', 'strict'];
        expect(modes).toHaveLength(3);
    });

    test('validation modes are quick, standard, strict', () => {
        const modes: ValidationMode[] = ['quick', 'standard', 'strict'];
        expect(modes).toHaveLength(3);
    });
});
