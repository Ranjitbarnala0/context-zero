/**
 * ContextZero — Context Capsule Compiler
 *
 * Token-budgeted minimal context packages with 3 modes:
 *   - minimal: target + direct deps only
 *   - standard: target + deps + callers + tests + contracts
 *   - strict: full graph walk with invariants and homologs
 *
 * The capsule is the atomic unit of context for each tool call.
 * Complete enough to avoid hallucination, small enough to fit
 * token budgets.
 *
 * Security: Path traversal protection on source code reads.
 */

import * as fs from 'fs';
import * as path from 'path';
import { db } from '../db-driver';
import { Logger } from '../logger';
import type {
    ContextCapsule, ContextNode, CapsuleMode,
} from '../types';

const log = new Logger('capsule-compiler');

/** Approximate tokens per character (conservative estimate) */
const CHARS_PER_TOKEN = 4;

/** Default token budgets per mode */
const MODE_BUDGETS: Record<CapsuleMode, number> = {
    minimal: 4_000,
    standard: 12_000,
    strict: 24_000,
};

export class CapsuleCompiler {

    /**
     * Compile a context capsule for a target symbol.
     *
     * repoBasePath is accepted per-call to avoid shared mutable state
     * on the singleton instance, which would be a concurrency bug under
     * concurrent requests.
     */
    public async compile(
        symbolVersionId: string,
        snapshotId: string,
        mode: CapsuleMode = 'standard',
        tokenBudget?: number,
        repoBasePath?: string
    ): Promise<ContextCapsule> {
        const effectiveBudget = tokenBudget || MODE_BUDGETS[mode];
        const timer = log.startTimer('compile', {
            symbolVersionId, mode, tokenBudget: effectiveBudget,
        });

        // Load target symbol
        const target = await this.loadSymbolVersion(symbolVersionId);
        if (!target) {
            throw new Error(`Symbol version not found: ${symbolVersionId}`);
        }

        const resolvedBasePath = repoBasePath ? path.resolve(repoBasePath) : null;
        const targetCode = await this.readSourceCode(resolvedBasePath, target.file_path, target.range_start_line, target.range_end_line);
        let usedTokens = this.estimateTokens(targetCode) + this.estimateTokens(target.signature);

        const contextNodes: ContextNode[] = [];
        const omissionRationale: string[] = [];
        const uncertaintyNotes: string[] = [];

        if (target.uncertainty_flags.length > 0) {
            uncertaintyNotes.push(
                `Target has ${target.uncertainty_flags.length} uncertainty flags: ${target.uncertainty_flags.join(', ')}`
            );
        }

        // Progressive inclusion based on mode and budget
        // Priority order: direct deps → callers → tests → contracts → invariants → homologs

        // Load all context in parallel where possible
        const [deps, callers, tests] = await Promise.all([
            this.loadDirectDependencies(symbolVersionId),
            mode !== 'minimal' ? this.loadCallers(symbolVersionId) : Promise.resolve([]),
            mode !== 'minimal' ? this.loadTestContext(symbolVersionId) : Promise.resolve([]),
        ]);

        // Also load strict-mode context in parallel if needed
        let contracts: ContextNode[] = [];
        let homologs: ContextNode[] = [];
        if (mode === 'strict') {
            [contracts, homologs] = await Promise.all([
                this.loadContractContext(symbolVersionId),
                this.loadHomologContext(snapshotId, symbolVersionId),
            ]);
        }

        // 1. Direct dependencies (all modes)
        for (const dep of deps) {
            const tokens = this.estimateTokens(dep.code || dep.summary || '');
            if (usedTokens + tokens > effectiveBudget) {
                omissionRationale.push(`Omitted dependency ${dep.name}: token budget exceeded`);
                continue;
            }
            contextNodes.push(dep);
            usedTokens += tokens;
        }

        // 2. Callers (standard + strict)
        if (mode !== 'minimal') {
            for (const caller of callers) {
                const tokens = this.estimateTokens(caller.code || caller.summary || '');
                if (usedTokens + tokens > effectiveBudget) {
                    omissionRationale.push(`Omitted caller ${caller.name}: token budget exceeded`);
                    continue;
                }
                contextNodes.push(caller);
                usedTokens += tokens;
            }
        }

        // 3. Test context (standard + strict)
        if (mode !== 'minimal') {
            for (const test of tests) {
                const tokens = this.estimateTokens(test.code || test.summary || '');
                if (usedTokens + tokens > effectiveBudget) {
                    omissionRationale.push(`Omitted test ${test.name}: token budget exceeded`);
                    continue;
                }
                contextNodes.push(test);
                usedTokens += tokens;
            }
        }

        // 4. Contract and invariant context (strict only)
        if (mode === 'strict') {
            for (const contract of contracts) {
                const tokens = this.estimateTokens(contract.summary || '');
                if (usedTokens + tokens > effectiveBudget) {
                    omissionRationale.push(`Omitted contract context: token budget exceeded`);
                    break;
                }
                contextNodes.push(contract);
                usedTokens += tokens;
            }

            // 5. Homolog context (strict only)
            for (const hom of homologs) {
                const tokens = this.estimateTokens(hom.code || hom.summary || '');
                if (usedTokens + tokens > effectiveBudget) {
                    omissionRationale.push(`Omitted homolog ${hom.name}: token budget exceeded`);
                    continue;
                }
                contextNodes.push(hom);
                usedTokens += tokens;
            }
        }

        const capsule: ContextCapsule = {
            target_symbol: {
                symbol_id: target.symbol_id,
                name: target.canonical_name,
                code: targetCode,
                signature: target.signature,
                location: {
                    file_path: target.file_path,
                    start_line: target.range_start_line,
                    end_line: target.range_end_line,
                },
            },
            context_nodes: contextNodes,
            omission_rationale: omissionRationale,
            uncertainty_notes: uncertaintyNotes,
            token_estimate: usedTokens,
        };

        timer({ nodes: contextNodes.length, tokens: usedTokens, omissions: omissionRationale.length });
        return capsule;
    }

