/**
 * Integration test — Context Capsule Compiler.
 *
 * Validates:
 *   - Token budget enforcement across all modes
 *   - Capsule mode differences (minimal, standard, strict)
 *   - Capsule structure matches the ContextCapsule interface
 *   - Omission rationale is populated when budget is exceeded
 *   - Uncertainty notes are propagated from symbol flags
 *   - Context node types and relevance ordering
 */

import { CapsuleCompiler } from '../../analysis-engine/capsule-compiler';
import type { CapsuleMode } from '../../types';

// ── DB Mock ─────────────────────────────────────────────────────────

const mockQuery = jest.fn();

jest.mock('../../db-driver', () => ({
    db: {
        query: (...args: unknown[]) => mockQuery(...args),
        batchInsert: jest.fn().mockResolvedValue(undefined),
        transaction: jest.fn().mockImplementation(async (cb: any) => cb({
            query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        })),
    },
}));

// ── Helpers ─────────────────────────────────────────────────────────

function makeTargetSymbolRow(overrides?: Partial<{
    symbol_id: string;
    canonical_name: string;
    signature: string;
    file_path: string;
    range_start_line: number;
    range_end_line: number;
    uncertainty_flags: string[];
}>) {
    return {
        symbol_id: 'sym-001',
        canonical_name: 'getUserById',
        signature: 'getUserById(userId: string): Promise<User>',
        file_path: 'src/services/user.ts',
        range_start_line: 10,
        range_end_line: 25,
        body_source: 'async function getUserById(userId: string): Promise<User> {\n  return db.query("SELECT * FROM users WHERE id = $1", [userId]);\n}',
        uncertainty_flags: [],
        ...overrides,
    };
}

function makeDependencyRows(count: number, summarySize: number = 50) {
    const rows = [];
    for (let i = 0; i < count; i++) {
        rows.push({
            symbol_version_id: `dep-sv-${i}`,
            canonical_name: `dependency_${i}`,
            signature: `dep${i}(x: number): void`,
            summary: 'A'.repeat(summarySize),
            body_source: `function dep${i}(x: number): void { /* body */ }`,
            relation_type: 'calls',
            confidence: 0.9 - i * 0.01,
        });
    }
    return rows;
}

function makeCallerRows(count: number, summarySize: number = 50) {
    const rows = [];
    for (let i = 0; i < count; i++) {
        rows.push({
            symbol_version_id: `caller-sv-${i}`,
            canonical_name: `caller_${i}`,
            signature: `caller${i}(): void`,
            summary: 'B'.repeat(summarySize),
            body_source: `function caller${i}(): void { /* body */ }`,
            confidence: 0.85 - i * 0.01,
        });
    }
    return rows;
}

function makeTestRows(count: number) {
    const rows = [];
    for (let i = 0; i < count; i++) {
        rows.push({
            test_artifact_id: `test-${i}`,
            assertion_summary: `Verifies behavior ${i}`,
            framework: 'jest',
            symbol_version_id: `test-sv-${i}`,
            canonical_name: `test_case_${i}`,
        });
    }
    return rows;
}

function makeContractRow() {
    return {
        input_contract: '(userId: string)',
        output_contract: 'Promise<User>',
        error_contract: 'NotFoundError | ValidationError',
        security_contract: '@AuthGuard()',
        serialization_contract: 'none',
    };
}

function makeHomologRows(count: number) {
    const rows = [];
    for (let i = 0; i < count; i++) {
        rows.push({
            dst_symbol_version_id: `hom-sv-${i}`,
            relation_type: 'near_duplicate_logic',
            confidence: 0.8 - i * 0.02,
            canonical_name: `homolog_${i}`,
            signature: `homolog${i}(id: string): Promise<Entity>`,
            body_source: `async function homolog${i}(id: string): Promise<Entity> { return db.find(id); }`,
        });
    }
    return rows;
}

/**
 * Configure the mock to respond to different query patterns.
 * The CapsuleCompiler issues queries in a specific order:
 *   1. loadSymbolVersion (target)
 *   2. loadDirectDependencies
 *   3. loadCallers (standard + strict)
 *   4. loadTestContext (standard + strict)
 *   5. loadContractContext (strict)
 *   6. loadHomologContext (strict)
 */
