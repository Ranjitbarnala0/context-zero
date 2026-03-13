/**
 * ContextZero — Universal Language Adapter (tree-sitter)
 *
 * Production-grade multi-language symbol/relation/behavior/contract extraction
 * using tree-sitter for CST parsing. Supports TypeScript, JavaScript, Python,
 * C++, and Go.
 *
 * Key design decisions:
 * - One shared BEHAVIOR_PATTERNS array (regex-based side-effect detection)
 * - Language-specific walkers for symbol/relation/contract extraction
 * - Stable keys: "relativePath::ParentClass.symbolName"
 * - SHA-256 hashing for ast_hash (s-expression), body_hash (raw text),
 *   and normalized_ast_hash (comments/whitespace stripped)
 * - Graceful degradation on parse errors with confidence scoring
 */

import * as crypto from 'crypto';
import { Logger } from '../../logger';
import type {
    AdapterExtractionResult,
    ExtractedSymbol,
    ExtractedRelation,
    BehaviorHint,
    ContractHint,
    StructuralRelationType,
} from '../../types';

// tree-sitter is a CommonJS native addon — must use require for native bindings
/* eslint-disable @typescript-eslint/no-require-imports */
const Parser = require('tree-sitter');

type SyntaxNode = InstanceType<typeof Parser>['parse'] extends (s: string) => { rootNode: infer N } ? N : any; // eslint-disable-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any

const _log = new Logger('universal-adapter');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SupportedLanguage = 'typescript' | 'javascript' | 'python' | 'cpp' | 'go';

// ---------------------------------------------------------------------------
// Grammar loading (lazy, cached)
// ---------------------------------------------------------------------------

const grammarCache = new Map<SupportedLanguage, any>();

function getGrammar(language: SupportedLanguage): any {
    if (grammarCache.has(language)) return grammarCache.get(language)!;

    let grammar: any;
    switch (language) {
        case 'typescript': {
            // tree-sitter-typescript exports .typescript and .tsx sub-grammars
            const tsLangs = require('tree-sitter-typescript');
            grammar = tsLangs.typescript;
            break;
        }
        case 'javascript': {
            // tree-sitter-typescript depends on tree-sitter-javascript
            // The typescript grammar can parse JS; alternatively we can use its
            // tsx sub-grammar which is a superset. However, for maximum fidelity
            // we use the typescript sub-grammar (it handles JS fine).
            const tsLangs = require('tree-sitter-typescript');
            grammar = tsLangs.typescript;
            break;
        }
        case 'python':
            grammar = require('tree-sitter-python');
            break;
        case 'cpp':
            grammar = require('tree-sitter-cpp');
            break;
        case 'go':
            grammar = require('tree-sitter-go');
            break;
        default:
            throw new Error(`Unsupported language: ${language}`);
    }

    grammarCache.set(language, grammar);
    return grammar;
}
/* eslint-enable @typescript-eslint/no-require-imports */

// ---------------------------------------------------------------------------
// Parser pool (one parser per language, reused)
// ---------------------------------------------------------------------------

const parserCache = new Map<SupportedLanguage, any>();

function getParser(language: SupportedLanguage): any {
    if (parserCache.has(language)) return parserCache.get(language)!;
    const parser = new Parser();
    parser.setLanguage(getGrammar(language));
    parserCache.set(language, parser);
    return parser;
}