    /**
     * Read source code from disk with path traversal protection.
     */
    private async readSourceCode(
        basePath: string | null,
        filePath: string,
        startLine: number,
        endLine: number
    ): Promise<string> {
        if (!basePath) {
            return `[Source code unavailable — repo base path not set]`;
        }

        // Path traversal protection: resolve symlinks on base, then verify containment
        let realBase: string;
        try {
            realBase = fs.realpathSync(basePath);
        } catch {
            return `[Source code unavailable — base path not accessible]`;
        }
        const resolved = path.resolve(realBase, filePath);
        if (!resolved.startsWith(realBase + path.sep) && resolved !== realBase) {
            log.warn('Path traversal attempt blocked', { filePath, resolved, basePath: realBase });
            return `[Source code unavailable — path traversal blocked]`;
        }

        try {
            const content = fs.readFileSync(resolved, 'utf-8');
            const lines = content.split('\n');
            return lines.slice(startLine - 1, endLine).join('\n');
        } catch {
            return `[Source code unavailable — file not readable]`;
        }
    }

    private estimateTokens(text: string): number {
        return Math.ceil(text.length / CHARS_PER_TOKEN);
    }

    private async loadSymbolVersion(svId: string): Promise<{
        symbol_id: string;
        canonical_name: string;
        signature: string;
        file_path: string;
        range_start_line: number;
        range_end_line: number;
        uncertainty_flags: string[];
    } | null> {
        const result = await db.query(`
            SELECT sv.symbol_id, s.canonical_name, sv.signature,
                   f.path as file_path, sv.range_start_line, sv.range_end_line,
                   sv.uncertainty_flags
            FROM symbol_versions sv
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            JOIN files f ON f.file_id = sv.file_id
            WHERE sv.symbol_version_id = $1
        `, [svId]);
        return result.rows[0] as typeof result.rows[0] & {
            symbol_id: string;
            canonical_name: string;
            signature: string;
            file_path: string;
            range_start_line: number;
            range_end_line: number;
            uncertainty_flags: string[];
        } ?? null;
    }

    private async loadDirectDependencies(svId: string): Promise<ContextNode[]> {
        const result = await db.query(`
            SELECT sv.symbol_version_id, s.canonical_name, sv.signature, sv.summary,
                   sr.relation_type, sr.confidence
            FROM structural_relations sr
            JOIN symbol_versions sv ON sv.symbol_version_id = sr.dst_symbol_version_id
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            WHERE sr.src_symbol_version_id = $1
            ORDER BY sr.confidence DESC
            LIMIT 20
        `, [svId]);

        return (result.rows as {
            symbol_version_id: string;
            canonical_name: string;
            signature: string;
            summary: string;
            relation_type: string;
            confidence: number;
        }[]).map(row => ({
            type: 'dependency' as const,
            symbol_id: row.symbol_version_id,
            name: row.canonical_name,
            code: null,
            summary: `${row.relation_type}: ${row.signature || row.summary || 'no summary'}`,
            relevance: row.confidence,
        }));
    }

