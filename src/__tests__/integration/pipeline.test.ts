/**
 * Integration test — Full extraction-to-profiling pipeline.
 *
 * Validates:
 *   - TS adapter extracts symbols (names, kinds, line ranges, signatures)
 *   - Behavioral hints are detected (db_read, db_write, network_call, throws, catches)
 *   - Contract hints are extracted (input types, output types, thrown types)
 *   - Extracted relations include calls and imports
 *   - BehavioralEngine processes hints into profiles with correct purity classification
 *   - ContractEngine builds contract profiles from hints
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { extractFromTypeScript } from '../../adapters/ts/index';
import { BehavioralEngine } from '../../analysis-engine/behavioral';
import { ContractEngine } from '../../analysis-engine/contracts';
import type {
    AdapterExtractionResult, BehaviorHint, ContractHint,
} from '../../types';

// ── DB mocks ────────────────────────────────────────────────────────
jest.mock('../../db-driver', () => ({
    db: {
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        batchInsert: jest.fn().mockResolvedValue(undefined),
        transaction: jest.fn().mockImplementation(async (cb: any) => cb({
            query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        })),
    },
}));

jest.mock('../../db-driver/core_data', () => ({
    coreDataService: {
        upsertBehavioralProfile: jest.fn().mockResolvedValue('bp-id'),
        upsertContractProfile: jest.fn().mockResolvedValue('cp-id'),
        getSymbolVersionsForSnapshot: jest.fn().mockResolvedValue([]),
    },
}));

// ── Fixtures ────────────────────────────────────────────────────────

const SAMPLE_SERVICE_CODE = `
import { db } from './database';
import { UserDTO } from './types';

export async function fetchUserById(userId: string): Promise<UserDTO> {
    const result = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (!result.rows[0]) {
        throw new Error('User not found');
    }
    return result.rows[0] as UserDTO;
}

export async function createUser(name: string, email: string): Promise<UserDTO> {
    const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
        throw new Error('Duplicate email');
    }
    const result = await db.insert({ table: 'users', data: { name, email } });
    return result as UserDTO;
}

export async function syncUserToExternalService(user: UserDTO): Promise<void> {
    await fetch('https://api.external.com/users', {
        method: 'POST',
        body: JSON.stringify(user),
    });
    log.info('User synced', { userId: user.id });
}

export function validateEmail(email: string): boolean {
    return /^[^@]+@[^@]+\\.[^@]+$/.test(email);
}

export class UserRepository {
    async findAll(): Promise<UserDTO[]> {
        const result = await db.query('SELECT * FROM users');
        return result.rows as UserDTO[];
    }

    async remove(userId: string): Promise<void> {
        await db.delete({ table: 'users', where: { id: userId } });
    }
}
`;

const SAMPLE_AUTH_CODE = `
import { verifyToken } from './auth';

export async function protectedEndpoint(req: any, res: any): Promise<void> {
    try {
        const token = req.headers.authorization;
        const payload = await verifyToken(token);
        if (!payload) {
            throw new Error('Unauthorized');
        }
        const data = await redis.get(\`user:\${payload.userId}\`);
        res.json({ data });
    } catch (err) {
        throw new Error('Auth failed');
    }
}
`;

let tmpDir: string;
let sampleServicePath: string;
let sampleAuthPath: string;

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cz-pipeline-test-'));
    sampleServicePath = path.join(tmpDir, 'user-service.ts');
    sampleAuthPath = path.join(tmpDir, 'auth-handler.ts');
    fs.writeFileSync(sampleServicePath, SAMPLE_SERVICE_CODE, 'utf-8');
    fs.writeFileSync(sampleAuthPath, SAMPLE_AUTH_CODE, 'utf-8');
});

afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────

describe('Pipeline Integration — TS Adapter Symbol Extraction', () => {
    let result: AdapterExtractionResult;

    beforeAll(() => {
        result = extractFromTypeScript([sampleServicePath]);
    });

    test('extracts all top-level functions', () => {
        const names = result.symbols.map(s => s.canonical_name);
        expect(names).toContain('fetchUserById');
        expect(names).toContain('createUser');
        expect(names).toContain('syncUserToExternalService');
        expect(names).toContain('validateEmail');
    });

    test('extracts classes', () => {
        const classes = result.symbols.filter(s => s.kind === 'class');
        expect(classes.length).toBeGreaterThanOrEqual(1);
        expect(classes.some(c => c.canonical_name === 'UserRepository')).toBe(true);
    });

    test('extracts class methods', () => {
        const methods = result.symbols.filter(s => s.kind === 'method');
        const methodNames = methods.map(m => m.canonical_name);
        expect(methodNames).toContain('findAll');
        expect(methodNames).toContain('remove');
    });

    test('symbols have correct kind classification', () => {
        const fetchUser = result.symbols.find(s => s.canonical_name === 'fetchUserById');
        expect(fetchUser).toBeDefined();
        expect(fetchUser!.kind).toBe('function');

        const repo = result.symbols.find(s => s.canonical_name === 'UserRepository');
        expect(repo).toBeDefined();
        expect(repo!.kind).toBe('class');
    });

    test('symbols have valid line ranges', () => {
        for (const sym of result.symbols) {
            expect(sym.range_start_line).toBeGreaterThanOrEqual(1);
            expect(sym.range_end_line).toBeGreaterThanOrEqual(sym.range_start_line);
        }
    });

    test('symbols have non-empty signatures', () => {
        const funcs = result.symbols.filter(s => s.kind === 'function');
        for (const fn of funcs) {
            expect(fn.signature.length).toBeGreaterThan(0);
        }
    });

    test('symbols have valid hashes', () => {
        for (const sym of result.symbols) {
            expect(sym.ast_hash).toMatch(/^[0-9a-f]{64}$/);
            expect(sym.body_hash).toMatch(/^[0-9a-f]{64}$/);
        }
    });

    test('exported functions have public visibility', () => {
        const fetchUser = result.symbols.find(s => s.canonical_name === 'fetchUserById');
        expect(fetchUser?.visibility).toBe('public');
    });

    test('parse confidence is high with no errors', () => {
        expect(result.parse_confidence).toBeGreaterThanOrEqual(0.5);
    });
});

describe('Pipeline Integration — Behavioral Hint Detection', () => {
    let result: AdapterExtractionResult;

    beforeAll(() => {
        result = extractFromTypeScript([sampleServicePath, sampleAuthPath]);
    });

    test('detects db_read hints from .query()', () => {
        const dbReads = result.behavior_hints.filter(h => h.hint_type === 'db_read');
        expect(dbReads.length).toBeGreaterThanOrEqual(1);
        expect(dbReads.some(h => h.detail === 'raw_query')).toBe(true);
    });

    test('detects db_write hints from .insert() and .delete()', () => {
        const dbWrites = result.behavior_hints.filter(h => h.hint_type === 'db_write');
        expect(dbWrites.length).toBeGreaterThanOrEqual(1);
        const details = dbWrites.map(h => h.detail);
        expect(details).toContain('db_insert');
    });

    test('detects network_call hints from fetch()', () => {
        const netCalls = result.behavior_hints.filter(h => h.hint_type === 'network_call');
        expect(netCalls.length).toBeGreaterThanOrEqual(1);
        expect(netCalls.some(h => h.detail === 'fetch')).toBe(true);
    });

    test('detects throws hints from throw statements', () => {
        const throws = result.behavior_hints.filter(h => h.hint_type === 'throws');
        expect(throws.length).toBeGreaterThanOrEqual(1);
    });

    test('detects catches hints from catch blocks', () => {
        const catches = result.behavior_hints.filter(h => h.hint_type === 'catches');
        expect(catches.length).toBeGreaterThanOrEqual(1);
    });

    test('detects auth_check hints from verifyToken', () => {
        const authHints = result.behavior_hints.filter(h => h.hint_type === 'auth_check');
        expect(authHints.length).toBeGreaterThanOrEqual(1);
        expect(authHints.some(h => h.detail === 'token_verify')).toBe(true);
    });

    test('detects cache_op hints from redis.get', () => {
        const cacheHints = result.behavior_hints.filter(h => h.hint_type === 'cache_op');
        expect(cacheHints.length).toBeGreaterThanOrEqual(1);
        expect(cacheHints.some(h => h.detail === 'redis')).toBe(true);
    });

    test('behavior hints reference the correct symbol keys', () => {
        for (const hint of result.behavior_hints) {
            expect(hint.symbol_key).toBeDefined();
            expect(hint.symbol_key.length).toBeGreaterThan(0);
            expect(hint.line).toBeGreaterThanOrEqual(1);
        }
    });
});

describe('Pipeline Integration — Contract Hint Extraction', () => {
    let result: AdapterExtractionResult;

    beforeAll(() => {
        result = extractFromTypeScript([sampleServicePath]);
    });

    test('contract hints are extracted for functions', () => {
        expect(result.contract_hints.length).toBeGreaterThanOrEqual(1);
    });

    test('input types are captured', () => {
        const fetchUserHint = result.contract_hints.find(h =>
            h.symbol_key.includes('fetchUserById')
        );
        expect(fetchUserHint).toBeDefined();
        expect(fetchUserHint!.input_types.length).toBeGreaterThanOrEqual(1);
        expect(fetchUserHint!.input_types.some(t => t.includes('string'))).toBe(true);
    });

    test('output types are captured', () => {
        const validateHint = result.contract_hints.find(h =>
            h.symbol_key.includes('validateEmail')
        );
        expect(validateHint).toBeDefined();
        expect(validateHint!.output_type).toContain('boolean');
    });

    test('thrown types are captured from throw new Error', () => {
        const fetchUserHint = result.contract_hints.find(h =>
            h.symbol_key.includes('fetchUserById')
        );
        expect(fetchUserHint).toBeDefined();
        expect(fetchUserHint!.thrown_types).toContain('Error');
    });

    test('createUser captures multiple input types', () => {
        const createHint = result.contract_hints.find(h =>
            h.symbol_key.includes('createUser')
        );
        expect(createHint).toBeDefined();
        expect(createHint!.input_types.length).toBe(2);
    });
});

describe('Pipeline Integration — Relation Extraction', () => {
    let result: AdapterExtractionResult;

    beforeAll(() => {
        result = extractFromTypeScript([sampleServicePath]);
    });

    test('extracts call relations', () => {
        const calls = result.relations.filter(r => r.relation_type === 'calls');
        expect(calls.length).toBeGreaterThanOrEqual(1);
        const targets = calls.map(r => r.target_name);
        expect(targets).toContain('query');
    });

    test('call relations reference correct source symbols', () => {
        const calls = result.relations.filter(r => r.relation_type === 'calls');
        for (const rel of calls) {
            expect(rel.source_key.length).toBeGreaterThan(0);
        }
    });

    test('extracts type reference relations', () => {
        const typed = result.relations.filter(r => r.relation_type === 'typed_as');
        expect(typed.length).toBeGreaterThanOrEqual(1);
    });
});

describe('Pipeline Integration — BehavioralEngine Profile Building', () => {
    const engine = new BehavioralEngine();

    test('builds side_effecting profile from network call hints', async () => {
        const hints: BehaviorHint[] = [
            { symbol_key: 'syncUser', hint_type: 'network_call', detail: 'fetch', line: 10 },
            { symbol_key: 'syncUser', hint_type: 'logging', detail: 'console', line: 15 },
        ];

        const profile = await engine.extractBehavioralProfiles('sv-001', hints);

        expect(profile.purity_class).toBe('side_effecting');
        expect(profile.network_calls).toContain('fetch');
        expect(profile.resource_touches).toContain('network:fetch');
    });

    test('builds read_write profile from db write hints', async () => {
        const hints: BehaviorHint[] = [
            { symbol_key: 'createUser', hint_type: 'db_write', detail: 'db_insert', line: 5 },
            { symbol_key: 'createUser', hint_type: 'db_read', detail: 'raw_query', line: 3 },
            { symbol_key: 'createUser', hint_type: 'throws', detail: 'Error', line: 7 },
        ];

        const profile = await engine.extractBehavioralProfiles('sv-002', hints);

        expect(profile.purity_class).toBe('read_write');
        expect(profile.db_writes).toContain('db_insert');
        expect(profile.db_reads).toContain('raw_query');
        expect(profile.exception_profile).toContain('throws:Error');
    });

    test('builds read_only profile from only read hints', async () => {
        const hints: BehaviorHint[] = [
            { symbol_key: 'fetchUser', hint_type: 'db_read', detail: 'raw_query', line: 2 },
        ];

        const profile = await engine.extractBehavioralProfiles('sv-003', hints);

        expect(profile.purity_class).toBe('read_only');
        expect(profile.db_reads).toContain('raw_query');
    });

    test('builds pure profile from no I/O hints', async () => {
        const hints: BehaviorHint[] = [
            { symbol_key: 'validate', hint_type: 'validation', detail: 'validate', line: 1 },
        ];

        const profile = await engine.extractBehavioralProfiles('sv-004', hints);

        expect(profile.purity_class).toBe('pure');
        expect(profile.validation_operations).toContain('validate');
    });

    test('deduplicates resource touches', async () => {
        const hints: BehaviorHint[] = [
            { symbol_key: 'fn', hint_type: 'db_read', detail: 'raw_query', line: 1 },
            { symbol_key: 'fn', hint_type: 'db_read', detail: 'raw_query', line: 5 },
        ];

        const profile = await engine.extractBehavioralProfiles('sv-005', hints);

        expect(profile.db_reads.length).toBe(1);
        expect(profile.resource_touches.filter(r => r === 'db:read:raw_query').length).toBe(1);
    });
});

describe('Pipeline Integration — ContractEngine Profile Building', () => {
    const engine = new ContractEngine();

    test('builds contract profile from hint with input types', async () => {
        const hint: ContractHint = {
            symbol_key: 'createUser',
            input_types: ['string', 'string'],
            output_type: 'Promise<UserDTO>',
            thrown_types: ['Error'],
            decorators: [],
        };

        const profile = await engine.extractContractProfile('sv-010', hint);

        expect(profile.input_contract).toBe('(string, string)');
        expect(profile.output_contract).toBe('Promise<UserDTO>');
        expect(profile.error_contract).toBe('Error');
    });

    test('handles void input types', async () => {
        const hint: ContractHint = {
            symbol_key: 'noArgs',
            input_types: [],
            output_type: 'void',
            thrown_types: [],
            decorators: [],
        };

        const profile = await engine.extractContractProfile('sv-011', hint);

        expect(profile.input_contract).toBe('void');
        expect(profile.output_contract).toBe('void');
        expect(profile.error_contract).toBe('never');
    });

    test('extracts security decorators', async () => {
        const hint: ContractHint = {
            symbol_key: 'fn',
            input_types: ['Request'],
            output_type: 'Response',
            thrown_types: [],
            decorators: ['@AuthGuard()', '@RolesAllowed("admin")'],
        };

        const profile = await engine.extractContractProfile('sv-012', hint);

        expect(profile.security_contract).not.toBe('none');
        expect(profile.security_contract).toContain('@AuthGuard()');
    });

    test('extracts serialization decorators', async () => {
        const hint: ContractHint = {
            symbol_key: 'fn',
            input_types: [],
            output_type: 'string',
            thrown_types: [],
            decorators: ['@Serialize()', '@Expose()'],
        };

        const profile = await engine.extractContractProfile('sv-013', hint);

        expect(profile.serialization_contract).not.toBe('none');
    });
});
