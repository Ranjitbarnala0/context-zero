/**
 * Integration test — Transactional Editor State Machine.
 *
 * Validates:
 *   - Valid state transitions through the full lifecycle
 *   - Invalid state transition rejection
 *   - Rollback from any state
 *   - Transaction creation and loading
 *   - State machine invariants (terminal states, transition completeness)
 *   - Contract/behavioral comparison logic used by the validation engine
 */

import { TransactionalChangeEngine } from '../../transactional-editor/index';
import { BehavioralEngine } from '../../analysis-engine/behavioral';
import { ContractEngine } from '../../analysis-engine/contracts';
import type { TransactionState, BehavioralProfile, ContractProfile } from '../../types';

// ── DB Mock ─────────────────────────────────────────────────────────

const mockQuery = jest.fn();
const mockTransaction = jest.fn();
const mockBatchInsert = jest.fn();
const mockQueryWithClient = jest.fn();

jest.mock('../../db-driver', () => ({
    db: {
        query: (...args: unknown[]) => mockQuery(...args),
        batchInsert: (...args: unknown[]) => mockBatchInsert(...args),
        transaction: (...args: unknown[]) => mockTransaction(...args),
        queryWithClient: (...args: unknown[]) => mockQueryWithClient(...args),
    },
}));

jest.mock('../../db-driver/core_data', () => ({
    coreDataService: {
        upsertBehavioralProfile: jest.fn().mockResolvedValue('bp-id'),
        upsertContractProfile: jest.fn().mockResolvedValue('cp-id'),
    },
}));

jest.mock('../../transactional-editor/sandbox', () => ({
    sandboxExec: jest.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    sandboxTypeCheck: jest.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    sandboxRunTests: jest.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
}));

// ── Helpers ─────────────────────────────────────────────────────────

/** Valid state transitions — replicated from the engine for assertion */
const VALID_TRANSITIONS: Record<TransactionState, TransactionState[]> = {
    planned:               ['prepared', 'failed', 'rolled_back'],
    prepared:              ['patched', 'failed', 'rolled_back'],
    patched:               ['reindexed', 'failed', 'rolled_back'],
    reindexed:             ['validated', 'failed', 'rolled_back'],
    validated:             ['propagation_pending', 'committed', 'failed', 'rolled_back'],
    propagation_pending:   ['committed', 'failed', 'rolled_back'],
    committed:             [],
    rolled_back:           [],
    failed:                ['rolled_back'],
};

const ALL_STATES: TransactionState[] = [
    'planned', 'prepared', 'patched', 'reindexed',
    'validated', 'propagation_pending',
    'committed', 'rolled_back', 'failed',
];

function makeTransactionRow(state: TransactionState, overrides?: Record<string, unknown>) {
    return {
        txn_id: 'txn-001',
        repo_id: 'repo-001',
        base_snapshot_id: 'snap-001',
        created_by: 'test-user',
        state,
        target_symbol_versions: ['sv-001', 'sv-002'],
        patches: [],
        impact_report_ref: null,
        validation_report_ref: null,
        propagation_report_ref: null,
        created_at: new Date(),
        updated_at: new Date(),
        ...overrides,
    };
}

// ── Tests: State Transition Matrix ──────────────────────────────────