// ---------------------------------------------------------------------------
// Behavior patterns — shared across all languages
// ---------------------------------------------------------------------------

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
    { pattern: /open\s*\(/, hint_type: 'file_io', detail: 'file_open' },
    // Cache
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
    // Exceptions
    { pattern: /throw\s+new\s+\w+/, hint_type: 'throws', detail: 'throws' },
    { pattern: /raise\s+\w+/, hint_type: 'throws', detail: 'python_raise' },
    { pattern: /catch\s*\(/, hint_type: 'catches', detail: 'catches' },
    { pattern: /except\s+/, hint_type: 'catches', detail: 'python_except' },
    // State mutation
    { pattern: /this\.\w+\s*=/, hint_type: 'state_mutation', detail: 'this_assignment' },
    { pattern: /self\.\w+\s*=/, hint_type: 'state_mutation', detail: 'self_assignment' },
    { pattern: /\.setState\s*\(/, hint_type: 'state_mutation', detail: 'set_state' },
    // Transactions
    { pattern: /\.transaction\s*\(/, hint_type: 'transaction', detail: 'db_transaction' },
    { pattern: /BEGIN|COMMIT|ROLLBACK/, hint_type: 'transaction', detail: 'sql_transaction' },
    // Logging
    { pattern: /console\.(log|warn|error|info)/, hint_type: 'logging', detail: 'console' },
    { pattern: /log\.(debug|info|warn|error|fatal)/, hint_type: 'logging', detail: 'structured_log' },
    { pattern: /logging\.(debug|info|warn|error)/, hint_type: 'logging', detail: 'python_logging' },
    { pattern: /fmt\.(Print|Println|Printf|Errorf)/, hint_type: 'logging', detail: 'go_fmt' },
    { pattern: /std::cout|std::cerr|fprintf/, hint_type: 'logging', detail: 'cpp_io' },
];

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function sha256(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Compute a normalized AST hash by stripping comments and collapsing whitespace.
 * Language-agnostic: works on raw text.
 */
function computeNormalizedAstHash(text: string): string {
    let normalized = text;
    // Remove single-line comments (// and #)
    normalized = normalized.replace(/\/\/[^\n]*/g, '');
    normalized = normalized.replace(/#[^\n]*/g, '');
    // Remove multi-line comments (/* ... */ and """ ... """)
    normalized = normalized.replace(/\/\*[\s\S]*?\*\//g, '');
    normalized = normalized.replace(/"""[\s\S]*?"""/g, '');
    normalized = normalized.replace(/'''[\s\S]*?'''/g, '');
    // Collapse whitespace
    normalized = normalized.replace(/\s+/g, ' ').trim();
    return sha256(normalized);
}

/**
 * Find the name identifier of a tree-sitter node. Different languages use
 * different field names ('name', 'declarator', etc.).
 */
function getNodeName(node: any, language: SupportedLanguage): string | null {
    // Direct 'name' field — most common
    const nameChild = node.childForFieldName('name');
    if (nameChild) {
        // In C++ the name field might be a qualified_identifier or destructor_name
        if (nameChild.type === 'identifier' || nameChild.type === 'type_identifier' ||
            nameChild.type === 'field_identifier' || nameChild.type === 'property_identifier') {
            return nameChild.text;
        }
        // For qualified identifiers, destructor names, etc., use the text
        return nameChild.text;
    }

    // C++ function_definition: the declarator field holds the name
    if (language === 'cpp') {
        const declarator = node.childForFieldName('declarator');
        if (declarator) {
            return extractCppDeclaratorName(declarator);
        }
    }

    // Go method_declaration: the name is in the 'name' field
    // already handled above

    return null;
}

/**
 * Recursively dig into C++ declarators to find the actual identifier.
 * Handles: function_declarator -> identifier, reference_declarator,
 * pointer_declarator, qualified_identifier, etc.
 */
function extractCppDeclaratorName(node: any): string | null {
    if (!node) return null;
    if (node.type === 'identifier' || node.type === 'field_identifier' ||
        node.type === 'type_identifier') {
        return node.text;
    }
    if (node.type === 'destructor_name') {
        return '~' + (node.namedChildren[0]?.text ?? '');
    }
    if (node.type === 'qualified_identifier') {
        // Return the full qualified name
        return node.text;
    }
    // function_declarator -> declarator field holds the name
    const inner = node.childForFieldName('declarator');
    if (inner) return extractCppDeclaratorName(inner);
    // Try the name field
    const nameField = node.childForFieldName('name');
    if (nameField) return extractCppDeclaratorName(nameField);
    // Fallback: first named child
    if (node.namedChildCount > 0) {
        return extractCppDeclaratorName(node.namedChild(0));
    }
    return node.text?.trim() || null;
}

/**
 * Build a stable key from file path, optional parent name, and symbol name.
 * Format: "filePath::Parent.name" or "filePath::name"
 */
function makeStableKey(filePath: string, parentName: string | null, name: string): string {
    if (parentName) {
        return `${filePath}::${parentName}.${name}`;
    }
    return `${filePath}::${name}`;
}

// ---------------------------------------------------------------------------
// Visibility detection
// ---------------------------------------------------------------------------

function detectVisibility(node: any, source: string, language: SupportedLanguage, parentNode: any | null): string {
    const text = node.text as string;
    switch (language) {
        case 'typescript':
        case 'javascript': {
            // Check for export keyword: look at parent or previous sibling
            const parent = node.parent;
            if (parent) {
                if (parent.type === 'export_statement') return 'public';
                // `export default`
                if (parent.type === 'export_statement' || parent.type === 'export_declaration') return 'public';
            }
            // Check for accessibility modifiers on methods
            const accessMod = node.childForFieldName('accessibility');
            if (accessMod) {
                const modText = accessMod.text;
                if (modText === 'private') return 'private';
                if (modText === 'protected') return 'protected';
                if (modText === 'public') return 'public';
            }
            // Check if any child is an accessibility_modifier
            for (let i = 0; i < node.childCount; i++) {
                const child = node.child(i);
                if (child && child.type === 'accessibility_modifier') {
                    const modText = child.text;
                    if (modText === 'private') return 'private';
                    if (modText === 'protected') return 'protected';
                    if (modText === 'public') return 'public';
                }
            }
            // Check for 'export' in the node text (variable statements with export)
            if (parent && parent.type === 'export_statement') return 'public';
            // Look for 'export' keyword in lexical_declaration parent
            const grandparent = parent?.parent;
            if (grandparent && grandparent.type === 'export_statement') return 'public';
            return 'internal';
        }
        case 'python': {
            // Python: names starting with _ are private, __ are more private
            const nameNode = node.childForFieldName('name');
            const name = nameNode?.text || '';
            if (name.startsWith('__') && !name.endsWith('__')) return 'private';
            if (name.startsWith('_')) return 'protected';
            return 'public';
        }
        case 'cpp': {
            // Check for access specifiers in the parent class scope
            // In tree-sitter-cpp, class members have access_specifier siblings
            if (parentNode) {
                // Walk backwards from this node to find the nearest access_specifier
                let sibling = node.previousNamedSibling;
                while (sibling) {
                    if (sibling.type === 'access_specifier') {
                        const specText = sibling.text.replace(':', '').trim();
                        if (specText === 'private') return 'private';
                        if (specText === 'protected') return 'protected';
                        if (specText === 'public') return 'public';
                    }
                    sibling = sibling.previousNamedSibling;
                }
                // If inside struct, default is public; if inside class, default is private
                if (parentNode.type === 'struct_specifier') return 'public';
                return 'private';
            }
            // Top-level: check for static keyword
            if (text.includes('static ')) return 'internal';
            return 'public';
        }
        case 'go': {
            // Go: exported if name starts with uppercase
            const nameNode = node.childForFieldName('name');
            const name = nameNode?.text || '';
            if (name.length > 0 && name[0] === name[0]!.toUpperCase() && name[0] !== name[0]!.toLowerCase()) {
                return 'public';
            }
            return 'internal';
        }
        default:
            return 'public';
    }
}

// ---------------------------------------------------------------------------
// Signature extraction
// ---------------------------------------------------------------------------

function extractSignature(node: any, language: SupportedLanguage): string {
    switch (language) {
        case 'typescript':
        case 'javascript':
            return extractTSSignature(node);
        case 'python':
            return extractPythonSignature(node);
        case 'cpp':
            return extractCppSignature(node);
        case 'go':
            return extractGoSignature(node);
        default:
            return node.text.substring(0, 120);
    }
}

function extractTSSignature(node: any): string {
    const type = node.type;
    const nameNode = node.childForFieldName('name');
    const name = nameNode?.text || 'anonymous';

    if (type === 'function_declaration' || type === 'method_definition' ||
        type === 'function_signature' || type === 'method_signature') {
        const params = node.childForFieldName('parameters');
        const returnType = node.childForFieldName('return_type');
        const paramsText = params ? params.text : '()';
        const retText = returnType ? ': ' + returnType.text : '';
        return `${name}${paramsText}${retText}`;
    }
    if (type === 'class_declaration') {
        return `class ${name}`;
    }
    if (type === 'interface_declaration') {
        return `interface ${name}`;
    }
    if (type === 'type_alias_declaration') {
        return `type ${name}`;
    }
    if (type === 'enum_declaration') {
        return `enum ${name}`;
    }
    if (type === 'variable_declarator') {
        const valueNode = node.childForFieldName('value');
        if (valueNode && (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression' || valueNode.type === 'function')) {
            const params = valueNode.childForFieldName('parameters');
            const returnType = valueNode.childForFieldName('return_type');
            const paramsText = params ? params.text : '()';
            const retText = returnType ? ': ' + returnType.text : '';
            return `${name}${paramsText}${retText}`;
        }
        const typeAnnotation = node.childForFieldName('type');
        if (typeAnnotation) {
            return `${name}: ${typeAnnotation.text}`;
        }
        return name;
    }
    if (type === 'lexical_declaration') {
        // Take first declarator
        for (let i = 0; i < node.namedChildCount; i++) {
            const child = node.namedChild(i);
            if (child && child.type === 'variable_declarator') {
                return extractTSSignature(child);
            }
        }
        return node.text.substring(0, 120);
    }
    // Fallback: first line
    const firstLine = node.text.split('\n')[0] || '';
    return firstLine.substring(0, 200);
}

function extractPythonSignature(node: any): string {
    const type = node.type;
    const nameNode = node.childForFieldName('name');
    const name = nameNode?.text || 'anonymous';

    if (type === 'function_definition') {
        const params = node.childForFieldName('parameters');
        const returnType = node.childForFieldName('return_type');
        const paramsText = params ? params.text : '()';
        const retText = returnType ? ' -> ' + returnType.text : '';
        return `def ${name}${paramsText}${retText}`;
    }
    if (type === 'class_definition') {
        const superclasses = node.childForFieldName('superclasses');
        const superText = superclasses ? superclasses.text : '';
        return `class ${name}${superText}`;
    }
    if (type === 'decorated_definition') {
        // Get the inner definition
        const definition = node.childForFieldName('definition');
        if (definition) return extractPythonSignature(definition);
    }
    const firstLine = node.text.split('\n')[0] || '';
    return firstLine.substring(0, 200);
}

function extractCppSignature(node: any): string {
    const type = node.type;

    if (type === 'function_definition') {
        // Get everything before the body
        const body = node.childForFieldName('body');
        if (body) {
            const sigEnd = body.startIndex;
            const sigText = node.text.substring(0, sigEnd - node.startIndex).trim();
            return sigText.substring(0, 300);
        }
        const firstLine = node.text.split('\n')[0] || '';
        return firstLine.substring(0, 200);
    }
    if (type === 'class_specifier' || type === 'struct_specifier') {
        const nameNode = node.childForFieldName('name');
        const name = nameNode?.text || 'anonymous';
        const prefix = type === 'struct_specifier' ? 'struct' : 'class';
        // Check for base classes
        const baseClause = node.children.find((c: any) => c.type === 'base_class_clause');
        const baseText = baseClause ? ' ' + baseClause.text : '';
        return `${prefix} ${name}${baseText}`;
    }
    if (type === 'enum_specifier') {
        const nameNode = node.childForFieldName('name');
        const name = nameNode?.text || 'anonymous';
        return `enum ${name}`;
    }
    if (type === 'namespace_definition') {
        const nameNode = node.childForFieldName('name');
        const name = nameNode?.text || 'anonymous';
        return `namespace ${name}`;
    }
    if (type === 'template_declaration') {
        // Get the parameters and the inner declaration's signature
        const params = node.childForFieldName('parameters');
        const paramsText = params ? params.text : '';
        // Find the inner declaration
        for (let i = 0; i < node.namedChildCount; i++) {
            const child = node.namedChild(i);
            if (child && child.type !== 'template_parameter_list') {
                const innerSig = extractCppSignature(child);
                return `template${paramsText} ${innerSig}`;
            }
        }
        const firstLine = node.text.split('\n')[0] || '';
        return firstLine.substring(0, 200);
    }
    const firstLine = node.text.split('\n')[0] || '';
    return firstLine.substring(0, 200);
}

function extractGoSignature(node: any): string {
    const type = node.type;
    const nameNode = node.childForFieldName('name');
    const name = nameNode?.text || 'anonymous';

    if (type === 'function_declaration') {
        const params = node.childForFieldName('parameters');
        const result = node.childForFieldName('result');
        const paramsText = params ? params.text : '()';
        const retText = result ? ' ' + result.text : '';
        return `func ${name}${paramsText}${retText}`;
    }
    if (type === 'method_declaration') {
        const receiver = node.childForFieldName('receiver');
        const params = node.childForFieldName('parameters');
        const result = node.childForFieldName('result');
        const recvText = receiver ? receiver.text + ' ' : '';
        const paramsText = params ? params.text : '()';
        const retText = result ? ' ' + result.text : '';
        return `func ${recvText}${name}${paramsText}${retText}`;
    }
    if (type === 'type_declaration') {
        // This wraps type_spec nodes
        const firstLine = node.text.split('\n')[0] || '';
        return firstLine.substring(0, 200);
    }
    if (type === 'type_spec') {
        const typeName = node.childForFieldName('name')?.text || 'anonymous';
        const typeVal = node.childForFieldName('type');
        if (typeVal) {
            if (typeVal.type === 'struct_type') return `type ${typeName} struct`;
            if (typeVal.type === 'interface_type') return `type ${typeName} interface`;
            return `type ${typeName} ${typeVal.text.substring(0, 60)}`;
        }
        return `type ${typeName}`;
    }
    const firstLine = node.text.split('\n')[0] || '';
    return firstLine.substring(0, 200);
}

// ---------------------------------------------------------------------------
// Kind classification
// ---------------------------------------------------------------------------

function classifyKind(node: any, language: SupportedLanguage): string {
    const type = node.type;
    switch (language) {
        case 'typescript':
        case 'javascript': {
            if (type === 'class_declaration') return 'class';
            if (type === 'interface_declaration') return 'interface';
            if (type === 'type_alias_declaration') return 'type_alias';
            if (type === 'enum_declaration') return 'enum';
            if (type === 'method_definition' || type === 'method_signature') return 'method';
            if (type === 'function_declaration' || type === 'function_signature') return 'function';
            if (type === 'variable_declarator' || type === 'lexical_declaration') {
                // Check if the value is a function/arrow
                const valueNode = type === 'variable_declarator'
                    ? node.childForFieldName('value')
                    : node.namedChild(0)?.childForFieldName?.('value');
                if (valueNode && (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression' || valueNode.type === 'function')) {
                    return 'function';
                }
                return 'variable';
            }
            if (type === 'arrow_function' || type === 'function_expression' || type === 'function') return 'function';
            return 'function';
        }
        case 'python': {
            if (type === 'function_definition') return 'function';
            if (type === 'class_definition') return 'class';
            if (type === 'decorated_definition') {
                const definition = node.childForFieldName('definition');
                if (definition) return classifyKind(definition, language);
                return 'function';
            }
            return 'function';
        }
        case 'cpp': {
            if (type === 'function_definition') return 'function';
            if (type === 'class_specifier') return 'class';
            if (type === 'struct_specifier') return 'class';
            if (type === 'enum_specifier') return 'enum';
            if (type === 'namespace_definition') return 'module';
            if (type === 'template_declaration') {
                // Classify based on inner declaration
                for (let i = 0; i < node.namedChildCount; i++) {
                    const child = node.namedChild(i);
                    if (child && child.type !== 'template_parameter_list') {
                        return classifyKind(child, language);
                    }
                }
                return 'function';
            }
            return 'function';
        }
        case 'go': {
            if (type === 'function_declaration') return 'function';
            if (type === 'method_declaration') return 'method';
            if (type === 'type_spec') {
                const typeVal = node.childForFieldName('type');
                if (typeVal) {
                    if (typeVal.type === 'struct_type') return 'class';
                    if (typeVal.type === 'interface_type') return 'interface';
                }
                return 'type_alias';
            }
            if (type === 'type_declaration') {
                // Check inner type_spec nodes
                for (let i = 0; i < node.namedChildCount; i++) {
                    const child = node.namedChild(i);
                    if (child && child.type === 'type_spec') {
                        return classifyKind(child, language);
                    }
                }
                return 'type_alias';
            }
            if (type === 'const_declaration' || type === 'var_declaration') return 'variable';
            return 'variable';
        }
        default:
            return 'function';
    }
}

// ---------------------------------------------------------------------------
// Behavior hint extraction — applies the shared BEHAVIOR_PATTERNS
// ---------------------------------------------------------------------------

function extractBehaviorHints(
    bodyText: string,
    symbolKey: string,
    baseLine: number,
    hints: BehaviorHint[],
): void {
    const lines = bodyText.split('\n');
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

// ---------------------------------------------------------------------------
// Contract hint extraction
// ---------------------------------------------------------------------------

function extractContractHint(
    node: any,
    symbolKey: string,
    language: SupportedLanguage,
    hints: ContractHint[],
): void {
    const text = node.text as string;
    const inputTypes: string[] = [];
    let outputType = 'void';
    const thrownTypes: string[] = [];
    const decorators: string[] = [];

    switch (language) {
        case 'typescript':
        case 'javascript': {
            // Parameters
            const params = node.childForFieldName('parameters');
            if (params) {
                for (let i = 0; i < params.namedChildCount; i++) {
                    const param = params.namedChild(i);
                    if (param && (param.type === 'required_parameter' ||
                                  param.type === 'optional_parameter' ||
                                  param.type === 'formal_parameters')) {
                        const typeAnnotation = param.childForFieldName('type');
                        inputTypes.push(typeAnnotation ? typeAnnotation.text : 'any');
                    } else if (param && param.type === 'identifier') {
                        inputTypes.push('any');
                    }
                }
            }
            // For variable_declarator pointing to arrow/function
            if (node.type === 'variable_declarator') {
                const valueNode = node.childForFieldName('value');
                if (valueNode) {
                    const innerParams = valueNode.childForFieldName('parameters');
                    if (innerParams) {
                        for (let i = 0; i < innerParams.namedChildCount; i++) {
                            const param = innerParams.namedChild(i);
                            if (param) {
                                const typeAnnotation = param.childForFieldName('type');
                                inputTypes.push(typeAnnotation ? typeAnnotation.text : 'any');
                            }
                        }
                    }
                    const innerReturnType = valueNode.childForFieldName('return_type');
                    if (innerReturnType) outputType = innerReturnType.text;
                }
            }
            // Return type
            const returnType = node.childForFieldName('return_type');
            if (returnType) outputType = returnType.text;
            // Decorators
            const parent = node.parent;
            if (parent && parent.type === 'export_statement') {
                // Check for decorators on the export statement
                for (let i = 0; i < parent.namedChildCount; i++) {
                    const child = parent.namedChild(i);
                    if (child && child.type === 'decorator') {
                        decorators.push(child.text);
                    }
                }
            }
            // Decorators directly on node
            for (let i = 0; i < node.childCount; i++) {
                const child = node.child(i);
                if (child && child.type === 'decorator') {
                    decorators.push(child.text);
                }
            }
            break;
        }
        case 'python': {
            let targetNode = node;
            // If decorated_definition, extract decorators and dig into the definition
            if (node.type === 'decorated_definition') {
                for (let i = 0; i < node.namedChildCount; i++) {
                    const child = node.namedChild(i);
                    if (child && child.type === 'decorator') {
                        decorators.push(child.text);
                    }
                }
                const def = node.childForFieldName('definition');
                if (def) targetNode = def;
            }
            const params = targetNode.childForFieldName('parameters');
            if (params) {
                for (let i = 0; i < params.namedChildCount; i++) {
                    const param = params.namedChild(i);
                    if (!param) continue;
                    if (param.type === 'identifier') {
                        // Skip 'self' and 'cls'
                        if (param.text !== 'self' && param.text !== 'cls') {
                            inputTypes.push('Any');
                        }
                    } else if (param.type === 'typed_parameter' || param.type === 'typed_default_parameter') {
                        const typeNode = param.childForFieldName('type');
                        inputTypes.push(typeNode ? typeNode.text : 'Any');
                    } else if (param.type === 'default_parameter') {
                        inputTypes.push('Any');
                    }
                }
            }
            const returnType = targetNode.childForFieldName('return_type');
            if (returnType) outputType = returnType.text;
            break;
        }
        case 'cpp': {
            if (node.type === 'function_definition' || node.type === 'template_declaration') {
                let funcNode = node;
                if (node.type === 'template_declaration') {
                    // Find the inner function definition
                    for (let i = 0; i < node.namedChildCount; i++) {
                        const child = node.namedChild(i);
                        if (child && child.type === 'function_definition') {
                            funcNode = child;
                            break;
                        }
                    }
                }
                const declarator = funcNode.childForFieldName('declarator');
                if (declarator) {
                    // Find parameter_list inside the declarator
                    const paramList = findDescendantByType(declarator, 'parameter_list');
                    if (paramList) {
                        for (let i = 0; i < paramList.namedChildCount; i++) {
                            const param = paramList.namedChild(i);
                            if (param && param.type === 'parameter_declaration') {
                                const typeNode = param.childForFieldName('type');
                                inputTypes.push(typeNode ? typeNode.text : 'auto');
                            }
                        }
                    }
                }
                const typeNode = funcNode.childForFieldName('type');
                if (typeNode) outputType = typeNode.text;
            }
            break;
        }
        case 'go': {
            const params = node.childForFieldName('parameters');
            if (params) {
                for (let i = 0; i < params.namedChildCount; i++) {
                    const param = params.namedChild(i);
                    if (param && param.type === 'parameter_declaration') {
                        const typeNode = param.childForFieldName('type');
                        inputTypes.push(typeNode ? typeNode.text : 'interface{}');
                    }
                }
            }
            const result = node.childForFieldName('result');
            if (result) outputType = result.text;
            break;
        }
    }

    // Extract thrown types from body text (works across all languages)
    const throwMatches = text.matchAll(/throw\s+new\s+(\w+)/g);
    for (const match of throwMatches) {
        if (match[1]) thrownTypes.push(match[1]);
    }
    // Python raise
    const raiseMatches = text.matchAll(/raise\s+(\w+)\s*\(/g);
    for (const match of raiseMatches) {
        if (match[1]) thrownTypes.push(match[1]);
    }

    hints.push({
        symbol_key: symbolKey,
        input_types: inputTypes,
        output_type: outputType,
        thrown_types: [...new Set(thrownTypes)],
        decorators,
    });
}

function findDescendantByType(node: any, type: string): any | null {
    if (node.type === type) return node;
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) {
            const found = findDescendantByType(child, type);
            if (found) return found;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Relation extraction
// ---------------------------------------------------------------------------

function extractRelationsFromNode(
    node: any,
    sourceKey: string,
    language: SupportedLanguage,
    relations: ExtractedRelation[],
): void {
    // Walk the entire subtree of this node looking for call expressions,
    // type references, etc.
    walkForRelations(node, sourceKey, language, relations);
}

function walkForRelations(
    node: any,
    sourceKey: string,
    language: SupportedLanguage,
    relations: ExtractedRelation[],
): void {
    if (!node) return;
    const type = node.type;

    // Call expressions
    if (type === 'call_expression' || type === 'call') {
        const funcNode = node.childForFieldName('function');
        if (funcNode) {
            let targetName: string | null = null;
            if (funcNode.type === 'identifier' || funcNode.type === 'field_identifier') {
                targetName = funcNode.text;
            } else if (funcNode.type === 'member_expression' || funcNode.type === 'property_access_expression') {
                const propNode = funcNode.childForFieldName('property') || funcNode.childForFieldName('name');
                targetName = propNode?.text || null;
            } else if (funcNode.type === 'selector_expression') {
                // Go: obj.Method()
                const fieldNode = funcNode.childForFieldName('field');
                targetName = fieldNode?.text || null;
            } else if (funcNode.type === 'attribute') {
                // Python: obj.method()
                const attrNode = funcNode.childForFieldName('attribute');
                targetName = attrNode?.text || null;
            } else if (funcNode.type === 'qualified_identifier' || funcNode.type === 'scoped_identifier') {
                // C++: ns::func()
                const nameNode = funcNode.childForFieldName('name');
                targetName = nameNode?.text || funcNode.text;
            }
            if (targetName) {
                relations.push({
                    source_key: sourceKey,
                    target_name: targetName,
                    relation_type: 'calls' as StructuralRelationType,
                });
            }
        }
        // Python/Go: the function might be direct identifier child
        if (!node.childForFieldName('function')) {
            const firstChild = node.namedChild(0);
            if (firstChild) {
                let targetName: string | null = null;
                if (firstChild.type === 'identifier') {
                    targetName = firstChild.text;
                } else if (firstChild.type === 'attribute') {
                    const attrNode = firstChild.childForFieldName('attribute');
                    targetName = attrNode?.text || null;
                }
                if (targetName) {
                    relations.push({
                        source_key: sourceKey,
                        target_name: targetName,
                        relation_type: 'calls' as StructuralRelationType,
                    });
                }
            }
        }
    }

    // Type references (TypeScript)
    if (type === 'type_identifier' || type === 'generic_type') {
        const typeName = type === 'generic_type'
            ? node.namedChild(0)?.text || node.text
            : node.text;
        if (typeName && typeName !== 'void' && typeName !== 'string' && typeName !== 'number' &&
            typeName !== 'boolean' && typeName !== 'any' && typeName !== 'unknown' &&
            typeName !== 'never' && typeName !== 'null' && typeName !== 'undefined') {
            relations.push({
                source_key: sourceKey,
                target_name: typeName,
                relation_type: 'typed_as' as StructuralRelationType,
            });
        }
    }

    // Recurse into children
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) {
            walkForRelations(child, sourceKey, language, relations);
        }
    }
}

// ---------------------------------------------------------------------------
// Import relation extraction
// ---------------------------------------------------------------------------

function extractImportRelations(
    rootNode: any,
    filePath: string,
    language: SupportedLanguage,
    relations: ExtractedRelation[],
): void {
    const sourceKey = `${filePath}::__module__`;

    switch (language) {
        case 'typescript':
        case 'javascript': {
            const imports = rootNode.descendantsOfType('import_statement');
            for (const imp of imports) {
                const sourceNode = imp.childForFieldName('source');
                const moduleName = sourceNode?.text?.replace(/['"]/g, '') || '';
                if (!moduleName) continue;

                // Extract named imports
                const clauseNodes = imp.descendantsOfType('import_specifier');
                for (const spec of clauseNodes) {
                    const nameNode = spec.childForFieldName('name');
                    const name = nameNode?.text || spec.text;
                    relations.push({
                        source_key: sourceKey,
                        target_name: `${moduleName}::${name}`,
                        relation_type: 'imports' as StructuralRelationType,
                    });
                }

                // Default import or namespace import
                const defaultImport = imp.descendantsOfType('identifier');
                for (const id of defaultImport) {
                    // Only direct children of import_clause
                    if (id.parent && (id.parent.type === 'import_clause' || id.parent.type === 'import_statement')) {
                        relations.push({
                            source_key: sourceKey,
                            target_name: `${moduleName}::default`,
                            relation_type: 'imports' as StructuralRelationType,
                        });
                        break;
                    }
                }

                // Namespace import (import * as x)
                const nsImports = imp.descendantsOfType('namespace_import');
                for (const _ns of nsImports) {
                    relations.push({
                        source_key: sourceKey,
                        target_name: `${moduleName}::*`,
                        relation_type: 'imports' as StructuralRelationType,
                    });
                }
            }
            // Export statements
            const exports = rootNode.descendantsOfType('export_statement');
            for (const exp of exports) {
                // Named export: export { x, y }
                const specifiers = exp.descendantsOfType('export_specifier');
                for (const spec of specifiers) {
                    const nameNode = spec.childForFieldName('name');
                    const name = nameNode?.text || spec.text;
                    relations.push({
                        source_key: sourceKey,
                        target_name: name,
                        relation_type: 'exports' as StructuralRelationType,
                    });
                }
                // export default / export function / export class / export const
                for (let i = 0; i < exp.namedChildCount; i++) {
                    const child = exp.namedChild(i);
                    if (!child) continue;
                    if (child.type === 'function_declaration' || child.type === 'class_declaration' ||
                        child.type === 'interface_declaration' || child.type === 'enum_declaration' ||
                        child.type === 'type_alias_declaration') {
                        const name = child.childForFieldName('name')?.text;
                        if (name) {
                            relations.push({
                                source_key: sourceKey,
                                target_name: name,
                                relation_type: 'exports' as StructuralRelationType,
                            });
                        }
                    }
                    if (child.type === 'lexical_declaration') {
                        for (let j = 0; j < child.namedChildCount; j++) {
                            const decl = child.namedChild(j);
                            if (decl && decl.type === 'variable_declarator') {
                                const name = decl.childForFieldName('name')?.text;
                                if (name) {
                                    relations.push({
                                        source_key: sourceKey,
                                        target_name: name,
                                        relation_type: 'exports' as StructuralRelationType,
                                    });
                                }
                            }
                        }
                    }
                }
            }
            break;
        }
        case 'python': {
            // import x, import x.y
            const importStmts = rootNode.descendantsOfType('import_statement');
            for (const imp of importStmts) {
                const nameNodes = imp.descendantsOfType('dotted_name');
                for (const nameNode of nameNodes) {
                    relations.push({
                        source_key: sourceKey,
                        target_name: nameNode.text,
                        relation_type: 'imports' as StructuralRelationType,
                    });
                }
            }
            // from x import y
            const fromImports = rootNode.descendantsOfType('import_from_statement');
            for (const imp of fromImports) {
                const moduleNode = imp.childForFieldName('module_name');
                const moduleName = moduleNode?.text || '';
                const nameNodes = imp.descendantsOfType('dotted_name');
                for (const nameNode of nameNodes) {
                    if (nameNode === moduleNode) continue;
                    relations.push({
                        source_key: sourceKey,
                        target_name: moduleName ? `${moduleName}.${nameNode.text}` : nameNode.text,
                        relation_type: 'imports' as StructuralRelationType,
                    });
                }
                // Import identifiers (non-dotted)
                const idNodes = imp.descendantsOfType('identifier');
                for (const id of idNodes) {
                    // Skip if this is the module name's identifier
                    if (id.parent === moduleNode || id.parent?.parent === moduleNode) continue;
                    // Only direct imports, not aliases
                    if (id.parent && (id.parent.type === 'import_from_statement' || id.parent.type === 'aliased_import')) {
                        relations.push({
                            source_key: sourceKey,
                            target_name: moduleName ? `${moduleName}.${id.text}` : id.text,
                            relation_type: 'imports' as StructuralRelationType,
                        });
                    }
                }
            }
            break;
        }
        case 'cpp': {
            const includes = rootNode.descendantsOfType('preproc_include');
            for (const inc of includes) {
                // The path can be a string_literal or system_lib_string
                const pathNode = inc.childForFieldName('path');
                const path = pathNode?.text?.replace(/[<>"]/g, '') || '';
                if (path) {
                    relations.push({
                        source_key: sourceKey,
                        target_name: path,
                        relation_type: 'imports' as StructuralRelationType,
                    });
                }
            }
            break;
        }
        case 'go': {
            const importDecls = rootNode.descendantsOfType('import_declaration');
            for (const imp of importDecls) {
                const specNodes = imp.descendantsOfType('import_spec');
                for (const spec of specNodes) {
                    const pathNode = spec.childForFieldName('path');
                    const importPath = pathNode?.text?.replace(/"/g, '') || '';
                    if (importPath) {
                        relations.push({
                            source_key: sourceKey,
                            target_name: importPath,
                            relation_type: 'imports' as StructuralRelationType,
                        });
                    }
                }
                // Single import without spec list (import "fmt")
                const stringLiterals = imp.descendantsOfType('interpreted_string_literal');
                for (const sl of stringLiterals) {
                    // Only if not already captured via import_spec
                    if (sl.parent?.type !== 'import_spec') {
                        const importPath = sl.text.replace(/"/g, '');
                        if (importPath) {
                            relations.push({
                                source_key: sourceKey,
                                target_name: importPath,
                                relation_type: 'imports' as StructuralRelationType,
                            });
                        }
                    }
                }
            }
            break;
        }
    }
}

// ---------------------------------------------------------------------------
// Inheritance / implements relation extraction
// ---------------------------------------------------------------------------

function extractInheritanceRelations(
    node: any,
    stableKey: string,
    language: SupportedLanguage,
    relations: ExtractedRelation[],
): void {
    switch (language) {
        case 'typescript':
        case 'javascript': {
            if (node.type === 'class_declaration') {
                // extends clause
                const heritage = node.descendantsOfType('class_heritage');
                for (const h of heritage) {
                    // extends
                    const extendsClause = h.descendantsOfType('extends_clause');
                    for (const ext of extendsClause) {
                        const typeNode = ext.namedChild(0);
                        if (typeNode) {
                            relations.push({
                                source_key: stableKey,
                                target_name: typeNode.text,
                                relation_type: 'inherits' as StructuralRelationType,
                            });
                        }
                    }
                }
                // Look for extends_clause as direct descendant
                const directExtends = node.descendantsOfType('extends_clause');
                for (const ext of directExtends) {
                    const valueNode = ext.namedChild(0);
                    if (valueNode) {
                        relations.push({
                            source_key: stableKey,
                            target_name: valueNode.text,
                            relation_type: 'inherits' as StructuralRelationType,
                        });
                    }
                }

                // implements
                const implementsClauses = node.descendantsOfType('implements_clause');
                for (const impl of implementsClauses) {
                    for (let i = 0; i < impl.namedChildCount; i++) {
                        const typeNode = impl.namedChild(i);
                        if (typeNode) {
                            relations.push({
                                source_key: stableKey,
                                target_name: typeNode.text,
                                relation_type: 'implements' as StructuralRelationType,
                            });
                        }
                    }
                }
            }
            if (node.type === 'interface_declaration') {
                // extends
                const extendsClause = node.descendantsOfType('extends_type_clause');
                for (const ext of extendsClause) {
                    for (let i = 0; i < ext.namedChildCount; i++) {
                        const typeNode = ext.namedChild(i);
                        if (typeNode) {
                            relations.push({
                                source_key: stableKey,
                                target_name: typeNode.text,
                                relation_type: 'inherits' as StructuralRelationType,
                            });
                        }
                    }
                }
            }
            break;
        }
        case 'python': {
            if (node.type === 'class_definition') {
                const superclasses = node.childForFieldName('superclasses');
                if (superclasses) {
                    for (let i = 0; i < superclasses.namedChildCount; i++) {
                        const base = superclasses.namedChild(i);
                        if (base) {
                            relations.push({
                                source_key: stableKey,
                                target_name: base.text,
                                relation_type: 'inherits' as StructuralRelationType,
                            });
                        }
                    }
                }
            }
            break;
        }
        case 'cpp': {
            if (node.type === 'class_specifier' || node.type === 'struct_specifier') {
                // base_class_clause contains the list of base classes
                const baseClauses = node.descendantsOfType('base_class_clause');
                for (const clause of baseClauses) {
                    for (let i = 0; i < clause.namedChildCount; i++) {
                        const child = clause.namedChild(i);
                        if (!child) continue;
                        // Each base is typically a type_identifier or qualified_identifier
                        // wrapped in a base_specifier (with optional access specifier)
                        const typeId = findDescendantByType(child, 'type_identifier') ||
                                       findDescendantByType(child, 'qualified_identifier');
                        if (typeId) {
                            relations.push({
                                source_key: stableKey,
                                target_name: typeId.text,
                                relation_type: 'inherits' as StructuralRelationType,
                            });
                        }
                    }
                }
            }
            break;
        }
        case 'go': {
            // Go doesn't have explicit inheritance, but struct embedding acts like it
            // and interface embedding is similar
            if (node.type === 'type_spec') {
                const typeNode = node.childForFieldName('type');
                if (typeNode && typeNode.type === 'struct_type') {
                    // Look for embedded fields (fields without a name, just a type)
                    const fieldDecls = typeNode.descendantsOfType('field_declaration');
                    for (const field of fieldDecls) {
                        // An embedded field has no name field but has a type field
                        const nameNode = field.childForFieldName('name');
                        const typeField = field.childForFieldName('type');
                        if (!nameNode && typeField) {
                            relations.push({
                                source_key: stableKey,
                                target_name: typeField.text,
                                relation_type: 'inherits' as StructuralRelationType,
                            });
                        }
                    }
                }
                if (typeNode && typeNode.type === 'interface_type') {
                    // Embedded interfaces
                    for (let i = 0; i < typeNode.namedChildCount; i++) {
                        const child = typeNode.namedChild(i);
                        if (child && child.type === 'type_identifier') {
                            relations.push({
                                source_key: stableKey,
                                target_name: child.text,
                                relation_type: 'inherits' as StructuralRelationType,
                            });
                        }
                        if (child && child.type === 'qualified_type') {
                            relations.push({
                                source_key: stableKey,
                                target_name: child.text,
                                relation_type: 'inherits' as StructuralRelationType,
                            });
                        }
                    }
                }
            }
            break;
        }
    }
}

// ---------------------------------------------------------------------------
// Symbol node type sets per language
// ---------------------------------------------------------------------------

const TS_SYMBOL_TYPES = new Set([
    'function_declaration', 'method_definition', 'class_declaration',
    'interface_declaration', 'enum_declaration', 'type_alias_declaration',
    'arrow_function', 'lexical_declaration', 'export_statement',
]);

const PYTHON_SYMBOL_TYPES = new Set([
    'function_definition', 'class_definition', 'decorated_definition',
]);

const CPP_SYMBOL_TYPES = new Set([
    'function_definition', 'class_specifier', 'struct_specifier',
    'enum_specifier', 'namespace_definition', 'template_declaration',
]);

const GO_SYMBOL_TYPES = new Set([
    'function_declaration', 'method_declaration', 'type_declaration',
    'const_declaration', 'var_declaration',
]);

function getSymbolTypeSet(language: SupportedLanguage): Set<string> {
    switch (language) {
        case 'typescript':
        case 'javascript':
            return TS_SYMBOL_TYPES;
        case 'python':
            return PYTHON_SYMBOL_TYPES;
        case 'cpp':
            return CPP_SYMBOL_TYPES;
        case 'go':
            return GO_SYMBOL_TYPES;
        default:
            return new Set();
    }
}

// ---------------------------------------------------------------------------
// Main CST walker
// ---------------------------------------------------------------------------

interface WalkContext {
    filePath: string;
    language: SupportedLanguage;
    source: string;
    symbols: ExtractedSymbol[];
    relations: ExtractedRelation[];
    behaviorHints: BehaviorHint[];
    contractHints: ContractHint[];
    uncertaintyFlags: string[];
    symbolTypeSet: Set<string>;
}

function walkNode(
    node: any,
    ctx: WalkContext,
    parentName: string | null,
    parentClassNode: any | null,
): void {
    if (!node || !node.type) return;

    const nodeType = node.type;
    const lang = ctx.language;

    // --- TypeScript/JavaScript-specific handling ---
    if (lang === 'typescript' || lang === 'javascript') {
        // export_statement wraps declarations — extract the inner declaration
        if (nodeType === 'export_statement') {
            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                if (!child) continue;
                // Recurse into the child declaration, it will be extracted as a symbol
                if (child.type === 'function_declaration' || child.type === 'class_declaration' ||
                    child.type === 'interface_declaration' || child.type === 'type_alias_declaration' ||
                    child.type === 'enum_declaration' || child.type === 'lexical_declaration') {
                    walkNode(child, ctx, parentName, parentClassNode);
                }
            }
            return;
        }

        // lexical_declaration (const/let/var) — extract individual declarators
        if (nodeType === 'lexical_declaration') {
            for (let i = 0; i < node.namedChildCount; i++) {
                const declarator = node.namedChild(i);
                if (!declarator || declarator.type !== 'variable_declarator') continue;
                const nameNode = declarator.childForFieldName('name');
                const name = nameNode?.text;
                if (!name) continue;

                const stableKey = makeStableKey(ctx.filePath, parentName, name);
                const fullText = node.text;
                const sExpr = node.toString();

                // Determine if this is a function-valued variable
                const valueNode = declarator.childForFieldName('value');
                const isFuncLike = valueNode && (
                    valueNode.type === 'arrow_function' ||
                    valueNode.type === 'function_expression' ||
                    valueNode.type === 'function'
                );

                const kind = isFuncLike ? 'function' : 'variable';

                // Determine visibility
                const isExported = node.parent?.type === 'export_statement';
                const visibility = isExported ? 'public' : detectVisibility(node, ctx.source, lang, parentClassNode);

                ctx.symbols.push({
                    stable_key: stableKey,
                    canonical_name: name,
                    kind,
                    range_start_line: node.startPosition.row + 1,
                    range_start_col: node.startPosition.column + 1,
                    range_end_line: node.endPosition.row + 1,
                    range_end_col: node.endPosition.column + 1,
                    signature: extractTSSignature(declarator),
                    ast_hash: sha256(sExpr),
                    body_hash: sha256(fullText),
                    normalized_ast_hash: computeNormalizedAstHash(fullText),
                    visibility,
                });

                // Behavior hints for function-like variables
                if (isFuncLike) {
                    extractBehaviorHints(fullText, stableKey, node.startPosition.row + 1, ctx.behaviorHints);
                    extractContractHint(declarator, stableKey, lang, ctx.contractHints);
                    extractRelationsFromNode(valueNode, stableKey, lang, ctx.relations);
                }
            }
            return;
        }

        // function_declaration, class_declaration, interface_declaration, etc.
        if (nodeType === 'function_declaration' || nodeType === 'function_signature') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            return;
        }

        if (nodeType === 'class_declaration') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            // Extract inheritance
            const stableKey = makeStableKey(ctx.filePath, parentName, name);
            extractInheritanceRelations(node, stableKey, lang, ctx.relations);
            // Recurse into class body for methods
            const body = node.childForFieldName('body');
            if (body) {
                for (let i = 0; i < body.namedChildCount; i++) {
                    const member = body.namedChild(i);
                    if (member) walkNode(member, ctx, name, node);
                }
            }
            return;
        }

        if (nodeType === 'interface_declaration') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            const stableKey = makeStableKey(ctx.filePath, parentName, name);
            extractInheritanceRelations(node, stableKey, lang, ctx.relations);
            return;
        }

        if (nodeType === 'type_alias_declaration') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            return;
        }

        if (nodeType === 'enum_declaration') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            return;
        }

        if (nodeType === 'method_definition' || nodeType === 'method_signature') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            return;
        }

        // Default: recurse into children
        recurseChildren(node, ctx, parentName, parentClassNode);
        return;
    }

    // --- Python-specific handling ---
    if (lang === 'python') {
        if (nodeType === 'decorated_definition') {
            const definition = node.childForFieldName('definition');
            if (definition) {
                // Extract decorators for contract hints later
                const name = getNodeName(definition, lang);
                if (name) {
                    // We emit the decorated_definition itself as the symbol
                    // so decorators are included in the text
                    emitSymbol(node, name, ctx, parentName, parentClassNode);

                    if (definition.type === 'class_definition') {
                        const stableKey = makeStableKey(ctx.filePath, parentName, name);
                        extractInheritanceRelations(definition, stableKey, lang, ctx.relations);
                        // Recurse into class body
                        const body = definition.childForFieldName('body');
                        if (body) {
                            for (let i = 0; i < body.namedChildCount; i++) {
                                const member = body.namedChild(i);
                                if (member) walkNode(member, ctx, name, definition);
                            }
                        }
                    }
                    return;
                }
            }
            recurseChildren(node, ctx, parentName, parentClassNode);
            return;
        }

        if (nodeType === 'function_definition') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }

            emitSymbol(node, name, ctx, parentName, parentClassNode);
            return;
        }

        if (nodeType === 'class_definition') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            const stableKey = makeStableKey(ctx.filePath, parentName, name);
            extractInheritanceRelations(node, stableKey, lang, ctx.relations);
            // Recurse into class body for methods
            const body = node.childForFieldName('body');
            if (body) {
                for (let i = 0; i < body.namedChildCount; i++) {
                    const member = body.namedChild(i);
                    if (member) walkNode(member, ctx, name, node);
                }
            }
            return;
        }

        recurseChildren(node, ctx, parentName, parentClassNode);
        return;
    }

    // --- C++-specific handling ---
    if (lang === 'cpp') {
        if (nodeType === 'function_definition') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            return;
        }

        if (nodeType === 'class_specifier' || nodeType === 'struct_specifier') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            const stableKey = makeStableKey(ctx.filePath, parentName, name);
            extractInheritanceRelations(node, stableKey, lang, ctx.relations);
            // Recurse into class body for member functions
            const body = node.childForFieldName('body');
            if (body) {
                for (let i = 0; i < body.namedChildCount; i++) {
                    const member = body.namedChild(i);
                    if (member) walkNode(member, ctx, name, node);
                }
            }
            return;
        }

        if (nodeType === 'enum_specifier') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            return;
        }

        if (nodeType === 'namespace_definition') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            // Recurse into namespace body
            const body = node.childForFieldName('body');
            if (body) {
                for (let i = 0; i < body.namedChildCount; i++) {
                    const member = body.namedChild(i);
                    if (member) walkNode(member, ctx, name, node);
                }
            }
            return;
        }

        if (nodeType === 'template_declaration') {
            // Find the inner declaration (function_definition, class_specifier, etc.)
            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                if (!child || child.type === 'template_parameter_list') continue;
                // Extract using the template_declaration node itself for the full text/signature
                const innerName = getNodeName(child, lang);
                if (innerName) {
                    emitSymbol(node, innerName, ctx, parentName, parentClassNode);
                    if (child.type === 'class_specifier' || child.type === 'struct_specifier') {
                        const stableKey = makeStableKey(ctx.filePath, parentName, innerName);
                        extractInheritanceRelations(child, stableKey, lang, ctx.relations);
                        const body = child.childForFieldName('body');
                        if (body) {
                            for (let j = 0; j < body.namedChildCount; j++) {
                                const member = body.namedChild(j);
                                if (member) walkNode(member, ctx, innerName, child);
                            }
                        }
                    }
                    return;
                }
            }
            recurseChildren(node, ctx, parentName, parentClassNode);
            return;
        }

        recurseChildren(node, ctx, parentName, parentClassNode);
        return;
    }

    // --- Go-specific handling ---
    if (lang === 'go') {
        if (nodeType === 'function_declaration' || nodeType === 'method_declaration') {
            const name = getNodeName(node, lang);
            if (!name) { recurseChildren(node, ctx, parentName, parentClassNode); return; }
            emitSymbol(node, name, ctx, parentName, parentClassNode);
            return;
        }

        if (nodeType === 'type_declaration') {
            // type_declaration wraps type_spec nodes
            for (let i = 0; i < node.namedChildCount; i++) {
                const typeSpec = node.namedChild(i);
                if (!typeSpec || typeSpec.type !== 'type_spec') continue;
                const name = getNodeName(typeSpec, lang);
                if (!name) continue;
                emitSymbol(typeSpec, name, ctx, parentName, parentClassNode);
                const stableKey = makeStableKey(ctx.filePath, parentName, name);
                extractInheritanceRelations(typeSpec, stableKey, lang, ctx.relations);
            }
            return;
        }

        if (nodeType === 'const_declaration' || nodeType === 'var_declaration') {
            // These may contain multiple specs
            const specs = node.descendantsOfType(
                nodeType === 'const_declaration' ? 'const_spec' : 'var_spec'
            );
            if (specs.length > 0) {
                for (const spec of specs) {
                    const nameNode = spec.childForFieldName('name');
                    const name = nameNode?.text;
                    if (!name) continue;
                    emitSymbol(spec, name, ctx, parentName, parentClassNode);
                }
            } else {
                // Single-line declaration without spec wrapper — fallback
                const nameNodes = node.descendantsOfType('identifier');
                if (nameNodes.length > 0) {
                    const name = nameNodes[0].text;
                    if (name) {
                        emitSymbol(node, name, ctx, parentName, parentClassNode);
                    }
                }
            }
            return;
        }

        recurseChildren(node, ctx, parentName, parentClassNode);
        return;
    }

    // Fallback for unknown languages
    recurseChildren(node, ctx, parentName, parentClassNode);
}

