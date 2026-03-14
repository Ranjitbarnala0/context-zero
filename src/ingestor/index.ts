/**
 * ContextZero — Ingestion Pipeline
 *
 * Orchestrates full codebase ingestion: file discovery, language dispatch,
 * symbol extraction, relation resolution, behavioral profiling, and
 * contract extraction.
 *
 * Security: Uses execFileSync (array args) instead of execSync (shell string)
 * for Python adapter invocation to prevent command injection.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { Logger } from '../logger';
import { coreDataService } from '../db-driver/core_data';
import { structuralGraphEngine } from '../analysis-engine';
import { behavioralEngine } from '../analysis-engine/behavioral';
import { contractEngine } from '../analysis-engine/contracts';
import { extractFromTypeScript } from '../adapters/ts';
import { db } from '../db-driver';
import { profileCache } from '../cache';
import type { PoolClient } from 'pg';
import type { SymbolVersionRow } from '../db-driver/core_data';
import type {
    AdapterExtractionResult, IngestionResult,
    ExtractedSymbol,
} from '../types';

const log = new Logger('ingestor');

/** File extensions to language mapping */
const LANGUAGE_MAP: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.py': 'python',
    '.cpp': 'cpp',
    '.cc': 'cpp',
    '.cxx': 'cpp',
    '.hpp': 'cpp',
    '.h': 'cpp',
    '.go': 'go',
    '.json': 'json',
};

/** Directories to always skip */
const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', 'coverage',
    '__pycache__', '.next', '.nuxt', '.venv', 'venv',
]);

/** Max file size to process (5MB) */
const MAX_FILE_SIZE = 5 * 1024 * 1024;

export class Ingestor {

