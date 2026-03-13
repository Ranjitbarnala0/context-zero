/**
 * ContextZero — Code-Aware Tokenizer
 *
 * Generates multi-view token streams from code symbols.
 * 5 views: name, body, signature, behavior, contract
 *
 * Unlike NLP tokenizers, this understands code structure:
 * - Splits camelCase/PascalCase/snake_case identifiers
 * - Preserves meaningful operators and keywords
 * - Strips comments, string literals, numeric literals
 * - Stems common programming suffixes (Handler->handle, Service->serve, etc.)
 */

// Common JS/TS keywords and noise words to remove from body tokens
const NOISE_WORDS: Set<string> = new Set([
    'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
    'this', 'new', 'true', 'false', 'null', 'undefined', 'import', 'export',
    'from', 'async', 'await', 'class', 'interface', 'type', 'extends',
    'implements', 'void', 'string', 'number', 'boolean', 'any', 'unknown',
    'never', 'promise',
]);

// Programming suffix stemming rules: suffix -> stem
const SUFFIX_STEMS: [string, string][] = [
    ['handler', 'handle'],
    ['service', 'serve'],
    ['manager', 'manage'],
    ['factory', 'factor'],
    ['builder', 'build'],
    ['provider', 'provide'],
    ['controller', 'control'],
    ['validator', 'valid'],
    ['serializer', 'serial'],
    ['repository', 'repo'],
    ['middleware', 'middle'],
    ['resolver', 'resolv'],
    ['adapter', 'adapt'],
    ['listener', 'listen'],
    ['observer', 'observ'],
    ['wrapper', 'wrap'],
    ['helper', 'help'],
    ['utility', 'util'],
];

/**
 * Normalize a single token: lowercase, remove trailing digits, apply stemming.
 * Returns empty string for tokens < 2 chars after processing.
 */
export function normalizeToken(token: string): string {
    // Lowercase
    let normalized = token.toLowerCase();

    // Remove trailing digits
    normalized = normalized.replace(/\d+$/, '');

    // Apply suffix stemming rules
    for (const [suffix, stem] of SUFFIX_STEMS) {
        if (normalized === suffix) {
            normalized = stem;
            break;
        }
    }

    // Return empty string if token is too short
    if (normalized.length < 2) {
        return '';
    }

    return normalized;
}

/**
 * Split a compound identifier into its component words.
 * Handles camelCase, PascalCase, snake_case, and SCREAMING_SNAKE_CASE.
 */
function splitCompoundName(name: string): string[] {
    // First split on underscores and hyphens
    const parts = name.split(/[_-]+/).filter(Boolean);

    const result: string[] = [];
    for (const part of parts) {
        // Split camelCase/PascalCase:
        // Insert split before an uppercase letter that follows a lowercase letter
        // Also split before an uppercase letter followed by a lowercase (for "XMLParser" -> "XML", "Parser")
        const subParts = part
            .replace(/([a-z])([A-Z])/g, '$1\x00$2')
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1\x00$2')
            .split('\x00');

        for (const sub of subParts) {
            if (sub.length > 0) {
                result.push(sub);
            }
        }
    }

    return result;
}

/**
 * Tokenize a symbol name: split compound names, lowercase, stem suffixes.
 */
export function tokenizeName(name: string): string[] {
    const parts = splitCompoundName(name);
    const tokens: string[] = [];

    for (const part of parts) {
        const normalized = normalizeToken(part);
        if (normalized !== '') {
            tokens.push(normalized);
        }
    }

    return tokens;
}

/**
 * Tokenize a code body: extract all identifiers, split compound names,
 * remove keywords/noise, deduplicate.
 */
