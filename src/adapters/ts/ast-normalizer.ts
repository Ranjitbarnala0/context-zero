/**
 * ContextZero — AST Normalization Engine
 *
 * Produces rename-invariant, whitespace-invariant AST hashes.
 * This replaces the trivial binary hash comparison in the homolog engine
 * with proper structural similarity detection.
 *
 * Normalization steps:
 * 1. Strip all comments
 * 2. Normalize all whitespace to single spaces
 * 3. Alpha-rename all local variables (local1, local2, ...)
 * 4. Alpha-rename all parameters (param1, param2, ...)
 * 5. Preserve: imported names, type names, method calls, literals
 * 6. Hash the normalized form with SHA-256
 */

import * as ts from 'typescript';
import * as crypto from 'crypto';

/**
 * Walk the AST of a function/method/arrow, collect local variable declarations
 * and parameter names, build a rename map, then serialize to a normalized string.
 *
 * Identifiers that are locals/params get renamed; external references are preserved.
 * Literals are type-normalized: strings -> STR, numbers -> NUM, booleans preserved.
 * Structural tokens (BLOCK, IF, FOR, WHILE, RETURN, CALL) are emitted canonically.
 */
export function normalizeAST(
    node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction,
    sourceFile: ts.SourceFile
): string {
    const renameMap = new Map<string, string>();
    let paramCounter = 0;
    let localCounter = 0;

    // Phase 1: collect parameter names
    for (const param of node.parameters) {
        if (ts.isIdentifier(param.name)) {
            const name = param.name.getText(sourceFile);
            renameMap.set(name, `param${paramCounter++}`);
        }
    }

    // Phase 2: collect local variable declarations
    function collectLocals(n: ts.Node): void {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
            const name = n.name.getText(sourceFile);
            if (!renameMap.has(name)) {
                renameMap.set(name, `local${localCounter++}`);
            }
        }
        ts.forEachChild(n, collectLocals);
    }
    if (node.body) {
        collectLocals(node.body);
    }

    // Phase 3: serialize to normalized form
    function serialize(n: ts.Node): string {
        // Identifier
        if (ts.isIdentifier(n)) {
            const name = n.getText(sourceFile);
            return renameMap.get(name) ?? name;
        }

        // String literal
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
            return 'STR';
        }

        // Numeric literal
        if (ts.isNumericLiteral(n)) {
            return 'NUM';
        }

        // Boolean keywords
        if (n.kind === ts.SyntaxKind.TrueKeyword) return 'true';
        if (n.kind === ts.SyntaxKind.FalseKeyword) return 'false';
        if (n.kind === ts.SyntaxKind.NullKeyword) return 'null';
        if (n.kind === ts.SyntaxKind.UndefinedKeyword) return 'undefined';

        // Block
        if (ts.isBlock(n)) {
            const children: string[] = [];
            for (const stmt of n.statements) {
                children.push(serialize(stmt));
            }
            return `BLOCK{${children.join(';')}}`;
        }

        // If statement
        if (ts.isIfStatement(n)) {
            let result = `IF(${serialize(n.expression)}){${serialize(n.thenStatement)}}`;
            if (n.elseStatement) {
                result += `ELSE{${serialize(n.elseStatement)}}`;
            }
            return result;
        }

        // For statement
        if (ts.isForStatement(n)) {
            const init = n.initializer ? serialize(n.initializer) : '';
            const cond = n.condition ? serialize(n.condition) : '';
            const incr = n.incrementor ? serialize(n.incrementor) : '';
            return `FOR(${init};${cond};${incr}){${serialize(n.statement)}}`;
        }

        // ForOf / ForIn
        if (ts.isForOfStatement(n)) {
            return `FOROF(${serialize(n.initializer)};${serialize(n.expression)}){${serialize(n.statement)}}`;
        }
        if (ts.isForInStatement(n)) {
            return `FORIN(${serialize(n.initializer)};${serialize(n.expression)}){${serialize(n.statement)}}`;
        }

        // While statement
        if (ts.isWhileStatement(n)) {
            return `WHILE(${serialize(n.expression)}){${serialize(n.statement)}}`;
        }

        // Do-while statement
        if (ts.isDoStatement(n)) {
            return `DO{${serialize(n.statement)}}WHILE(${serialize(n.expression)})`;
        }

        // Return statement
        if (ts.isReturnStatement(n)) {
            return `RETURN${n.expression ? ' ' + serialize(n.expression) : ''}`;
        }

        // Call expression — preserve callee name, normalize args
        if (ts.isCallExpression(n)) {
            const callee = serialize(n.expression);
            const args = n.arguments.map(a => serialize(a)).join(',');
            return `CALL(${callee})(${args})`;
        }

        // Property access
        if (ts.isPropertyAccessExpression(n)) {
            return `${serialize(n.expression)}.${n.name.getText(sourceFile)}`;
        }

        // Binary expression
        if (ts.isBinaryExpression(n)) {
            const op = n.operatorToken.getText(sourceFile);
            return `(${serialize(n.left)}${op}${serialize(n.right)})`;
        }

        // Prefix unary
        if (ts.isPrefixUnaryExpression(n)) {
            const opText = ts.tokenToString(n.operator) ?? '';
            return `${opText}${serialize(n.operand)}`;
        }

        // Postfix unary
        if (ts.isPostfixUnaryExpression(n)) {
            const opText = ts.tokenToString(n.operator) ?? '';
            return `${serialize(n.operand)}${opText}`;
        }

        // Variable declaration list
        if (ts.isVariableDeclarationList(n)) {
            return n.declarations.map(d => serialize(d)).join(',');
        }

        // Variable declaration
        if (ts.isVariableDeclaration(n)) {
            const nameStr = serialize(n.name);
            return n.initializer ? `${nameStr}=${serialize(n.initializer)}` : nameStr;
        }

        // Variable statement
        if (ts.isVariableStatement(n)) {
            return serialize(n.declarationList);
        }

        // Expression statement
        if (ts.isExpressionStatement(n)) {
            return serialize(n.expression);
        }

        // Throw statement
        if (ts.isThrowStatement(n)) {
            return `THROW ${n.expression ? serialize(n.expression) : ''}`;
        }

        // Try statement
        if (ts.isTryStatement(n)) {
            let result = `TRY{${serialize(n.tryBlock)}}`;
            if (n.catchClause) {
                const varName = n.catchClause.variableDeclaration
                    ? serialize(n.catchClause.variableDeclaration.name)
                    : '';
                result += `CATCH(${varName}){${serialize(n.catchClause.block)}}`;
            }
            if (n.finallyBlock) {
                result += `FINALLY{${serialize(n.finallyBlock)}}`;
            }
            return result;
        }

        // Switch
        if (ts.isSwitchStatement(n)) {
            const clauses = n.caseBlock.clauses.map(c => {
                if (ts.isCaseClause(c)) {
                    const stmts = c.statements.map(s => serialize(s)).join(';');
                    return `CASE(${serialize(c.expression)}){${stmts}}`;
                }
                const stmts = c.statements.map(s => serialize(s)).join(';');
                return `DEFAULT{${stmts}}`;
            }).join('');
            return `SWITCH(${serialize(n.expression)}){${clauses}}`;
        }

        // Await expression
        if (ts.isAwaitExpression(n)) {
            return `AWAIT ${serialize(n.expression)}`;
        }

        // New expression
        if (ts.isNewExpression(n)) {
            const args = n.arguments ? n.arguments.map(a => serialize(a)).join(',') : '';
            return `NEW ${serialize(n.expression)}(${args})`;
        }

        // Array literal
        if (ts.isArrayLiteralExpression(n)) {
            return `[${n.elements.map(e => serialize(e)).join(',')}]`;
        }

        // Object literal
        if (ts.isObjectLiteralExpression(n)) {
            const props = n.properties.map(p => {
                if (ts.isPropertyAssignment(p)) {
                    return `${serialize(p.name)}:${serialize(p.initializer)}`;
                }
                if (ts.isShorthandPropertyAssignment(p)) {
                    return serialize(p.name);
                }
                return p.getText(sourceFile);
            }).join(',');
            return `{${props}}`;
        }

        // Conditional (ternary)
        if (ts.isConditionalExpression(n)) {
            return `(${serialize(n.condition)}?${serialize(n.whenTrue)}:${serialize(n.whenFalse)})`;
        }

        // Arrow function (nested)
        if (ts.isArrowFunction(n)) {
            const params = n.parameters.map(p => serialize(p.name)).join(',');
            const body = serialize(n.body);
            return `ARROW(${params})=>${body}`;
        }

        // Parenthesized expression
        if (ts.isParenthesizedExpression(n)) {
            return `(${serialize(n.expression)})`;
        }

        // Template expression
        if (ts.isTemplateExpression(n)) {
            return 'STR';
        }

        // Type assertion / as expression
        if (ts.isTypeAssertionExpression(n) || ts.isAsExpression(n)) {
            return serialize(n.expression);
        }

        // Spread element
        if (ts.isSpreadElement(n)) {
            return `...${serialize(n.expression)}`;
        }

        // Element access expression
        if (ts.isElementAccessExpression(n)) {
            return `${serialize(n.expression)}[${serialize(n.argumentExpression)}]`;
        }

        // Fallback: recursively serialize children separated by spaces
        const parts: string[] = [];
        ts.forEachChild(n, child => {
            parts.push(serialize(child));
        });
        return parts.join(' ');
    }

    if (node.body) {
        return serialize(node.body);
    }
    return '';
}