describe('Transactional Integration — State Transition Matrix', () => {
    test('all states are defined in the transition map', () => {
        for (const state of ALL_STATES) {
            expect(VALID_TRANSITIONS[state]).toBeDefined();
        }
    });

    test('committed is a terminal state (no outbound transitions)', () => {
        expect(VALID_TRANSITIONS['committed']).toEqual([]);
    });

    test('rolled_back is a terminal state (no outbound transitions)', () => {
        expect(VALID_TRANSITIONS['rolled_back']).toEqual([]);
    });

    test('failed state can only transition to rolled_back', () => {
        expect(VALID_TRANSITIONS['failed']).toEqual(['rolled_back']);
    });

    test('every non-terminal state can reach rolled_back', () => {
        const nonTerminal: TransactionState[] = [
            'planned', 'prepared', 'patched', 'reindexed',
            'validated', 'propagation_pending', 'failed',
        ];
        for (const state of nonTerminal) {
            expect(VALID_TRANSITIONS[state]).toContain('rolled_back');
        }
    });

    test('every non-terminal, non-failed state can reach failed', () => {
        const states: TransactionState[] = [
            'planned', 'prepared', 'patched', 'reindexed',
            'validated', 'propagation_pending',
        ];
        for (const state of states) {
            expect(VALID_TRANSITIONS[state]).toContain('failed');
        }
    });

    test('happy path transitions form a valid chain', () => {
        const happyPath: TransactionState[] = [
            'planned', 'prepared', 'patched', 'reindexed', 'validated', 'committed',
        ];
        for (let i = 0; i < happyPath.length - 1; i++) {
            const from = happyPath[i]!;
            const to = happyPath[i + 1]!;
            expect(VALID_TRANSITIONS[from]).toContain(to);
        }
    });

    test('propagation_pending path transitions are valid', () => {
        const propPath: TransactionState[] = [
            'planned', 'prepared', 'patched', 'reindexed',
            'validated', 'propagation_pending', 'committed',
        ];
        for (let i = 0; i < propPath.length - 1; i++) {
            const from = propPath[i]!;
            const to = propPath[i + 1]!;
            expect(VALID_TRANSITIONS[from]).toContain(to);
        }
    });
});

// ── Tests: Engine State Machine Logic ───────────────────────────────

describe('Transactional Integration — Engine State Machine', () => {
    const engine = new TransactionalChangeEngine();

    beforeEach(() => {
        mockQuery.mockReset();
        mockTransaction.mockReset();
        mockBatchInsert.mockReset();
    });

    test('createTransaction inserts with planned state', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT

        const txnId = await engine.createTransaction(
            'repo-001', 'snap-001', 'test-user', ['sv-001']
        );

        expect(txnId).toBeDefined();
        expect(txnId.length).toBeGreaterThan(0);
        expect(mockQuery).toHaveBeenCalledWith(
            expect.stringContaining("'planned'"),
            expect.any(Array)
        );
    });

    test('getTransaction returns transaction row from DB', async () => {
        mockQuery.mockResolvedValueOnce({
            rows: [makeTransactionRow('planned')],
            rowCount: 1,
        });

        const txn = await engine.getTransaction('txn-001');
        expect(txn).toBeDefined();
        expect(txn!.state).toBe('planned');
        expect(txn!.txn_id).toBe('txn-001');
    });

    test('getTransaction returns null for missing transaction', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const txn = await engine.getTransaction('nonexistent');
        expect(txn).toBeNull();
    });

    test('commit transitions from validated to committed', async () => {
        // First call: loadTransaction
        mockQuery.mockResolvedValueOnce({
            rows: [makeTransactionRow('validated')],
            rowCount: 1,
        });
        // Second call: transitionState — load current state
        mockQuery.mockResolvedValueOnce({
            rows: [{ state: 'validated' }],
            rowCount: 1,
        });
        // Third call: UPDATE state
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
        // Fourth call: DELETE backups
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        await expect(engine.commit('txn-001')).resolves.not.toThrow();
    });

    test('commit rejects from planned state', async () => {
        mockQuery.mockResolvedValueOnce({
            rows: [makeTransactionRow('planned')],
            rowCount: 1,
        });

        await expect(engine.commit('txn-001')).rejects.toThrow('Invalid state transition');
    });

    test('commit rejects from rolled_back state', async () => {
        mockQuery.mockResolvedValueOnce({
            rows: [makeTransactionRow('rolled_back')],
            rowCount: 1,
        });

        await expect(engine.commit('txn-001')).rejects.toThrow('Invalid state transition');
    });

    test('rollback restores file backups and transitions to rolled_back', async () => {
        // loadTransaction
        mockQuery.mockResolvedValueOnce({
            rows: [makeTransactionRow('patched')],
            rowCount: 1,
        });
        // SELECT backups
        mockQuery.mockResolvedValueOnce({
            rows: [],
            rowCount: 0,
        });
        // DELETE backups
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        // transitionState — load current state
        mockQuery.mockResolvedValueOnce({
            rows: [{ state: 'patched' }],
            rowCount: 1,
        });
        // UPDATE state
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

        await expect(engine.rollback('txn-001')).resolves.not.toThrow();
    });

    test('rollback rejects from committed state', async () => {
        // loadTransaction
        mockQuery.mockResolvedValueOnce({
            rows: [makeTransactionRow('committed')],
            rowCount: 1,
        });
        // SELECT backups
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        // DELETE backups
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        // transitionState — load current state
        mockQuery.mockResolvedValueOnce({
            rows: [{ state: 'committed' }],
            rowCount: 1,
        });

        await expect(engine.rollback('txn-001')).rejects.toThrow('Invalid state transition');
    });
});