function recurseChildren(
    node: any,
    ctx: WalkContext,
    parentName: string | null,
    parentClassNode: any | null,
): void {
    for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) walkNode(child, ctx, parentName, parentClassNode);
    }
}

/**
 * Emit a symbol into the context's symbols array, along with behavior hints,
 * contract hints, and call relations.
 */
function emitSymbol(
    node: any,
    name: string,
    ctx: WalkContext,
    parentName: string | null,
    parentClassNode: any | null,
): void {
    const stableKey = makeStableKey(ctx.filePath, parentName, name);
    const fullText = node.text as string;
    const sExpr = node.toString();
    const kind = classifyKind(node, ctx.language);

    // Determine visibility
    let visibility: string;
    if (ctx.language === 'typescript' || ctx.language === 'javascript') {
        const isExported = node.parent?.type === 'export_statement';
        visibility = isExported ? 'public' : detectVisibility(node, ctx.source, ctx.language, parentClassNode);
    } else {
        visibility = detectVisibility(node, ctx.source, ctx.language, parentClassNode);
    }

    // For methods inside a class in Python, override kind to 'method'
    let effectiveKind = kind;
    if (ctx.language === 'python' && parentName !== null && kind === 'function') {
        effectiveKind = 'method';
    }
    // For C++ function definitions inside a class, override to method
    if (ctx.language === 'cpp' && parentClassNode !== null && kind === 'function') {
        effectiveKind = 'method';
    }

    ctx.symbols.push({
        stable_key: stableKey,
        canonical_name: name,
        kind: effectiveKind,
        range_start_line: node.startPosition.row + 1,
        range_start_col: node.startPosition.column + 1,
        range_end_line: node.endPosition.row + 1,
        range_end_col: node.endPosition.column + 1,
        signature: extractSignature(node, ctx.language),
        ast_hash: sha256(sExpr),
        body_hash: sha256(fullText),
        normalized_ast_hash: computeNormalizedAstHash(fullText),
        visibility,
    });

    // Behavior hints for functions, methods, and function-valued variables
    if (effectiveKind === 'function' || effectiveKind === 'method') {
        extractBehaviorHints(fullText, stableKey, node.startPosition.row + 1, ctx.behaviorHints);
        extractContractHint(node, stableKey, ctx.language, ctx.contractHints);
        extractRelationsFromNode(node, stableKey, ctx.language, ctx.relations);
    }
}