export function tokenizeBody(code: string): string[] {
    // Strip comments: single-line and multi-line
    let stripped = code.replace(/\/\/.*$/gm, '');
    stripped = stripped.replace(/\/\*[\s\S]*?\*\//g, '');

    // Strip string literals (single-quoted, double-quoted, backtick)
    stripped = stripped.replace(/'(?:[^'\\]|\\.)*'/g, '');
    stripped = stripped.replace(/"(?:[^"\\]|\\.)*"/g, '');
    stripped = stripped.replace(/`(?:[^`\\]|\\.)*`/g, '');

    // Strip numeric literals (decimal, hex 0x, binary 0b, octal 0o, scientific notation)
    stripped = stripped.replace(/\b0[xX][0-9a-fA-F]+\b/g, '');
    stripped = stripped.replace(/\b0[bB][01]+\b/g, '');
    stripped = stripped.replace(/\b0[oO][0-7]+\b/g, '');
    stripped = stripped.replace(/\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, '');

    // Extract all identifiers
    const identifierRegex = /[a-zA-Z_$][a-zA-Z0-9_$]*/g;
    const rawIdentifiers: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = identifierRegex.exec(stripped)) !== null) {
        rawIdentifiers.push(match[0]);
    }

    // Split compound names, normalize, remove noise, deduplicate
    const seen = new Set<string>();
    const tokens: string[] = [];

    for (const ident of rawIdentifiers) {
        const parts = splitCompoundName(ident);
        for (const part of parts) {
            const normalized = normalizeToken(part);
            if (normalized !== '' && !NOISE_WORDS.has(normalized) && !seen.has(normalized)) {
                seen.add(normalized);
                tokens.push(normalized);
            }
        }
    }

    return tokens;
}

/**
 * Tokenize a function/method signature: extract parameter names, type names,
 * return type. Split compounds, remove noise.
 */
export function tokenizeSignature(signature: string): string[] {
    // Extract all identifiers from the signature
    const identifierRegex = /[a-zA-Z_$][a-zA-Z0-9_$]*/g;
    const rawIdentifiers: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = identifierRegex.exec(signature)) !== null) {
        rawIdentifiers.push(match[0]);
    }

    // Split compound names, normalize, remove noise, deduplicate
    const seen = new Set<string>();
    const tokens: string[] = [];

    for (const ident of rawIdentifiers) {
        const parts = splitCompoundName(ident);
        for (const part of parts) {
            const normalized = normalizeToken(part);
            if (normalized !== '' && !NOISE_WORDS.has(normalized) && !seen.has(normalized)) {
                seen.add(normalized);
                tokens.push(normalized);
            }
        }
    }

    return tokens;
}

/**
 * Tokenize behavioral hints: convert each hint_type + detail into tokens.
 */
export function tokenizeBehavior(hints: { hint_type: string; detail: string }[]): string[] {
    const seen = new Set<string>();
    const tokens: string[] = [];

    for (const hint of hints) {
        // Tokenize the hint_type (e.g., "db_read" -> ["db", "read"])
        const typeParts = splitCompoundName(hint.hint_type);
        for (const part of typeParts) {
            const normalized = normalizeToken(part);
            if (normalized !== '' && !seen.has(normalized)) {
                seen.add(normalized);
                tokens.push(normalized);
            }
        }

        // Tokenize the detail string
        const identifierRegex = /[a-zA-Z_$][a-zA-Z0-9_$]*/g;
        let match: RegExpExecArray | null;

        while ((match = identifierRegex.exec(hint.detail)) !== null) {
            const detailParts = splitCompoundName(match[0]);
            for (const part of detailParts) {
                const normalized = normalizeToken(part);
                if (normalized !== '' && !NOISE_WORDS.has(normalized) && !seen.has(normalized)) {
                    seen.add(normalized);
                    tokens.push(normalized);
                }
            }
        }
    }

    return tokens;
}

/**
 * Tokenize a contract hint: extract type names from input/output/thrown types
 * and decorators, split compounds.
 */
export function tokenizeContract(hint: {
    input_types: string[];
    output_type: string;
    thrown_types: string[];
    decorators: string[];
}): string[] {
    const seen = new Set<string>();
    const tokens: string[] = [];

    const allTypeStrings = [
        ...hint.input_types,
        hint.output_type,
        ...hint.thrown_types,
        ...hint.decorators,
    ];

    for (const typeStr of allTypeStrings) {
        // Extract identifiers from type expressions (handles generics like Promise<User[]>)
        const identifierRegex = /[a-zA-Z_$][a-zA-Z0-9_$]*/g;
        let match: RegExpExecArray | null;

        while ((match = identifierRegex.exec(typeStr)) !== null) {
            const parts = splitCompoundName(match[0]);
            for (const part of parts) {
                const normalized = normalizeToken(part);
                if (normalized !== '' && !NOISE_WORDS.has(normalized) && !seen.has(normalized)) {
                    seen.add(normalized);
                    tokens.push(normalized);
                }
            }
        }
    }

    return tokens;
}