// ── Tests: Invalid State Transitions ────────────────────────────────

describe('Transactional Integration — Invalid Transitions', () => {
    test('cannot transition from committed to any state', () => {
        for (const target of ALL_STATES) {
            if (target === 'committed') continue;
            expect(VALID_TRANSITIONS['committed']).not.toContain(target);
        }
    });

    test('cannot transition from rolled_back to any state', () => {
        for (const target of ALL_STATES) {
            if (target === 'rolled_back') continue;
            expect(VALID_TRANSITIONS['rolled_back']).not.toContain(target);
        }
    });

    test('cannot skip from planned directly to validated', () => {
        expect(VALID_TRANSITIONS['planned']).not.toContain('validated');
    });

    test('cannot skip from planned directly to committed', () => {
        expect(VALID_TRANSITIONS['planned']).not.toContain('committed');
    });

    test('cannot skip from prepared directly to reindexed', () => {
        expect(VALID_TRANSITIONS['prepared']).not.toContain('reindexed');
    });

    test('cannot transition from patched directly to committed', () => {
        expect(VALID_TRANSITIONS['patched']).not.toContain('committed');
    });

    test('cannot transition from reindexed directly to committed', () => {
        expect(VALID_TRANSITIONS['reindexed']).not.toContain('committed');
    });

    test('failed cannot transition to committed', () => {
        expect(VALID_TRANSITIONS['failed']).not.toContain('committed');
    });

    test('failed cannot transition to validated', () => {
        expect(VALID_TRANSITIONS['failed']).not.toContain('validated');
    });
});

// ── Tests: Behavioral & Contract Comparison (used by validation) ────

