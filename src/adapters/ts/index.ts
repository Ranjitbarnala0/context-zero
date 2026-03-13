/**
 * ContextZero — TypeScript Language Adapter
 *
 * Symbol extraction using the TypeScript Compiler API.
 * Extracts symbols, relations, behavior hints, and contract hints
 * from source code.
 *
 * Uses:
 * - ts.createProgram for project-level type resolution
 * - ts.TypeChecker for type information extraction
 * - AST walking for symbol boundary detection
 * - 30+ regex patterns for behavioral side-effect detection
 * - SHA-256 hashing for AST and body fingerprints
 */

import * as ts from 'typescript';
import * as crypto from 'crypto';
import * as path from 'path';
import { Logger } from '../../logger';
import type {
    AdapterExtractionResult, ExtractedSymbol, ExtractedRelation,
    BehaviorHint, ContractHint,
} from '../../types';
import { normalizeForComparison } from './ast-normalizer';

const log = new Logger('ts-adapter');

/** Side-effect detection patterns for behavioral hints */
const BEHAVIOR_PATTERNS: { pattern: RegExp; hint_type: BehaviorHint['hint_type']; detail: string }[] = [
    // DB reads
    { pattern: /\.find(One|Many|All|ById)?\s*\(/, hint_type: 'db_read', detail: 'orm_find' },
    { pattern: /\.select\s*\(/, hint_type: 'db_read', detail: 'query_select' },
    { pattern: /\.query\s*\(/, hint_type: 'db_read', detail: 'raw_query' },
    { pattern: /\.get(One|Many|All)?\s*\(/, hint_type: 'db_read', detail: 'db_get' },
    // DB writes
    { pattern: /\.save\s*\(/, hint_type: 'db_write', detail: 'orm_save' },
    { pattern: /\.insert\s*\(/, hint_type: 'db_write', detail: 'db_insert' },
    { pattern: /\.update\s*\(/, hint_type: 'db_write', detail: 'db_update' },
    { pattern: /\.delete\s*\(/, hint_type: 'db_write', detail: 'db_delete' },
    { pattern: /\.remove\s*\(/, hint_type: 'db_write', detail: 'db_remove' },
    { pattern: /\.create\s*\(/, hint_type: 'db_write', detail: 'db_create' },
    // Network calls
    { pattern: /fetch\s*\(/, hint_type: 'network_call', detail: 'fetch' },
    { pattern: /axios\.(get|post|put|patch|delete)\s*\(/, hint_type: 'network_call', detail: 'axios' },
    { pattern: /\.request\s*\(/, hint_type: 'network_call', detail: 'http_request' },
    { pattern: /https?\.\s*(get|request)\s*\(/, hint_type: 'network_call', detail: 'node_http' },
    { pattern: /WebSocket/, hint_type: 'network_call', detail: 'websocket' },
    // File I/O
    { pattern: /fs\.(read|write|append|unlink|mkdir|rmdir)/, hint_type: 'file_io', detail: 'fs_operation' },
    { pattern: /readFile(Sync)?\s*\(/, hint_type: 'file_io', detail: 'read_file' },
    { pattern: /writeFile(Sync)?\s*\(/, hint_type: 'file_io', detail: 'write_file' },
    // Cache operations
    { pattern: /\.cache\.(get|set|del|clear)/, hint_type: 'cache_op', detail: 'cache_operation' },
    { pattern: /redis\.(get|set|hget|hset|del)/, hint_type: 'cache_op', detail: 'redis' },
    // Auth
    { pattern: /\.authenticate\s*\(/, hint_type: 'auth_check', detail: 'authenticate' },
    { pattern: /\.authorize\s*\(/, hint_type: 'auth_check', detail: 'authorize' },
    { pattern: /verify(Token|JWT|Session)/, hint_type: 'auth_check', detail: 'token_verify' },
    { pattern: /\.isAuthenticated/, hint_type: 'auth_check', detail: 'auth_check' },
    // Validation
    { pattern: /\.validate\s*\(/, hint_type: 'validation', detail: 'validate' },
    { pattern: /Joi\.|Yup\.|Zod\./, hint_type: 'validation', detail: 'schema_validation' },
    // Exception handling
    { pattern: /throw\s+new\s+\w+/, hint_type: 'throws', detail: 'throws' },
    { pattern: /catch\s*\(/, hint_type: 'catches', detail: 'catches' },
    // State mutation
    { pattern: /this\.\w+\s*=/, hint_type: 'state_mutation', detail: 'this_assignment' },
    { pattern: /\.setState\s*\(/, hint_type: 'state_mutation', detail: 'set_state' },
    // Transactions
    { pattern: /\.transaction\s*\(/, hint_type: 'transaction', detail: 'db_transaction' },
    { pattern: /BEGIN|COMMIT|ROLLBACK/, hint_type: 'transaction', detail: 'sql_transaction' },
    // Logging (informational only)
    { pattern: /console\.(log|warn|error|info)/, hint_type: 'logging', detail: 'console' },
    { pattern: /log\.(debug|info|warn|error|fatal)/, hint_type: 'logging', detail: 'structured_log' },
];

function sha256(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

function getVisibility(node: ts.Node): string {
    const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    if (mods) {
        for (const mod of mods) {
            if (mod.kind === ts.SyntaxKind.PrivateKeyword) return 'private';
            if (mod.kind === ts.SyntaxKind.ProtectedKeyword) return 'protected';
        }
    }
    // Check for export keyword
    if (mods?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) return 'public';
    return 'internal';
}

function getNodeText(node: ts.Node, sourceFile: ts.SourceFile): string {
    return node.getText(sourceFile);
}

function getSignature(node: ts.Node, sourceFile: ts.SourceFile, checker: ts.TypeChecker): string {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
        const name = node.name?.getText(sourceFile) || 'anonymous';
        const params = node.parameters.map(p => {
            const pName = p.name.getText(sourceFile);
            const pType = p.type ? p.type.getText(sourceFile) : checker.typeToString(checker.getTypeAtLocation(p));
            return `${pName}: ${pType}`;
        }).join(', ');
        const returnType = node.type
            ? node.type.getText(sourceFile)
            : checker.typeToString(checker.getReturnTypeOfSignature(
                checker.getSignatureFromDeclaration(node)!
            ));
        return `${name}(${params}): ${returnType}`;
    }
    if (ts.isClassDeclaration(node)) {
        return `class ${node.name?.getText(sourceFile) || 'anonymous'}`;
    }
    if (ts.isInterfaceDeclaration(node)) {
        return `interface ${node.name.getText(sourceFile)}`;
    }
    if (ts.isTypeAliasDeclaration(node)) {
        return `type ${node.name.getText(sourceFile)}`;
    }
    if (ts.isEnumDeclaration(node)) {
        return `enum ${node.name.getText(sourceFile)}`;
    }
    if (ts.isVariableDeclaration(node)) {
        return node.name.getText(sourceFile);
    }
    return node.getText(sourceFile).substring(0, 100);
}

function classifyKind(node: ts.Node, sourceFile: ts.SourceFile): string {
    if (ts.isClassDeclaration(node)) return 'class';
    if (ts.isInterfaceDeclaration(node)) return 'interface';
    if (ts.isTypeAliasDeclaration(node)) return 'type_alias';
    if (ts.isEnumDeclaration(node)) return 'enum';
    if (ts.isMethodDeclaration(node)) return 'method';
    if (ts.isFunctionDeclaration(node)) {
        const text = node.getText(sourceFile);
        if (/router\.(get|post|put|delete|patch)|app\.(get|post|put|delete|patch)/.test(text)) {
            return 'route_handler';
        }
        return 'function';
    }
    if (ts.isVariableDeclaration(node)) return 'variable';
    return 'function';
}

/**
 * Extract all symbols, relations, behavior hints, and contract hints
 * from a set of TypeScript files.
 */
export function extractFromTypeScript(
    filePaths: string[],
    tsconfigPath?: string
): AdapterExtractionResult {
    const timer = log.startTimer('extractFromTypeScript', { fileCount: filePaths.length });
    const uncertaintyFlags: string[] = [];

    // Create program
    let compilerOptions: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        strict: true,
        esModuleInterop: true,
        noEmit: true,
    };

    if (tsconfigPath) {
        const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
        if (!configFile.error) {
            const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(tsconfigPath));
            compilerOptions = parsed.options;
        } else {
            uncertaintyFlags.push('incomplete_type_info');
            log.warn('Failed to read tsconfig', { path: tsconfigPath });
        }
    }

    const program = ts.createProgram(filePaths, compilerOptions);
    const checker = program.getTypeChecker();

    const symbols: ExtractedSymbol[] = [];
    const relations: ExtractedRelation[] = [];
    const behaviorHints: BehaviorHint[] = [];
    const contractHints: ContractHint[] = [];

    for (const filePath of filePaths) {
        const sourceFile = program.getSourceFile(filePath);
        if (!sourceFile) {
            uncertaintyFlags.push('parse_error');
            log.warn('Source file not found in program', { filePath });
            continue;
        }

        extractFromSourceFile(
            sourceFile, checker, filePath,
            symbols, relations, behaviorHints, contractHints, uncertaintyFlags
        );
    }

    timer({
        symbols: symbols.length,
        relations: relations.length,
        behavior_hints: behaviorHints.length,
        contract_hints: contractHints.length,
    });

    return {
        symbols,
        relations,
        behavior_hints: behaviorHints,
        contract_hints: contractHints,
        parse_confidence: uncertaintyFlags.length === 0 ? 1.0 : Math.max(0.5, 1.0 - uncertaintyFlags.length * 0.1),
        uncertainty_flags: [...new Set(uncertaintyFlags)],
    };
}

function extractFromSourceFile(
    sourceFile: ts.SourceFile,
    checker: ts.TypeChecker,
    filePath: string,
    symbols: ExtractedSymbol[],
    relations: ExtractedRelation[],
    behaviorHints: BehaviorHint[],
    contractHints: ContractHint[],
    uncertaintyFlags: string[]
): void {
    const relativePath = filePath;

    function visit(node: ts.Node, parentKey?: string): void {
        // Extract top-level and class-member declarations
        const isExtractable =
            ts.isFunctionDeclaration(node) ||
            ts.isClassDeclaration(node) ||
            ts.isInterfaceDeclaration(node) ||
            ts.isTypeAliasDeclaration(node) ||
            ts.isEnumDeclaration(node) ||
            ts.isMethodDeclaration(node) ||
            (ts.isVariableStatement(node) && node.declarationList.declarations.length > 0);

        if (isExtractable) {
            let name: string | undefined;
            let targetNode: ts.Node = node;

            if (ts.isVariableStatement(node)) {
                const decl = node.declarationList.declarations[0];
                if (decl) {
                    name = decl.name.getText(sourceFile);
                    targetNode = decl;
                }
            } else if ('name' in node && node.name) {
                name = (node.name as ts.Identifier).getText(sourceFile);
            }

            if (name) {
                const stableKey = parentKey
                    ? `${relativePath}#${parentKey}.${name}`
                    : `${relativePath}#${name}`;

                const fullText = getNodeText(node, sourceFile);
                const { line: startLine, character: startCol } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
                const { line: endLine, character: endCol } = sourceFile.getLineAndCharacterOfPosition(node.getEnd());

                let sig = '';
                try {
                    sig = getSignature(targetNode, sourceFile, checker);
                } catch {
                    sig = name;
                    uncertaintyFlags.push('type_inference_failure');
                }

                // Body text = full text minus the first line (signature)
                const bodyText = fullText.includes('{')
                    ? fullText.substring(fullText.indexOf('{'))
                    : fullText;

                // Compute normalized AST hash for structural similarity detection
                let normalizedAstHash: string | undefined;
                try {
                    normalizedAstHash = normalizeForComparison(bodyText);
                } catch {
                    // Fall back gracefully if normalization fails
                    uncertaintyFlags.push('normalization_failure');
                }

                symbols.push({
                    stable_key: stableKey,
                    canonical_name: name,
                    kind: classifyKind(node, sourceFile),
                    range_start_line: startLine + 1,
                    range_start_col: startCol + 1,
                    range_end_line: endLine + 1,
                    range_end_col: endCol + 1,
                    signature: sig,
                    ast_hash: sha256(fullText),
                    body_hash: sha256(bodyText),
                    normalized_ast_hash: normalizedAstHash,
                    visibility: getVisibility(node),
                });

                // Extract behavior hints from function/method bodies
                if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
                    extractBehaviorHints(fullText, stableKey, startLine + 1, behaviorHints);
                    extractContractHint(node, sourceFile, checker, stableKey, contractHints, uncertaintyFlags);
                }

                // Extract relations from function/method bodies
                if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
                    extractRelationsFromBody(node, sourceFile, checker, stableKey, relations);
                }

                // Recurse into class body for methods
                if (ts.isClassDeclaration(node)) {
                    node.members.forEach(member => visit(member, name));
                    // Extract implements/extends relations
                    if (node.heritageClauses) {
                        for (const clause of node.heritageClauses) {
                            const relType = clause.token === ts.SyntaxKind.ImplementsKeyword
                                ? 'implements' : 'inherits';
                            for (const type of clause.types) {
                                relations.push({
                                    source_key: stableKey,
                                    target_name: type.expression.getText(sourceFile),
                                    relation_type: relType as ExtractedRelation['relation_type'],
                                });
                            }
                        }
                    }
                    return; // Don't recurse again
                }
            }
        }

        ts.forEachChild(node, child => visit(child, parentKey));
    }

    visit(sourceFile);
}

function extractBehaviorHints(
    text: string,
    symbolKey: string,
    baseLine: number,
    hints: BehaviorHint[]
): void {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        for (const bp of BEHAVIOR_PATTERNS) {
            if (bp.pattern.test(line)) {
                hints.push({
                    symbol_key: symbolKey,
                    hint_type: bp.hint_type,
                    detail: bp.detail,
                    line: baseLine + i,
                });
            }
        }
    }
}

function extractContractHint(
    node: ts.FunctionDeclaration | ts.MethodDeclaration,
    sourceFile: ts.SourceFile,
    checker: ts.TypeChecker,
    symbolKey: string,
    hints: ContractHint[],
    uncertaintyFlags: string[]
): void {
    try {
        const inputTypes = node.parameters.map(p => {
            if (p.type) return p.type.getText(sourceFile);
            return checker.typeToString(checker.getTypeAtLocation(p));
        });

        let outputType = 'void';
        if (node.type) {
            outputType = node.type.getText(sourceFile);
        } else {
            const sig = checker.getSignatureFromDeclaration(node);
            if (sig) {
                outputType = checker.typeToString(checker.getReturnTypeOfSignature(sig));
            }
        }

        // Extract thrown types from body
        const thrownTypes: string[] = [];
        const text = node.getText(sourceFile);
        const throwMatches = text.matchAll(/throw\s+new\s+(\w+)/g);
        for (const match of throwMatches) {
            if (match[1]) thrownTypes.push(match[1]);
        }

        // Extract decorators
        const decorators: string[] = [];
        const mods = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
        if (mods) {
            for (const dec of mods) {
                decorators.push(dec.getText(sourceFile));
            }
        }

        hints.push({
            symbol_key: symbolKey,
            input_types: inputTypes,
            output_type: outputType,
            thrown_types: [...new Set(thrownTypes)],
            decorators,
        });
    } catch {
        uncertaintyFlags.push('type_inference_failure');
    }
}

function extractRelationsFromBody(
    node: ts.FunctionDeclaration | ts.MethodDeclaration,
    sourceFile: ts.SourceFile,
    checker: ts.TypeChecker,
    sourceKey: string,
    relations: ExtractedRelation[]
): void {
    function walkBody(child: ts.Node): void {
        // Detect call expressions
        if (ts.isCallExpression(child)) {
            let targetName: string | undefined;

            if (ts.isIdentifier(child.expression)) {
                targetName = child.expression.getText(sourceFile);
            } else if (ts.isPropertyAccessExpression(child.expression)) {
                targetName = child.expression.name.getText(sourceFile);
            }

            if (targetName) {
                relations.push({
                    source_key: sourceKey,
                    target_name: targetName,
                    relation_type: 'calls',
                });
            }
        }

        // Detect type references
        if (ts.isTypeReferenceNode(child)) {
            const typeName = child.typeName.getText(sourceFile);
            relations.push({
                source_key: sourceKey,
                target_name: typeName,
                relation_type: 'typed_as',
            });
        }

        ts.forEachChild(child, walkBody);
    }

    if (node.body) {
        ts.forEachChild(node.body, walkBody);
    }
}