    /**
     * Ingest a full repository into the ContextZero graph.
     */
    public async ingestRepo(
        repoPath: string,
        repoName: string,
        commitSha: string,
        branch: string = 'main'
    ): Promise<IngestionResult> {
        const timer = log.startTimer('ingestRepo', { repoPath, repoName, commitSha });
        const startTime = Date.now();

        // 1. Ensure repository exists
        const repoId = await coreDataService.createRepository({
            name: repoName,
            default_branch: branch,
            visibility: 'private',
            language_set: [],
        });

        // 2. Create snapshot
        const snapshotId = await coreDataService.createSnapshot({
            repo_id: repoId,
            commit_sha: commitSha,
            branch,
        });

        await coreDataService.updateSnapshotStatus(snapshotId, 'indexing');

        // 3. Discover files
        const files = this.discoverFiles(repoPath);
        log.info('Files discovered', { count: files.length });

        // 4. Group files by language
        const tsPaths: string[] = [];
        const pyPaths: string[] = [];
        const cppPaths: string[] = [];
        const goPaths: string[] = [];
        let filesProcessed = 0;
        let filesFailed = 0;
        let symbolsExtracted = 0;
        let relationsExtracted = 0;
        let behaviorHintsExtracted = 0;
        let contractHintsExtracted = 0;
        const languageSet = new Set<string>();

        for (const filePath of files) {
            const ext = path.extname(filePath);
            const lang = LANGUAGE_MAP[ext];
            if (!lang) continue;

            languageSet.add(lang);
            const relativePath = path.relative(repoPath, filePath);
            const contentHash = this.hashFile(filePath);

            // Register file
            await coreDataService.addFile({
                snapshot_id: snapshotId,
                path: relativePath,
                content_hash: contentHash,
                language: lang,
            });

            if (lang === 'typescript' || lang === 'javascript') {
                tsPaths.push(filePath);
            } else if (lang === 'python') {
                pyPaths.push(filePath);
            } else if (lang === 'cpp') {
                cppPaths.push(filePath);
            } else if (lang === 'go') {
                goPaths.push(filePath);
            }
        }

        // 5. Extract from TypeScript files
        if (tsPaths.length > 0) {
            const tsconfigPath = this.findTsconfig(repoPath);
            try {
                const tsResult = extractFromTypeScript(tsPaths, tsconfigPath || undefined);
                const counts = await this.persistExtractionResult(
                    tsResult, repoId, snapshotId, repoPath, 'typescript'
                );
                symbolsExtracted += counts.symbols;
                relationsExtracted += counts.relations;
                behaviorHintsExtracted += counts.behaviorHints;
                contractHintsExtracted += counts.contractHints;
                filesProcessed += tsPaths.length;
            } catch (err) {
                log.error('TypeScript extraction failed', err);
                filesFailed += tsPaths.length;
            }
        }

        // 6. Extract from Python files
        for (const pyPath of pyPaths) {
            try {
                const pyResult = this.extractFromPython(pyPath, repoPath);
                if (pyResult) {
                    const counts = await this.persistExtractionResult(
                        pyResult, repoId, snapshotId, repoPath, 'python'
                    );
                    symbolsExtracted += counts.symbols;
                    relationsExtracted += counts.relations;
                    behaviorHintsExtracted += counts.behaviorHints;
                    contractHintsExtracted += counts.contractHints;
                    filesProcessed++;
                }
            } catch (err) {
                log.error('Python extraction failed', err, { file: pyPath });
                filesFailed++;
            }
        }

        // 6b. Extract from C++ and Go files via tree-sitter universal adapter
        const treeSitterPaths: { filePath: string; lang: 'cpp' | 'go' }[] = [
            ...cppPaths.map(p => ({ filePath: p, lang: 'cpp' as const })),
            ...goPaths.map(p => ({ filePath: p, lang: 'go' as const })),
        ];

        for (const { filePath, lang } of treeSitterPaths) {
            try {
                const result = this.extractWithUniversalAdapter(filePath, repoPath, lang);
                if (result) {
                    const counts = await this.persistExtractionResult(
                        result, repoId, snapshotId, repoPath, lang
                    );
                    symbolsExtracted += counts.symbols;
                    relationsExtracted += counts.relations;
                    behaviorHintsExtracted += counts.behaviorHints;
                    contractHintsExtracted += counts.contractHints;
                    filesProcessed++;
                }
            } catch (err) {
                log.error(`${lang} extraction failed`, err, { file: filePath });
                filesFailed++;
            }
        }

        // 7. Resolve structural relations
        const svRows = await coreDataService.getSymbolVersionsForSnapshot(snapshotId);
        // Mine invariants from tests
        await contractEngine.mineInvariantsFromTests(repoId, snapshotId, svRows);

        // 7.5 Populate test artifacts
        await this.populateTestArtifacts(svRows, snapshotId, repoId);

        // 8. Update snapshot status
        const finalStatus = filesFailed > 0 && filesProcessed === 0 ? 'failed'
            : filesFailed > 0 ? 'partial'
            : 'complete';
        await coreDataService.updateSnapshotStatus(snapshotId, finalStatus);

        const result: IngestionResult = {
            repo_id: repoId,
            snapshot_id: snapshotId,
            files_processed: filesProcessed,
            files_failed: filesFailed,
            symbols_extracted: symbolsExtracted,
            relations_extracted: relationsExtracted,
            behavior_hints_extracted: behaviorHintsExtracted,
            contract_hints_extracted: contractHintsExtracted,
            duration_ms: Date.now() - startTime,
        };

        timer(result as unknown as Record<string, unknown>);
        return result;
    }