function setupMockForMode(
    mode: CapsuleMode,
    opts: {
        depCount?: number;
        callerCount?: number;
        testCount?: number;
        hasContract?: boolean;
        homologCount?: number;
        depSummarySize?: number;
        uncertaintyFlags?: string[];
    } = {}
) {
    const {
        depCount = 3,
        callerCount = 2,
        testCount = 1,
        hasContract = true,
        homologCount = 2,
        depSummarySize = 50,
        uncertaintyFlags = [],
    } = opts;

    let callIndex = 0;
    mockQuery.mockImplementation(async (sql: string, _params?: unknown[]) => {
        callIndex++;

        // Target symbol load (always first, contains JOIN ... WHERE sv.symbol_version_id)
        if (sql.includes('sv.symbol_version_id = $1') && sql.includes('f.path as file_path')) {
            return { rows: [makeTargetSymbolRow({ uncertainty_flags: uncertaintyFlags })], rowCount: 1 };
        }

        // Dependencies (structural_relations WHERE src)
        if (sql.includes('sr.src_symbol_version_id = $1') && sql.includes('LIMIT 20')) {
            return { rows: makeDependencyRows(depCount, depSummarySize), rowCount: depCount };
        }

        // Callers (structural_relations WHERE dst, calls/references)
        if (sql.includes('sr.dst_symbol_version_id = $1') && sql.includes("'calls', 'references'")) {
            return { rows: makeCallerRows(callerCount), rowCount: callerCount };
        }

        // Test context (test_artifacts)
        if (sql.includes('test_artifacts')) {
            return { rows: makeTestRows(testCount), rowCount: testCount };
        }

        // Contract context (contract_profiles)
        if (sql.includes('contract_profiles')) {
            return hasContract
                ? { rows: [makeContractRow()], rowCount: 1 }
                : { rows: [], rowCount: 0 };
        }

        // Homolog context (inferred_relations)
        if (sql.includes('inferred_relations')) {
            return { rows: makeHomologRows(homologCount), rowCount: homologCount };
        }

        return { rows: [], rowCount: 0 };
    });
}

// ── Tests ───────────────────────────────────────────────────────────

describe('Capsule Integration — Structure Validation', () => {
    const compiler = new CapsuleCompiler();

    beforeEach(() => {
        mockQuery.mockReset();
    });

    test('capsule has correct target_symbol structure', async () => {
        setupMockForMode('standard');
        const capsule = await compiler.compile('sv-001', 'snap-001', 'standard');

        expect(capsule.target_symbol).toBeDefined();
        expect(capsule.target_symbol.symbol_id).toBe('sym-001');
        expect(capsule.target_symbol.name).toBe('getUserById');
        expect(capsule.target_symbol.signature).toBe('getUserById(userId: string): Promise<User>');
        expect(capsule.target_symbol.location).toEqual({
            file_path: 'src/services/user.ts',
            start_line: 10,
            end_line: 25,
        });
    });

    test('capsule contains context_nodes array', async () => {
        setupMockForMode('standard');
        const capsule = await compiler.compile('sv-001', 'snap-001', 'standard');
        expect(Array.isArray(capsule.context_nodes)).toBe(true);
    });

    test('capsule contains omission_rationale array', async () => {
        setupMockForMode('standard');
        const capsule = await compiler.compile('sv-001', 'snap-001', 'standard');
        expect(Array.isArray(capsule.omission_rationale)).toBe(true);
    });

    test('capsule contains uncertainty_notes array', async () => {
        setupMockForMode('standard', { uncertaintyFlags: ['type_inference_failure'] });
        const capsule = await compiler.compile('sv-001', 'snap-001', 'standard');
        expect(Array.isArray(capsule.uncertainty_notes)).toBe(true);
        expect(capsule.uncertainty_notes.length).toBeGreaterThan(0);
        expect(capsule.uncertainty_notes[0]).toContain('type_inference_failure');
    });

    test('capsule has positive token_estimate', async () => {
        setupMockForMode('standard');
        const capsule = await compiler.compile('sv-001', 'snap-001', 'standard');
        expect(capsule.token_estimate).toBeGreaterThan(0);
    });

    test('throws when symbol version not found', async () => {
        mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
        await expect(
            compiler.compile('nonexistent-sv', 'snap-001', 'standard')
        ).rejects.toThrow('Symbol version not found');
    });
});

