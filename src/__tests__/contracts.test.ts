/**
 * Unit tests for contract comparison logic.
 */

import { ContractEngine } from '../analysis-engine/contracts';
import type { ContractProfile } from '../types';

const engine = new ContractEngine();

describe('ContractEngine — compareContracts', () => {
    const makeProfile = (overrides: Partial<ContractProfile>): ContractProfile => ({
        contract_profile_id: 'test',
        symbol_version_id: 'test',
        input_contract: '(id: string)',
        output_contract: 'User',
        error_contract: 'NotFoundError',
        schema_refs: [],
        api_contract_refs: [],
        serialization_contract: 'none',
        security_contract: 'none',
        derived_invariants_count: 0,
        ...overrides,
    });

    test('identical contracts show no changes', () => {
        const a = makeProfile({});
        const b = makeProfile({});
        const result = engine.compareContracts(a, b);

        expect(result.inputChanged).toBe(false);
        expect(result.outputChanged).toBe(false);
        expect(result.errorChanged).toBe(false);
        expect(result.securityChanged).toBe(false);
        expect(result.serializationChanged).toBe(false);
    });

    test('detects input contract change', () => {
        const a = makeProfile({ input_contract: '(id: string)' });
        const b = makeProfile({ input_contract: '(id: string, name: string)' });
        const result = engine.compareContracts(a, b);

        expect(result.inputChanged).toBe(true);
        expect(result.outputChanged).toBe(false);
    });

    test('detects output contract change', () => {
        const a = makeProfile({ output_contract: 'User' });
        const b = makeProfile({ output_contract: 'User | null' });
        const result = engine.compareContracts(a, b);

        expect(result.outputChanged).toBe(true);
    });

    test('detects error contract change', () => {
        const a = makeProfile({ error_contract: 'NotFoundError' });
        const b = makeProfile({ error_contract: 'NotFoundError | TimeoutError' });
        const result = engine.compareContracts(a, b);

        expect(result.errorChanged).toBe(true);
    });

    test('detects security contract change', () => {
        const a = makeProfile({ security_contract: '@RequireAuth' });
        const b = makeProfile({ security_contract: 'none' });
        const result = engine.compareContracts(a, b);

        expect(result.securityChanged).toBe(true);
    });

    test('detects serialization contract change', () => {
        const a = makeProfile({ serialization_contract: '@JsonSerialize' });
        const b = makeProfile({ serialization_contract: '@ProtobufSerialize' });
        const result = engine.compareContracts(a, b);

        expect(result.serializationChanged).toBe(true);
    });
});