    /**
     * Persist extraction results to the database.
     * Symbol version INSERTs are accumulated and batched via db.batchInsert().
     */
    private async persistExtractionResult(
        extraction: AdapterExtractionResult,
        repoId: string,
        snapshotId: string,
        repoPath: string,
        language: string
    ): Promise<{ symbols: number; relations: number; behaviorHints: number; contractHints: number }> {

        // Accumulate symbol version INSERT statements for batching
        const svInsertStatements: { text: string; params: unknown[] }[] = [];
        // Track symbol version IDs and their corresponding symbols for post-batch processing
        const svEntries: { svId: string; sym: ExtractedSymbol }[] = [];

        // Phase 1: Merge symbols and prepare batch inserts
        for (const sym of extraction.symbols) {
            const symbolId = await coreDataService.mergeSymbol({
                repo_id: repoId,
                stable_key: sym.stable_key,
                canonical_name: sym.canonical_name,
                kind: sym.kind,
            });

            const relativePath = sym.stable_key.split('#')[0] || '';
            const fileResult = await db.query(
                `SELECT file_id FROM files WHERE snapshot_id = $1 AND path = $2`,
                [snapshotId, relativePath]
            );
            const fileId = fileResult.rows[0]?.file_id as string;
            if (!fileId) continue;

            const svId = crypto.randomUUID();
            svInsertStatements.push({
                text: `
                    INSERT INTO symbol_versions (
                        symbol_version_id, symbol_id, snapshot_id, file_id,
                        range_start_line, range_start_col, range_end_line, range_end_col,
                        signature, ast_hash, body_hash, normalized_ast_hash,
                        summary, visibility, language, uncertainty_flags
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
                    ON CONFLICT (symbol_id, snapshot_id) DO UPDATE SET
                        file_id = EXCLUDED.file_id,
                        range_start_line = EXCLUDED.range_start_line,
                        range_start_col = EXCLUDED.range_start_col,
                        range_end_line = EXCLUDED.range_end_line,
                        range_end_col = EXCLUDED.range_end_col,
                        signature = EXCLUDED.signature,
                        ast_hash = EXCLUDED.ast_hash,
                        body_hash = EXCLUDED.body_hash,
                        normalized_ast_hash = EXCLUDED.normalized_ast_hash,
                        summary = EXCLUDED.summary,
                        visibility = EXCLUDED.visibility,
                        language = EXCLUDED.language,
                        uncertainty_flags = EXCLUDED.uncertainty_flags
                `,
                params: [
                    svId, symbolId, snapshotId, fileId,
                    sym.range_start_line, sym.range_start_col, sym.range_end_line, sym.range_end_col,
                    sym.signature, sym.ast_hash, sym.body_hash, sym.normalized_ast_hash || null,
                    '', sym.visibility, language,
                    // Only propagate file-level uncertainty flags to symbols.
                    // Function-specific flags (call_extraction_failure, normalization_failure,
                    // type_inference_failure) are per-symbol and should not be broadcast
                    // to every symbol in the file.
                    (extraction.uncertainty_flags || []).filter(f =>
                        f === 'parse_error' || f === 'encoding_fallback' || f === 'extraction_error'
                    )
                ],
            });
            svEntries.push({ svId, sym });
        }

        // Phase 2: Batch insert all symbol versions in a single transaction
        if (svInsertStatements.length > 0) {
            await db.batchInsert(svInsertStatements);
        }

        // Phase 3: Process behavior and contract hints (requires svIds from batch)
        for (const { svId, sym } of svEntries) {
            // Process behavior hints for this symbol.
            // Always create a profile — even for symbols with zero hints.
            // A pure function with empty arrays IS its behavioral profile.
            // Skipping this would cause "profile not found" for pure functions.
            const symHints = extraction.behavior_hints.filter(h => h.symbol_key === sym.stable_key);
            await behavioralEngine.extractBehavioralProfiles(svId, symHints);

            // Process contract hints for this symbol
            const symContracts = extraction.contract_hints.filter(h => h.symbol_key === sym.stable_key);
            for (const hint of symContracts) {
                await contractEngine.extractContractProfile(svId, hint);
            }
        }

        // Resolve structural relations
        const relCount = await structuralGraphEngine.computeRelationsFromRaw(
            snapshotId, repoId, extraction.relations
        );

        return {
            symbols: extraction.symbols.length,
            relations: relCount,
            behaviorHints: extraction.behavior_hints.length,
            contractHints: extraction.contract_hints.length,
        };
    }

    /**
     * Extract symbols from a Python file using the LibCST extractor.
     * Uses execFileSync with array args (not shell string) to prevent injection.
     */
    private extractFromPython(filePath: string, repoPath: string): AdapterExtractionResult | null {
        const extractorPath = path.join(__dirname, '..', 'adapters', 'py', 'extractor.py');

        if (!fs.existsSync(extractorPath)) {
            log.warn('Python extractor not found', { path: extractorPath });
            return null;
        }

        try {
            // execFileSync with array args — safe from command injection
            const output = execFileSync('python3', [extractorPath, filePath], {
                cwd: repoPath,
                timeout: 30_000,
                maxBuffer: 1_048_576,
                encoding: 'utf-8',
            });

            const parsed = JSON.parse(output) as AdapterExtractionResult;

            // Validate the parsed result has the expected shape
            if (!parsed || !Array.isArray(parsed.symbols)) {
                log.warn('Python extractor returned invalid structure', { file: filePath });
                return null;
            }

            // Normalize stable keys: the Python extractor uses the absolute file
            // path passed via CLI, but the DB stores relative paths. Rewrite all
            // stable keys from "/abs/path/to/file.py#Name" → "relative/file.py#Name"
            const relativePath = path.relative(repoPath, filePath);
            for (const sym of parsed.symbols) {
                const hashIdx = sym.stable_key.indexOf('#');
                if (hashIdx >= 0) {
                    sym.stable_key = relativePath + sym.stable_key.substring(hashIdx);
                }
            }
            for (const rel of parsed.relations) {
                const srcHash = rel.source_key.indexOf('#');
                if (srcHash >= 0) {
                    rel.source_key = relativePath + rel.source_key.substring(srcHash);
                }
            }
            for (const hint of parsed.behavior_hints) {
                const hintHash = hint.symbol_key.indexOf('#');
                if (hintHash >= 0) {
                    hint.symbol_key = relativePath + hint.symbol_key.substring(hintHash);
                }
            }
            for (const hint of parsed.contract_hints) {
                const hintHash = hint.symbol_key.indexOf('#');
                if (hintHash >= 0) {
                    hint.symbol_key = relativePath + hint.symbol_key.substring(hintHash);
                }
            }

            return parsed;
        } catch (err) {
            log.error('Python extractor failed', err, { file: filePath });
            return null;
        }
    }

