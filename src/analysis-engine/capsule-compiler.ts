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
        // Prefer stored body_source (DB-resident, Docker-safe, versioned).
        // Fall back to disk read for symbols ingested before body_source migration.
        // Nullish coalescing: empty string "" is a valid body (interfaces, type aliases).
        // Only fall back to disk when body_source is null/undefined (pre-migration symbols).
        let targetCode = target.body_source
            ?? await this.readSourceCode(resolvedBasePath, target.file_path, target.range_start_line, target.range_end_line);
        let usedTokens = this.estimateTokens(targetCode) + this.estimateTokens(target.signature);

        const contextNodes: ContextNode[] = [];
        const omissionRationale: string[] = [];
        const uncertaintyNotes: string[] = [];

        // BUG-006 FIX: If the target code alone exceeds the token budget,
        // truncate it to fit within the budget.
        if (usedTokens > effectiveBudget) {
            const signatureTokens = this.estimateTokens(target.signature);
            const availableForCode = effectiveBudget - signatureTokens;
            if (availableForCode <= 0) {
                targetCode = '[Target code omitted — token budget too small]';
            } else {
                const codeLines = targetCode.split('\n');
                const truncatedLines: string[] = [];
                let runningTokens = 0;
                for (const line of codeLines) {
                    const lineTokens = this.estimateTokens(line + '\n');
                    if (runningTokens + lineTokens > availableForCode) {
                        break;
                    }
                    truncatedLines.push(line);
                    runningTokens += lineTokens;
                }
                targetCode = truncatedLines.join('\n');
                omissionRationale.push('Target code truncated to fit token budget');
            }
            usedTokens = this.estimateTokens(targetCode) + signatureTokens;
        }

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

        // Budget-aware node insertion: when full code exceeds budget,
        // downgrade to signature/summary only. This prevents a single large
        // dependency from exhausting the entire budget.
        const addNodeBudgeted = (
            node: ContextNode,
            category: string,
        ): boolean => {
            const fullTokens = this.estimateTokens(node.code || node.summary || '');
            if (usedTokens + fullTokens <= effectiveBudget) {
                contextNodes.push(node);
                usedTokens += fullTokens;
                return true;
            }
            // Downgrade: drop code, keep signature/summary only
            const summaryTokens = this.estimateTokens(node.summary || '');
            if (node.code && usedTokens + summaryTokens <= effectiveBudget) {
                contextNodes.push({ ...node, code: null });
                usedTokens += summaryTokens;
                omissionRationale.push(`${category} ${node.name}: code truncated to summary (budget)`);
                return true;
            }
            omissionRationale.push(`Omitted ${category} ${node.name}: token budget exceeded`);
            return false;
        };

        // 1. Direct dependencies (all modes)
        for (const dep of deps) {
            addNodeBudgeted(dep, 'dependency');
        }

        // 2. Callers (standard + strict)
        if (mode !== 'minimal') {
            for (const caller of callers) {
                addNodeBudgeted(caller, 'caller');
            }
        }

        // 3. Test context (standard + strict)
        if (mode !== 'minimal') {
            for (const test of tests) {
                addNodeBudgeted(test, 'test');
            }
        }

        // 4. Contract and invariant context (strict only)
        if (mode === 'strict') {
            for (const contract of contracts) {
                if (!addNodeBudgeted(contract, 'contract')) break;
            }

            // 5. Homolog context (strict only)
            for (const hom of homologs) {
                addNodeBudgeted(hom, 'homolog');
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

            // BUG-005 FIX: Defensive validation of line ranges to prevent
            // code boundary leakage from stale or mis-indexed DB data.
            const clampedStart = Math.max(1, startLine);
            const clampedEnd = Math.min(lines.length, endLine);

            if (clampedStart !== startLine || clampedEnd !== endLine) {
                log.warn('Line range clamped — possible stale DB line numbers', {
                    filePath, startLine, endLine,
                    clampedStart, clampedEnd, totalLines: lines.length,
                });
            }

            if (clampedStart > clampedEnd) {
                log.warn('Invalid line range after clamping', {
                    filePath, clampedStart, clampedEnd,
                });
                return `[Source code unavailable — invalid line range]`;
            }

            const extracted = lines.slice(clampedStart - 1, clampedEnd);

            // Warn if the first non-empty line doesn't look like a symbol definition —
            // may indicate the DB range_start_line includes preceding code.
            const firstNonEmpty = extracted.find(l => l.trim().length > 0);
            if (firstNonEmpty) {
                const trimmed = firstNonEmpty.trim();
                const looksLikeDefinition = /^(export\s+)?(default\s+)?(async\s+)?(function|class|const|let|var|type|interface|enum|def |abstract\s|public\s|private\s|protected\s)/.test(trimmed)
                    || /^(\/\*\*|\/\/|#|\*)/.test(trimmed);       // doc-comment is also OK
                if (!looksLikeDefinition) {
                    log.warn('Extracted code may include preceding function — first non-empty line does not start with a recognized keyword', {
                        filePath, startLine: clampedStart, firstLine: trimmed.slice(0, 120),
                    });
                }
            }

            return extracted.join('\n');
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
        body_source: string | null;
        uncertainty_flags: string[];
    } | null> {
        const result = await db.query(`
            SELECT sv.symbol_id, s.canonical_name, sv.signature,
                   f.path as file_path, sv.range_start_line, sv.range_end_line,
                   sv.body_source, sv.uncertainty_flags
            FROM symbol_versions sv
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            JOIN files f ON f.file_id = sv.file_id
            WHERE sv.symbol_version_id = $1
        `, [svId]);
        return (result.rows[0] as {
            symbol_id: string;
            canonical_name: string;
            signature: string;
            file_path: string;
            range_start_line: number;
            range_end_line: number;
            body_source: string | null;
            uncertainty_flags: string[];
        } | undefined) ?? null;
    }

    private async loadDirectDependencies(svId: string): Promise<ContextNode[]> {
        const result = await db.query(`
            SELECT sv.symbol_version_id, s.canonical_name, sv.signature, sv.summary,
                   sv.body_source, sr.relation_type, sr.confidence
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
            body_source: string | null;
            relation_type: string;
            confidence: number;
        }[]).map(row => ({
            type: 'dependency' as const,
            symbol_id: row.symbol_version_id,
            name: row.canonical_name,
            code: row.body_source ?? null,
            summary: `${row.relation_type}: ${row.signature || row.summary || 'no summary'}`,
            relevance: row.confidence,
        }));
    }

    private async loadCallers(svId: string): Promise<ContextNode[]> {
        const result = await db.query(`
            SELECT sv.symbol_version_id, s.canonical_name, sv.signature, sv.summary,
                   sv.body_source, sr.confidence
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
            body_source: string | null;
            confidence: number;
        }[]).map(row => ({
            type: 'caller' as const,
            symbol_id: row.symbol_version_id,
            name: row.canonical_name,
            code: row.body_source ?? null,
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
                   s.canonical_name, sv.signature, sv.body_source
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
            body_source: string | null;
        }[]).map(row => ({
            type: 'homolog' as const,
            symbol_id: row.dst_symbol_version_id,
            name: row.canonical_name,
            code: row.body_source ?? null,
            summary: `${row.relation_type} (confidence: ${row.confidence.toFixed(2)}): ${row.signature || 'no signature'}`,
            relevance: row.confidence,
        }));
    }
}

export const capsuleCompiler = new CapsuleCompiler();