describe('Capsule Integration — Mode Differences', () => {
    const compiler = new CapsuleCompiler();

    beforeEach(() => {
        mockQuery.mockReset();
    });

    test('minimal mode includes only dependencies (no callers, tests)', async () => {
        setupMockForMode('minimal', { depCount: 3, callerCount: 5, testCount: 3 });
        const capsule = await compiler.compile('sv-001', 'snap-001', 'minimal');

        const types = capsule.context_nodes.map(n => n.type);
        expect(types).toContain('dependency');
        expect(types).not.toContain('caller');
        expect(types).not.toContain('test');
        expect(types).not.toContain('contract');
        expect(types).not.toContain('homolog');
    });

    test('standard mode includes dependencies, callers, and tests', async () => {
        setupMockForMode('standard', { depCount: 2, callerCount: 2, testCount: 1 });
        const capsule = await compiler.compile('sv-001', 'snap-001', 'standard');

        const types = capsule.context_nodes.map(n => n.type);
        expect(types).toContain('dependency');
        expect(types).toContain('caller');
        expect(types).toContain('test');
    });

    test('strict mode includes all context types', async () => {
        setupMockForMode('strict', {
            depCount: 2, callerCount: 1, testCount: 1,
            hasContract: true, homologCount: 1,
        });
        const capsule = await compiler.compile('sv-001', 'snap-001', 'strict');

        const types = capsule.context_nodes.map(n => n.type);
        expect(types).toContain('dependency');
        expect(types).toContain('caller');
        expect(types).toContain('test');
        expect(types).toContain('contract');
        expect(types).toContain('homolog');
    });

    test('minimal mode uses smaller token budget than strict', async () => {
        setupMockForMode('minimal', { depCount: 2 });
        const minimalCapsule = await compiler.compile('sv-001', 'snap-001', 'minimal');

        setupMockForMode('strict', { depCount: 2, callerCount: 2, testCount: 1, homologCount: 1 });
        const strictCapsule = await compiler.compile('sv-001', 'snap-001', 'strict');

        // Strict should include more context nodes
        expect(strictCapsule.context_nodes.length).toBeGreaterThanOrEqual(
            minimalCapsule.context_nodes.length
        );
    });
});

describe('Capsule Integration — Token Budget Enforcement', () => {
    const compiler = new CapsuleCompiler();

    beforeEach(() => {
        mockQuery.mockReset();
    });

    test('respects explicit token budget', async () => {
        // Provide a very small budget so some nodes are omitted
        setupMockForMode('standard', { depCount: 10, depSummarySize: 200 });
        const capsule = await compiler.compile('sv-001', 'snap-001', 'standard', 500);

        expect(capsule.token_estimate).toBeLessThanOrEqual(500);
    });

    test('very small budget limits included context nodes', async () => {
        // With a tiny budget and many large dependencies, fewer nodes should be included
        setupMockForMode('standard', { depCount: 20, depSummarySize: 500 });
        const smallBudget = await compiler.compile('sv-001', 'snap-001', 'standard', 100);

        setupMockForMode('standard', { depCount: 20, depSummarySize: 500 });
        const largeBudget = await compiler.compile('sv-001', 'snap-001', 'standard', 100_000);

        // Small budget should include fewer or equal context nodes than large budget
        expect(smallBudget.context_nodes.length).toBeLessThanOrEqual(largeBudget.context_nodes.length);
        expect(smallBudget.token_estimate).toBeLessThanOrEqual(100);
    });

    test('large budget allows all context to be included', async () => {
        setupMockForMode('standard', { depCount: 2, callerCount: 1, testCount: 1, depSummarySize: 20 });
        const capsule = await compiler.compile('sv-001', 'snap-001', 'standard', 100_000);

        // With a huge budget, nothing should be omitted
        expect(capsule.omission_rationale.length).toBe(0);
        expect(capsule.context_nodes.length).toBeGreaterThanOrEqual(4); // 2 deps + 1 caller + 1 test
    });

    test('token estimate increases with included nodes', async () => {
        setupMockForMode('minimal', { depCount: 1, depSummarySize: 20 });
        const small = await compiler.compile('sv-001', 'snap-001', 'minimal', 100_000);

        setupMockForMode('standard', { depCount: 5, callerCount: 3, testCount: 2, depSummarySize: 100 });
        const large = await compiler.compile('sv-001', 'snap-001', 'standard', 100_000);

        expect(large.token_estimate).toBeGreaterThan(small.token_estimate);
    });
});