    /**
     * Identify test files and create test_artifact records.
     * Links tests to the symbols they reference via structural relations.
     */
    private async populateTestArtifacts(
        svRows: SymbolVersionRow[],
        _snapshotId: string,
        _repoId: string
    ): Promise<number> {
        let count = 0;

        // Identify test symbols
        const testSvs = svRows.filter(sv =>
            sv.file_path.includes('.test.') ||
            sv.file_path.includes('.spec.') ||
            sv.file_path.includes('__tests__')
        );

        for (const testSv of testSvs) {
            // Find which non-test symbols this test references
            // by checking structural_relations from this test symbol
            const relResult = await db.query(`
                SELECT DISTINCT sr.dst_symbol_version_id
                FROM structural_relations sr
                WHERE sr.src_symbol_version_id = $1
                AND sr.relation_type IN ('calls', 'references', 'imports')
            `, [testSv.symbol_version_id]);

            const relatedSymbols = relResult.rows
                .map((r: { dst_symbol_version_id: string }) => r.dst_symbol_version_id)
                .filter((id: string) => !testSvs.some(t => t.symbol_version_id === id));

            // Detect test framework
            let framework = 'unknown';
            if (testSv.file_path.includes('.test.ts') || testSv.file_path.includes('.test.js')) {
                framework = 'jest';
            } else if (testSv.file_path.includes('.spec.ts') || testSv.file_path.includes('.spec.js')) {
                framework = 'jest'; // or mocha
            } else if (testSv.file_path.endsWith('.py')) {
                framework = 'pytest';
            }

            await coreDataService.insertTestArtifact({
                symbol_version_id: testSv.symbol_version_id,
                framework,
                related_symbols: relatedSymbols,
                assertion_summary: `Test: ${testSv.canonical_name}`,
                coverage_hints: null,
            });
            count++;
        }

        log.info('Test artifacts populated', { count });
        return count;
    }

    /**
     * Extract symbols from C++/Go files using the tree-sitter universal adapter.
     */
    private extractWithUniversalAdapter(
        filePath: string,
        repoPath: string,
        language: 'cpp' | 'go'
    ): AdapterExtractionResult | null {
        try {
            // Lazy-load to avoid tree-sitter initialization cost when not needed
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { extractWithTreeSitter } = require('../adapters/universal') as {
                extractWithTreeSitter: (fp: string, src: string, lang: string) => AdapterExtractionResult;
            };
            const source = fs.readFileSync(filePath, 'utf-8');
            const relativePath = path.relative(repoPath, filePath);
            return extractWithTreeSitter(relativePath, source, language);
        } catch (err) {
            log.error('Tree-sitter extraction failed', err, { file: filePath, language });
            return null;
        }
    }

