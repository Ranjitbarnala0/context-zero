/**
 * Unit tests for the Behavioral Engine.
 * Tests purity classification logic without DB dependency.
 */

import { BehavioralEngine } from '../analysis-engine/behavioral';
import type { BehaviorHint, BehavioralProfile, PurityClass } from '../types';

// Access private method via prototype for testing
const engine = new BehavioralEngine();
const classifyPurity = (engine as any).classifyPurity.bind(engine);

describe('BehavioralEngine — Purity Classification', () => {
    const baseSignals = {
        hasNetworkCalls: false,
        hasTransactions: false,
        hasDbWrites: false,
        hasStateMutations: false,
        hasFileIo: false,
        hasCacheOps: false,
        hasDbReads: false,
        hasAuthOps: false,
    };

    test('pure: no I/O at all', () => {
        expect(classifyPurity({ ...baseSignals })).toBe('pure');
    });

    test('read_only: only DB reads', () => {
        expect(classifyPurity({ ...baseSignals, hasDbReads: true })).toBe('read_only');
    });

    test('read_only: only cache operations', () => {
        expect(classifyPurity({ ...baseSignals, hasCacheOps: true })).toBe('read_only');
    });

    test('read_only: only auth checks', () => {
        expect(classifyPurity({ ...baseSignals, hasAuthOps: true })).toBe('read_only');
    });

    test('read_write: DB writes present', () => {
        expect(classifyPurity({ ...baseSignals, hasDbWrites: true })).toBe('read_write');
    });

    test('read_write: state mutations present', () => {
        expect(classifyPurity({ ...baseSignals, hasStateMutations: true })).toBe('read_write');
    });

    test('read_write: file I/O present', () => {
        expect(classifyPurity({ ...baseSignals, hasFileIo: true })).toBe('read_write');
    });

    test('read_write: DB writes + DB reads = read_write (not side_effecting)', () => {
        expect(classifyPurity({
            ...baseSignals,
            hasDbWrites: true,
            hasDbReads: true,
        })).toBe('read_write');
    });

    test('side_effecting: network calls always escalate', () => {
        expect(classifyPurity({ ...baseSignals, hasNetworkCalls: true })).toBe('side_effecting');
    });

    test('side_effecting: transactions always escalate', () => {
        expect(classifyPurity({ ...baseSignals, hasTransactions: true })).toBe('side_effecting');
    });

    test('side_effecting: network + reads = still side_effecting', () => {
        expect(classifyPurity({
            ...baseSignals,
            hasNetworkCalls: true,
            hasDbReads: true,
        })).toBe('side_effecting');
    });

    test('side_effecting: transaction + writes = still side_effecting', () => {
        expect(classifyPurity({
            ...baseSignals,
            hasTransactions: true,
            hasDbWrites: true,
        })).toBe('side_effecting');
    });
});

describe('BehavioralEngine — compareBehavior', () => {
    const makeProfile = (overrides: Partial<BehavioralProfile>): BehavioralProfile => ({
        behavior_profile_id: 'test',
        symbol_version_id: 'test',
        purity_class: 'pure',
        resource_touches: [],
        db_reads: [],
        db_writes: [],
        network_calls: [],
        cache_ops: [],
        file_io: [],
        auth_operations: [],
        validation_operations: [],
        exception_profile: [],
        state_mutation_profile: [],
        transaction_profile: [],
        ...overrides,
    });

    test('detects purity escalation', () => {
        const before = makeProfile({ purity_class: 'read_only' });
        const after = makeProfile({ purity_class: 'side_effecting' });
        const result = engine.compareBehavior(before, after);

        expect(result.purityChanged).toBe(true);
        expect(result.purityDirection).toBe('escalated');
    });

    test('detects purity de-escalation', () => {
        const before = makeProfile({ purity_class: 'read_write' });
        const after = makeProfile({ purity_class: 'pure' });
        const result = engine.compareBehavior(before, after);

        expect(result.purityChanged).toBe(true);
        expect(result.purityDirection).toBe('deescalated');
    });

    test('detects unchanged purity', () => {
        const before = makeProfile({ purity_class: 'read_only' });
        const after = makeProfile({ purity_class: 'read_only' });
        const result = engine.compareBehavior(before, after);

        expect(result.purityChanged).toBe(false);
        expect(result.purityDirection).toBe('unchanged');
    });

    test('detects new resource touches', () => {
        const before = makeProfile({ resource_touches: ['db:read:users'] });
        const after = makeProfile({ resource_touches: ['db:read:users', 'network:api'] });
        const result = engine.compareBehavior(before, after);

        expect(result.newResourceTouches).toEqual(['network:api']);
        expect(result.removedResourceTouches).toEqual([]);
    });

    test('detects side effects changes', () => {
        const before = makeProfile({ network_calls: [] });
        const after = makeProfile({ network_calls: ['fetch:api.example.com'] });
        const result = engine.compareBehavior(before, after);

        expect(result.sideEffectsChanged).toBe(true);
    });
});
