/**
 * ContextZero — Input Validation Middleware
 *
 * Production-grade validation layer for all API request bodies.
 * Prevents malformed UUIDs, unbounded numbers, oversized strings,
 * path traversal, and type confusion attacks.
 *
 * Every route MUST use validateBody() — no ad-hoc validation.
 */

import * as path from 'path';
import { Request, Response, NextFunction } from 'express';
import { Logger } from '../logger';

const log = new Logger('validation');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUUID(value: unknown): value is string {
    return typeof value === 'string' && UUID_REGEX.test(value);
}

export function isValidUUIDArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.length > 0 && value.length <= 100 && value.every(isValidUUID);
}

export function isNonEmptyString(value: unknown, maxLen: number = 1000): value is string {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLen;
}

export function isBoundedNumber(value: unknown, min: number, max: number): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

/** Maximum depth for graph traversal operations */
export const MAX_GRAPH_DEPTH = 5;

/** Maximum limit for list queries */
export const MAX_LIST_LIMIT = 100;

/** Maximum token budget */
export const MAX_TOKEN_BUDGET = 100_000;

/** Maximum patches per request */
export const MAX_PATCH_COUNT = 100;

/** Maximum changed paths for incremental indexing */
export const MAX_CHANGED_PATHS = 500;

/**
 * Generic validation middleware factory.
 * Returns 400 with specific error messages for invalid inputs.
 */
export function validateBody(rules: Record<string, (value: unknown) => string | null>):
    (req: Request, res: Response, next: NextFunction) => void {
    return (req: Request, res: Response, next: NextFunction) => {
        const errors: string[] = [];
        for (const [field, validator] of Object.entries(rules)) {
            const value = req.body?.[field];
            const error = validator(value);
            if (error) {
                errors.push(`${field}: ${error}`);
            }
        }
        if (errors.length > 0) {
            log.warn('Validation failed', { path: req.path, errors });
            res.status(400).json({ error: 'Validation failed', details: errors });
            return;
        }
        next();
    };
}

// ────────── Pre-built Validators ──────────

export const requireUUID = (value: unknown): string | null => {
    if (value === undefined || value === null) return 'required';
    if (!isValidUUID(value)) return 'must be a valid UUID';
    return null;
};

export const optionalUUID = (value: unknown): string | null => {
    if (value === undefined || value === null) return null;
    if (!isValidUUID(value)) return 'must be a valid UUID';
    return null;
};

export const requireUUIDArray = (value: unknown): string | null => {
    if (value === undefined || value === null) return 'required';
    if (!isValidUUIDArray(value)) return 'must be an array of 1-100 valid UUIDs';
    return null;
};

export const requireString = (value: unknown): string | null => {
    if (!isNonEmptyString(value, 2000)) return 'required, non-empty string (max 2000 chars)';
    return null;
};

export const optionalString = (value: unknown): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || value.length > 2000) return 'must be a string (max 2000 chars)';
    return null;
};

/** Validates an optional bounded integer — allows undefined/null, rejects out-of-range */
export const requireBoundedInt = (min: number, max: number) => (value: unknown): string | null => {
    if (value === undefined || value === null) return null;
    if (!isBoundedNumber(value, min, max)) return `must be a number between ${min} and ${max}`;
    return null;
};

/** Validates an optional enum value against an allowed set */
export const optionalEnum = (...allowed: string[]) => (value: unknown): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || !allowed.includes(value)) {
        return `must be one of: ${allowed.join(', ')}`;
    }
    return null;
};

/** Validates a required enum value against an allowed set */
export const requireEnum = (...allowed: string[]) => (value: unknown): string | null => {
    if (value === undefined || value === null) return 'required';
    if (typeof value !== 'string' || !allowed.includes(value)) {
        return `must be one of: ${allowed.join(', ')}`;
    }
    return null;
};

/** Validates a confidence threshold (0.0 to 1.0) */
export const optionalConfidence = (value: unknown): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        return 'must be a number between 0.0 and 1.0';
    }
    return null;
};

/** Validates an array of non-empty strings with a max length */
export const requireStringArray = (maxLen: number = MAX_CHANGED_PATHS) => (value: unknown): string | null => {
    if (value === undefined || value === null) return 'required';
    if (!Array.isArray(value)) return 'must be an array';
    if (value.length === 0) return 'must not be empty';
    if (value.length > maxLen) return `must have at most ${maxLen} items`;
    for (let i = 0; i < value.length; i++) {
        if (typeof value[i] !== 'string' || (value[i] as string).length === 0) {
            return `item at index ${i}: must be a non-empty string`;
        }
        if ((value[i] as string).length > 2000) {
            return `item at index ${i}: exceeds max length of 2000`;
        }
    }
    return null;
};

/** Validates an array of patch entries [{file_path, new_content}] */
export const requirePatchArray = (value: unknown): string | null => {
    if (value === undefined || value === null) return 'required';
    if (!Array.isArray(value) || value.length === 0) return 'must be a non-empty array';
    if (value.length > MAX_PATCH_COUNT) return `must have at most ${MAX_PATCH_COUNT} patches`;
    for (let i = 0; i < value.length; i++) {
        const p = value[i] as Record<string, unknown> | null;
        if (!p || typeof p !== 'object') return `patches[${i}]: must be an object`;
        if (typeof p.file_path !== 'string' || (p.file_path as string).length === 0) {
            return `patches[${i}].file_path: required non-empty string`;
        }
        if (typeof p.new_content !== 'string') {
            return `patches[${i}].new_content: required string`;
        }
        // Block path traversal at validation level
        const filePath = p.file_path as string;
        // Reject URL-encoded characters that could bypass normalization
        if (/%[0-9a-fA-F]{2}/.test(filePath)) {
            return `patches[${i}].file_path: URL-encoded characters not allowed`;
        }
        // Reject backslashes (Windows paths) — normalize to forward slash only
        if (filePath.includes('\\')) {
            return `patches[${i}].file_path: backslashes not allowed`;
        }
        const normalized = path.normalize(filePath);
        if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
            return `patches[${i}].file_path: path traversal or absolute path not allowed`;
        }
    }
    return null;
};

/**
 * Validates a filesystem path for repository registration.
 * Must be absolute, no null bytes, no suspicious patterns.
 */
export const requireAbsolutePath = (value: unknown): string | null => {
    if (value === undefined || value === null) return 'required';
    if (typeof value !== 'string' || value.length === 0) return 'required non-empty string';
    if (value.length > 4096) return 'path too long (max 4096 chars)';
    if (value.includes('\0')) return 'path must not contain null bytes';
    if (!path.isAbsolute(value)) return 'must be an absolute path';
    return null;
};

/** Validates that string array items contain no path traversal sequences */
export const requireSafePathArray = (maxLen: number = MAX_CHANGED_PATHS) => (value: unknown): string | null => {
    const baseErr = requireStringArray(maxLen)(value);
    if (baseErr) return baseErr;
    for (let i = 0; i < (value as string[]).length; i++) {
        const p = (value as string[])[i]!;
        if (/%[0-9a-fA-F]{2}/.test(p)) {
            return `item at index ${i}: URL-encoded characters not allowed`;
        }
        if (p.includes('\\')) {
            return `item at index ${i}: backslashes not allowed`;
        }
        const normalized = path.normalize(p);
        if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
            return `item at index ${i}: path traversal or absolute path not allowed`;
        }
        if (p.includes('\0')) {
            return `item at index ${i}: path must not contain null bytes`;
        }
    }
    return null;
};