    /**
     * Discover all processable files in the repository.
     */
    private discoverFiles(repoPath: string): string[] {
        const files: string[] = [];

        function walk(dir: string): void {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const entryPath = path.join(dir, entry.name);

                // Skip symlinks to prevent symlink-based traversal attacks
                try {
                    if (fs.lstatSync(entryPath).isSymbolicLink()) {
                        log.warn('Skipping symlink during file discovery', { path: entryPath });
                        continue;
                    }
                } catch {
                    // Skip entries we cannot stat
                    continue;
                }

                if (entry.isDirectory()) {
                    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
                    walk(entryPath);
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name);
                    if (LANGUAGE_MAP[ext]) {
                        try {
                            const stat = fs.statSync(entryPath);
                            if (stat.size <= MAX_FILE_SIZE) {
                                files.push(entryPath);
                            }
                        } catch {
                            // Skip unreadable files
                        }
                    }
                }
            }
        }

        walk(repoPath);
        return files;
    }

    private hashFile(filePath: string): string {
        const content = fs.readFileSync(filePath);
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    /**
     * Incremental indexing: re-parse only changed files.
     * Accepts a list of changed file paths (from git diff), invalidates
     * affected symbols, re-extracts, re-computes profiles and relations.
     */
    public async ingestIncremental(
        repoId: string,
        snapshotId: string,
        changedPaths: string[]
    ): Promise<{ symbolsUpdated: number; relationsUpdated: number }> {
        const timer = log.startTimer('ingestIncremental', {
            repoId, snapshotId, changedCount: changedPaths.length,
        });

        // Get repo base path from DB
        const repoResult = await db.query(
            `SELECT base_path FROM repositories WHERE repo_id = $1`,
            [repoId]
        );
        const basePath = repoResult.rows[0]?.base_path as string | undefined;
        if (!basePath) throw new Error(`Repository base path not configured for repo: ${repoId}`);

        let symbolsUpdated = 0;
        let relationsUpdated = 0;

        // 1. Delete old symbol_versions for changed files
        // Wrapped in a single DB transaction for atomicity
        const invalidatedSvIds: string[] = [];
        await db.transaction(async (client: PoolClient) => {
            for (const changedPath of changedPaths) {
                const fileResult = await db.queryWithClient(client,
                    `SELECT file_id FROM files WHERE snapshot_id = $1 AND path = $2`,
                    [snapshotId, changedPath]
                );
                const fileId = fileResult.rows[0]?.file_id as string | undefined;

                if (fileId) {
                    // Collect symbol_version_ids being invalidated for cache eviction
                    const svResult = await db.queryWithClient(client,
                        `SELECT symbol_version_id FROM symbol_versions WHERE file_id = $1`,
                        [fileId]
                    );
                    for (const row of svResult.rows as { symbol_version_id: string }[]) {
                        invalidatedSvIds.push(row.symbol_version_id);
                    }

                    // Delete structural relations touching these symbol versions
                    await db.queryWithClient(client, `
                        DELETE FROM structural_relations
                        WHERE src_symbol_version_id IN (
                            SELECT symbol_version_id FROM symbol_versions WHERE file_id = $1
                        ) OR dst_symbol_version_id IN (
                            SELECT symbol_version_id FROM symbol_versions WHERE file_id = $1
                        )
                    `, [fileId]);

                    // Delete behavioral/contract profiles
                    await db.queryWithClient(client, `
                        DELETE FROM behavioral_profiles WHERE symbol_version_id IN (
                            SELECT symbol_version_id FROM symbol_versions WHERE file_id = $1
                        )
                    `, [fileId]);
                    await db.queryWithClient(client, `
                        DELETE FROM contract_profiles WHERE symbol_version_id IN (
                            SELECT symbol_version_id FROM symbol_versions WHERE file_id = $1
                        )
                    `, [fileId]);

                    // Delete semantic vectors
                    await db.queryWithClient(client, `
                        DELETE FROM semantic_vectors WHERE symbol_version_id IN (
                            SELECT symbol_version_id FROM symbol_versions WHERE file_id = $1
                        )
                    `, [fileId]);

                    // Mark inferred_relations as stale (set valid_to)
                    await db.queryWithClient(client, `
                        UPDATE inferred_relations SET valid_to_snapshot_id = $1
                        WHERE valid_to_snapshot_id IS NULL
                        AND (src_symbol_version_id IN (
                            SELECT symbol_version_id FROM symbol_versions WHERE file_id = $2
                        ) OR dst_symbol_version_id IN (
                            SELECT symbol_version_id FROM symbol_versions WHERE file_id = $2
                        ))
                    `, [snapshotId, fileId]);

                    // Delete old symbol versions for this file
                    await db.queryWithClient(client,
                        `DELETE FROM symbol_versions WHERE file_id = $1 AND snapshot_id = $2`,
                        [fileId, snapshotId]
                    );
                }
            }
        });

        // Invalidate in-process caches for deleted profiles
        // This ensures subsequent reads don't serve stale behavioral/contract data
        for (const svId of invalidatedSvIds) {
            profileCache.invalidate(`bp:${svId}`);
            profileCache.invalidate(`cp:${svId}`);
        }
        log.debug('Cache invalidated for incremental reindex', {
            invalidatedSymbols: invalidatedSvIds.length,
        });

        // 2. Re-extract from changed files
        const tsPaths: string[] = [];
        const pyPaths: string[] = [];
        const cppPaths: string[] = [];
        const goPaths: string[] = [];

        for (const changedPath of changedPaths) {
            const fullPath = this.resolveSafePath(basePath, changedPath);
            if (!fs.existsSync(fullPath)) continue;

            const ext = path.extname(changedPath);
            const lang = LANGUAGE_MAP[ext];
            if (!lang) continue;

            // Update file hash
            const contentHash = this.hashFile(fullPath);
            await db.query(
                `UPDATE files SET content_hash = $1, parse_status = 'parsed' WHERE snapshot_id = $2 AND path = $3`,
                [contentHash, snapshotId, changedPath]
            );

            if (lang === 'typescript' || lang === 'javascript') {
                tsPaths.push(fullPath);
            } else if (lang === 'python') {
                pyPaths.push(fullPath);
            } else if (lang === 'cpp') {
                cppPaths.push(fullPath);
            } else if (lang === 'go') {
                goPaths.push(fullPath);
            }
        }

        // 3. Re-extract TypeScript
        if (tsPaths.length > 0) {
            const tsconfigPath = this.findTsconfig(basePath);
            try {
                const tsResult = extractFromTypeScript(tsPaths, tsconfigPath || undefined);
                const counts = await this.persistExtractionResult(
                    tsResult, repoId, snapshotId, basePath, 'typescript'
                );
                symbolsUpdated += counts.symbols;
                relationsUpdated += counts.relations;
            } catch (err) {
                log.error('Incremental TS extraction failed', err);
            }
        }

        // 4. Re-extract Python
        for (const pyPath of pyPaths) {
            try {
                const pyResult = this.extractFromPython(pyPath, basePath);
                if (pyResult) {
                    const counts = await this.persistExtractionResult(
                        pyResult, repoId, snapshotId, basePath, 'python'
                    );
                    symbolsUpdated += counts.symbols;
                    relationsUpdated += counts.relations;
                }
            } catch (err) {
                log.error('Incremental Python extraction failed', err, { file: pyPath });
            }
        }

        // 4b. Re-extract C++ and Go via tree-sitter universal adapter
        const treeSitterPaths: { filePath: string; lang: 'cpp' | 'go' }[] = [
            ...cppPaths.map(p => ({ filePath: p, lang: 'cpp' as const })),
            ...goPaths.map(p => ({ filePath: p, lang: 'go' as const })),
        ];

        for (const { filePath, lang } of treeSitterPaths) {
            try {
                const result = this.extractWithUniversalAdapter(filePath, basePath, lang);
                if (result) {
                    const counts = await this.persistExtractionResult(
                        result, repoId, snapshotId, basePath, lang
                    );
                    symbolsUpdated += counts.symbols;
                    relationsUpdated += counts.relations;
                }
            } catch (err) {
                log.error(`Incremental ${lang} extraction failed`, err, { file: filePath });
            }
        }

        // 5. Re-populate test artifacts for affected files
        const allSvRows = await coreDataService.getSymbolVersionsForSnapshot(snapshotId);
        await this.populateTestArtifacts(allSvRows, snapshotId, repoId);

        const result = { symbolsUpdated, relationsUpdated };
        timer(result as unknown as Record<string, unknown>);
        return result;
    }

    /**
     * Resolve a file path safely within a base directory.
     * Resolves symlinks on the base path first to prevent symlink-based escapes.
     */
    private resolveSafePath(basePath: string, filePath: string): string {
        const realBase = fs.realpathSync(path.resolve(basePath));
        const resolved = path.resolve(realBase, filePath);
        if (!resolved.startsWith(realBase + path.sep) && resolved !== realBase) {
            throw new Error(`Path traversal attempt blocked: ${filePath}`);
        }
        return resolved;
    }

    private findTsconfig(repoPath: string): string | null {
        const tsconfig = path.join(repoPath, 'tsconfig.json');
        return fs.existsSync(tsconfig) ? tsconfig : null;
    }
}

export const ingestor = new Ingestor();