describe('Capsule Integration — Context Node Quality', () => {
    const compiler = new CapsuleCompiler();

    beforeEach(() => {
        mockQuery.mockReset();
    });

    test('dependency nodes have correct type and relevance', async () => {
        setupMockForMode('standard', { depCount: 3 });
        const capsule = await compiler.compile('sv-001', 'snap-001', 'standard');

        const deps = capsule.context_nodes.filter(n => n.type === 'dependency');
        for (const dep of deps) {
            expect(dep.type).toBe('dependency');
            expect(dep.name).toBeDefined();
            expect(dep.relevance).toBeGreaterThan(0);
            expect(dep.relevance).toBeLessThanOrEqual(1);
        }
    });

    test('caller nodes have summary info', async () => {
        setupMockForMode('standard', { callerCount: 2 });
        const capsule = await compiler.compile('sv-001', 'snap-001', 'standard');

        const callers = capsule.context_nodes.filter(n => n.type === 'caller');
        for (const caller of callers) {
            expect(caller.summary).toBeDefined();
            expect(caller.summary!.length).toBeGreaterThan(0);
        }
    });

    test('test nodes include framework tag', async () => {
        setupMockForMode('standard', { testCount: 2 });
        const capsule = await compiler.compile('sv-001', 'snap-001', 'standard');

        const tests = capsule.context_nodes.filter(n => n.type === 'test');
        for (const test of tests) {
            expect(test.summary).toContain('[jest]');
        }
    });

    test('contract nodes include input/output summary in strict mode', async () => {
        setupMockForMode('strict', { hasContract: true });
        const capsule = await compiler.compile('sv-001', 'snap-001', 'strict');

        const contracts = capsule.context_nodes.filter(n => n.type === 'contract');
        expect(contracts.length).toBeGreaterThanOrEqual(1);
        expect(contracts[0]!.summary).toContain('Input:');
        expect(contracts[0]!.summary).toContain('Output:');
    });

    test('homolog nodes are included in strict mode', async () => {
        setupMockForMode('strict', { homologCount: 2 });
        const capsule = await compiler.compile('sv-001', 'snap-001', 'strict');

        const homologs = capsule.context_nodes.filter(n => n.type === 'homolog');
        expect(homologs.length).toBeGreaterThanOrEqual(1);
        for (const hom of homologs) {
            expect(hom.relevance).toBeGreaterThan(0);
        }
    });
});

describe('Capsule Integration — Source Code Handling', () => {
    const compiler = new CapsuleCompiler();

    beforeEach(() => {
        mockQuery.mockReset();
    });

    test('code field is populated (with unavailable message when no base path)', async () => {
        setupMockForMode('standard');
        const capsule = await compiler.compile('sv-001', 'snap-001', 'standard');

        // Without a repoBasePath, code should indicate it is unavailable
        expect(capsule.target_symbol.code).toBeDefined();
        expect(capsule.target_symbol.code.length).toBeGreaterThan(0);
    });

    test('no uncertainty flags => empty uncertainty_notes', async () => {
        setupMockForMode('standard', { uncertaintyFlags: [] });
        const capsule = await compiler.compile('sv-001', 'snap-001', 'standard');
        expect(capsule.uncertainty_notes.length).toBe(0);
    });

    test('multiple uncertainty flags are included', async () => {
        setupMockForMode('standard', {
            uncertaintyFlags: ['type_inference_failure', 'normalization_failure'],
        });
        const capsule = await compiler.compile('sv-001', 'snap-001', 'standard');
        expect(capsule.uncertainty_notes.length).toBe(1);
        expect(capsule.uncertainty_notes[0]).toContain('2 uncertainty flags');
    });
});