// ---------------------------------------------------------------------------
// Error counting
// ---------------------------------------------------------------------------

function countErrors(node: any): number {
    let count = 0;
    if (node.isError || node.isMissing) count++;
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) count += countErrors(child);
    }
    return count;
}

// ---------------------------------------------------------------------------
// The UniversalAdapter class
// ---------------------------------------------------------------------------

export class UniversalAdapter {
    private readonly log: Logger;

    constructor() {
        this.log = new Logger('universal-adapter');
    }

    /**
     * Parse source code with tree-sitter and extract symbols, relations,
     * behavior hints, and contract hints.
     *
     * @param filePath - Relative or absolute path to the source file (used for stable keys)
     * @param source - The raw source code text
     * @param language - The language of the source code
     * @returns AdapterExtractionResult with all extracted data
     */
    public extract(
        filePath: string,
        source: string,
        language: SupportedLanguage,
    ): AdapterExtractionResult {
        const timer = this.log.startTimer('extract', { filePath, language });

        const symbols: ExtractedSymbol[] = [];
        const relations: ExtractedRelation[] = [];
        const behaviorHints: BehaviorHint[] = [];
        const contractHints: ContractHint[] = [];
        const uncertaintyFlags: string[] = [];

        // Handle empty source
        if (!source || source.trim().length === 0) {
            timer({ symbols: 0 });
            return {
                symbols,
                relations,
                behavior_hints: behaviorHints,
                contract_hints: contractHints,
                parse_confidence: 1.0,
                uncertainty_flags: ['empty_file'],
            };
        }

        // Parse
        let tree: any;
        try {
            const parser = getParser(language);
            tree = parser.parse(source);
        } catch (err) {
            this.log.error('tree-sitter parse failed', err, { filePath, language });
            return {
                symbols,
                relations,
                behavior_hints: behaviorHints,
                contract_hints: contractHints,
                parse_confidence: 0.0,
                uncertainty_flags: ['parse_failure'],
            };
        }

        const rootNode = tree.rootNode;
        if (!rootNode) {
            this.log.warn('tree-sitter returned no root node', { filePath });
            return {
                symbols,
                relations,
                behavior_hints: behaviorHints,
                contract_hints: contractHints,
                parse_confidence: 0.0,
                uncertainty_flags: ['no_root_node'],
            };
        }

        // Count parse errors for confidence scoring
        const errorCount = countErrors(rootNode);
        if (errorCount > 0) {
            uncertaintyFlags.push('parse_errors');
            this.log.debug('Parse errors detected', { filePath, errorCount });
        }

        // Build walk context
        const ctx: WalkContext = {
            filePath,
            language,
            source,
            symbols,
            relations,
            behaviorHints,
            contractHints,
            uncertaintyFlags,
            symbolTypeSet: getSymbolTypeSet(language),
        };

        // Walk the CST for symbols, behavior, contracts
        try {
            for (let i = 0; i < rootNode.namedChildCount; i++) {
                const child = rootNode.namedChild(i);
                if (child) walkNode(child, ctx, null, null);
            }
        } catch (err) {
            this.log.error('CST walk failed', err, { filePath, language });
            uncertaintyFlags.push('walk_failure');
        }

        // Extract import/export relations (module-level)
        try {
            extractImportRelations(rootNode, filePath, language, relations);
        } catch (err) {
            this.log.error('Import extraction failed', err, { filePath, language });
            uncertaintyFlags.push('import_extraction_failure');
        }

        // Deduplicate relations
        const deduplicatedRelations = deduplicateRelations(relations);

        // Compute parse confidence
        const totalNodes = rootNode.descendantCount || 1;
        let parseConfidence: number;
        if (errorCount === 0) {
            parseConfidence = 1.0;
        } else {
            // Reduce confidence proportionally to error ratio, with a floor of 0.3
            const errorRatio = errorCount / totalNodes;
            parseConfidence = Math.max(0.3, 1.0 - errorRatio * 5);
        }

        const result: AdapterExtractionResult = {
            symbols,
            relations: deduplicatedRelations,
            behavior_hints: behaviorHints,
            contract_hints: contractHints,
            parse_confidence: Math.round(parseConfidence * 100) / 100,
            uncertainty_flags: [...new Set(uncertaintyFlags)],
        };

        timer({
            symbols: symbols.length,
            relations: deduplicatedRelations.length,
            behavior_hints: behaviorHints.length,
            contract_hints: contractHints.length,
            parse_confidence: result.parse_confidence,
        });

        return result;
    }
}

/**
 * Deduplicate relations by (source_key, target_name, relation_type).
 */
function deduplicateRelations(relations: ExtractedRelation[]): ExtractedRelation[] {
    const seen = new Set<string>();
    const result: ExtractedRelation[] = [];
    for (const rel of relations) {
        const key = `${rel.source_key}|${rel.target_name}|${rel.relation_type}`;
        if (!seen.has(key)) {
            seen.add(key);
            result.push(rel);
        }
    }
    return result;
}

// ---------------------------------------------------------------------------
// Convenience function
// ---------------------------------------------------------------------------

/**
 * Parse source code with tree-sitter and extract symbols, relations,
 * behavior hints, and contract hints.
 *
 * This is a convenience wrapper around UniversalAdapter.extract().
 */
export function extractWithTreeSitter(
    filePath: string,
    source: string,
    language: SupportedLanguage,
): AdapterExtractionResult {
    const adapter = new UniversalAdapter();
    return adapter.extract(filePath, source, language);
}