describe('Transactional Integration — Behavioral Delta Detection', () => {
    const behaviorEngine = new BehavioralEngine();

    const makeProfile = (overrides: Partial<BehavioralProfile>): BehavioralProfile => ({
        behavior_profile_id: 'bp-test',
        symbol_version_id: 'sv-test',
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

    test('detects purity escalation from pure to side_effecting', () => {
        const before = makeProfile({ purity_class: 'pure' });
        const after = makeProfile({ purity_class: 'side_effecting', network_calls: ['fetch'] });
        const result = behaviorEngine.compareBehavior(before, after);

        expect(result.purityChanged).toBe(true);
        expect(result.purityDirection).toBe('escalated');
        expect(result.sideEffectsChanged).toBe(true);
    });

    test('detects new resource touches added by a patch', () => {
        const before = makeProfile({
            purity_class: 'read_only',
            resource_touches: ['db:read:users'],
            db_reads: ['users'],
        });
        const after = makeProfile({
            purity_class: 'read_write',
            resource_touches: ['db:read:users', 'db:write:users', 'network:api'],
            db_reads: ['users'],
            db_writes: ['users'],
            network_calls: ['api'],
        });
        const result = behaviorEngine.compareBehavior(before, after);

        expect(result.newResourceTouches).toContain('db:write:users');
        expect(result.newResourceTouches).toContain('network:api');
        expect(result.newResourceTouches.length).toBe(2);
    });

    test('detects removed resource touches', () => {
        const before = makeProfile({
            resource_touches: ['db:read:users', 'cache:sessions'],
        });
        const after = makeProfile({
            resource_touches: ['db:read:users'],
        });
        const result = behaviorEngine.compareBehavior(before, after);

        expect(result.removedResourceTouches).toContain('cache:sessions');
    });

    test('unchanged profiles report no changes', () => {
        const profile = makeProfile({
            purity_class: 'read_only',
            resource_touches: ['db:read:users'],
            db_reads: ['users'],
        });
        const result = behaviorEngine.compareBehavior(profile, profile);

        expect(result.purityChanged).toBe(false);
        expect(result.purityDirection).toBe('unchanged');
        expect(result.newResourceTouches).toEqual([]);
        expect(result.removedResourceTouches).toEqual([]);
        expect(result.sideEffectsChanged).toBe(false);
    });
});

describe('Transactional Integration — Contract Delta Detection', () => {
    const contractEngine = new ContractEngine();

    const makeContract = (overrides: Partial<ContractProfile>): ContractProfile => ({
        contract_profile_id: 'cp-test',
        symbol_version_id: 'sv-test',
        input_contract: '(userId: string)',
        output_contract: 'Promise<User>',
        error_contract: 'NotFoundError',
        schema_refs: [],
        api_contract_refs: [],
        serialization_contract: 'none',
        security_contract: 'none',
        derived_invariants_count: 0,
        ...overrides,
    });

    test('detects input contract changes', () => {
        const before = makeContract({ input_contract: '(userId: string)' });
        const after = makeContract({ input_contract: '(userId: string, options: Options)' });
        const result = contractEngine.compareContracts(before, after);

        expect(result.inputChanged).toBe(true);
        expect(result.outputChanged).toBe(false);
    });

    test('detects output contract changes', () => {
        const before = makeContract({ output_contract: 'Promise<User>' });
        const after = makeContract({ output_contract: 'Promise<UserDTO>' });
        const result = contractEngine.compareContracts(before, after);

        expect(result.outputChanged).toBe(true);
    });

    test('detects error contract changes', () => {
        const before = makeContract({ error_contract: 'NotFoundError' });
        const after = makeContract({ error_contract: 'NotFoundError | ValidationError' });
        const result = contractEngine.compareContracts(before, after);

        expect(result.errorChanged).toBe(true);
    });

    test('detects security contract changes', () => {
        const before = makeContract({ security_contract: 'none' });
        const after = makeContract({ security_contract: '@AuthGuard()' });
        const result = contractEngine.compareContracts(before, after);

        expect(result.securityChanged).toBe(true);
    });

    test('detects serialization contract changes', () => {
        const before = makeContract({ serialization_contract: 'none' });
        const after = makeContract({ serialization_contract: '@Serialize()' });
        const result = contractEngine.compareContracts(before, after);

        expect(result.serializationChanged).toBe(true);
    });

    test('identical contracts report no changes', () => {
        const contract = makeContract({});
        const result = contractEngine.compareContracts(contract, contract);

        expect(result.inputChanged).toBe(false);
        expect(result.outputChanged).toBe(false);
        expect(result.errorChanged).toBe(false);
        expect(result.securityChanged).toBe(false);
        expect(result.serializationChanged).toBe(false);
    });
});

// ── Tests: Rollback from Each State ─────────────────────────────────

describe('Transactional Integration — Rollback Reachability', () => {
    test('rolled_back is reachable from all non-terminal states', () => {
        const reachableFromRollback: TransactionState[] = [
            'planned', 'prepared', 'patched', 'reindexed',
            'validated', 'propagation_pending', 'failed',
        ];
        for (const state of reachableFromRollback) {
            expect(VALID_TRANSITIONS[state]).toContain('rolled_back');
        }
    });

    test('terminal states cannot be rolled back', () => {
        expect(VALID_TRANSITIONS['committed']).not.toContain('rolled_back');
        expect(VALID_TRANSITIONS['rolled_back']).not.toContain('rolled_back');
    });

    test('transition map has no self-loops except rolled_back being terminal', () => {
        for (const state of ALL_STATES) {
            // No state should transition to itself
            expect(VALID_TRANSITIONS[state]).not.toContain(state);
        }
    });
});
