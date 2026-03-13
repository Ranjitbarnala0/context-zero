// CJS-compatible mock for uuid v13 (ESM-only in node_modules)
let counter = 0;

export function v4(): string {
    counter++;
    return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

export function v7(): string {
    return v4();
}