/**
 * Compute SHA-256 hash of a normalized AST form.
 */
export function computeNormalizedHash(normalizedForm: string): string {
    return crypto.createHash('sha256').update(normalizedForm, 'utf-8').digest('hex');
}

/**
 * Simpler regex-based normalization for cases where we don't have a full AST.
 *
 * Steps:
 * 1. Remove single-line comments (//...)
 * 2. Remove multi-line comments
 * 3. Collapse whitespace
 * 4. Alpha-rename const/let/var declarations to v0, v1, ...
 * 5. Alpha-rename parameter names in (name: type, ...) patterns to p0, p1, ...
 * 6. Hash the result with SHA-256
 */
export function normalizeForComparison(code: string): string {
    let normalized = code;

    // 1. Remove single-line comments
    normalized = normalized.replace(/\/\/[^\n]*/g, '');

    // 2. Remove multi-line comments
    normalized = normalized.replace(/\/\*[\s\S]*?\*\//g, '');

    // 3. Collapse whitespace
    normalized = normalized.replace(/\s+/g, ' ').trim();

    // 4. Alpha-rename function/class declaration names
    //    This ensures `function f(...)` and `function g(...)` with identical bodies
    //    produce the same normalized form.
    let fnCounter = 0;
    const fnMap = new Map<string, string>();

    normalized = normalized.replace(
        /\b(function|class)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
        (_match, keyword: string, name: string) => {
            if (!fnMap.has(name)) {
                fnMap.set(name, `_F${fnCounter++}`);
            }
            return `${keyword} ${fnMap.get(name)!}`;
        }
    );

    // 5. Alpha-rename local variable declarations
    let varCounter = 0;
    const varMap = new Map<string, string>();

    normalized = normalized.replace(
        /\b(const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
        (_match, keyword: string, name: string) => {
            if (!varMap.has(name)) {
                varMap.set(name, `v${varCounter++}`);
            }
            return `${keyword} ${varMap.get(name)!}`;
        }
    );

    // 6. Alpha-rename parameter names in function signatures
    //    Match patterns like (name: type, name2: type2) or (name, name2)
    let paramCounter = 0;
    const paramMap = new Map<string, string>();

    // Find function parameter lists: function name(params) or (params) =>
    normalized = normalized.replace(
        /\(([^)]*)\)\s*(?:=>|{|:)/g,
        (fullMatch, paramList: string) => {
            const renamedParams = paramList.replace(
                /([a-zA-Z_$][a-zA-Z0-9_$]*)(\s*[?]?\s*:\s*[^,)]*)?/g,
                (_pm: string, pName: string, pType: string) => {
                    // Skip if it looks like a type keyword
                    if (['string', 'number', 'boolean', 'void', 'any', 'unknown', 'never', 'null', 'undefined', 'object', 'Record', 'Promise', 'Array'].includes(pName)) {
                        return _pm;
                    }
                    if (!paramMap.has(pName)) {
                        paramMap.set(pName, `p${paramCounter++}`);
                    }
                    return `${paramMap.get(pName)!}${pType || ''}`;
                }
            );
            return `(${renamedParams})${fullMatch.slice(fullMatch.indexOf(')') + 1)}`;
        }
    );

    // 7. Replace all renamed identifiers throughout the body
    for (const [original, replacement] of fnMap) {
        const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        normalized = normalized.replace(new RegExp(`\\b${escaped}\\b`, 'g'), replacement);
    }
    for (const [original, replacement] of varMap) {
        const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        normalized = normalized.replace(new RegExp(`\\b${escaped}\\b`, 'g'), replacement);
    }
    for (const [original, replacement] of paramMap) {
        const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        normalized = normalized.replace(new RegExp(`\\b${escaped}\\b`, 'g'), replacement);
    }

    // 8. Final structural normalization:
    //    - Strip spaces around punctuation for whitespace invariance
    //    - Collapse consecutive semicolons (empty statements are noise)
    //    - Final whitespace collapse
    normalized = normalized.replace(/\s*([(){}[\],;:=<>+\-*/&|!?.])\s*/g, '$1');
    normalized = normalized.replace(/;{2,}/g, ';');
    normalized = normalized.replace(/\s+/g, ' ').trim();

    // Hash the result
    return computeNormalizedHash(normalized);
}