    private async loadCallers(svId: string): Promise<ContextNode[]> {
        const result = await db.query(`
            SELECT sv.symbol_version_id, s.canonical_name, sv.signature, sv.summary,
                   sr.confidence
            FROM structural_relations sr
            JOIN symbol_versions sv ON sv.symbol_version_id = sr.src_symbol_version_id
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            WHERE sr.dst_symbol_version_id = $1
            AND sr.relation_type IN ('calls', 'references')
            ORDER BY sr.confidence DESC
            LIMIT 10
        `, [svId]);

        return (result.rows as {
            symbol_version_id: string;
            canonical_name: string;
            signature: string;
            summary: string;
            confidence: number;
        }[]).map(row => ({
            type: 'caller' as const,
            symbol_id: row.symbol_version_id,
            name: row.canonical_name,
            code: null,
            summary: row.signature || row.summary || 'no summary',
            relevance: row.confidence,
        }));
    }

    private async loadTestContext(svId: string): Promise<ContextNode[]> {
        const result = await db.query(`
            SELECT ta.test_artifact_id, ta.assertion_summary, ta.framework,
                   sv.symbol_version_id, s.canonical_name
            FROM test_artifacts ta
            JOIN symbol_versions sv ON sv.symbol_version_id = ta.symbol_version_id
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            WHERE $1 = ANY(ta.related_symbols)
            LIMIT 5
        `, [svId]);

        return (result.rows as {
            test_artifact_id: string;
            assertion_summary: string;
            framework: string;
            symbol_version_id: string;
            canonical_name: string;
        }[]).map(row => ({
            type: 'test' as const,
            symbol_id: row.symbol_version_id,
            name: row.canonical_name,
            code: null,
            summary: `[${row.framework}] ${row.assertion_summary || 'test case'}`,
            relevance: 0.85,
        }));
    }

    private async loadContractContext(svId: string): Promise<ContextNode[]> {
        const result = await db.query(`
            SELECT cp.input_contract, cp.output_contract, cp.error_contract,
                   cp.security_contract, cp.serialization_contract
            FROM contract_profiles cp
            WHERE cp.symbol_version_id = $1
        `, [svId]);

        if (result.rows.length === 0) return [];

        const cp = result.rows[0] as {
            input_contract: string;
            output_contract: string;
            error_contract: string;
            security_contract: string;
            serialization_contract: string;
        };

        return [{
            type: 'contract' as const,
            symbol_id: null,
            name: 'Contract Profile',
            code: null,
            summary: `Input: ${cp.input_contract} → Output: ${cp.output_contract} | Errors: ${cp.error_contract} | Security: ${cp.security_contract}`,
            relevance: 0.90,
        }];
    }

    private async loadHomologContext(snapshotId: string, svId: string): Promise<ContextNode[]> {
        const result = await db.query(`
            SELECT ir.dst_symbol_version_id, ir.relation_type, ir.confidence,
                   s.canonical_name, sv.signature
            FROM inferred_relations ir
            JOIN symbol_versions sv ON sv.symbol_version_id = ir.dst_symbol_version_id
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            WHERE ir.src_symbol_version_id = $1
            AND ir.confidence >= 0.70
            AND ir.review_state != 'rejected'
            ORDER BY ir.confidence DESC
            LIMIT 5
        `, [svId]);

        return (result.rows as {
            dst_symbol_version_id: string;
            relation_type: string;
            confidence: number;
            canonical_name: string;
            signature: string;
        }[]).map(row => ({
            type: 'homolog' as const,
            symbol_id: row.dst_symbol_version_id,
            name: row.canonical_name,
            code: null,
            summary: `${row.relation_type} (confidence: ${row.confidence.toFixed(2)}): ${row.signature || 'no signature'}`,
            relevance: row.confidence,
        }));
    }
}

export const capsuleCompiler = new CapsuleCompiler();
