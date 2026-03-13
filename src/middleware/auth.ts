/**
 * ContextZero — API Key Authentication Middleware
 *
 * Bearer token and API key authentication. Fail-closed: if no keys
 * configured, all requests are rejected.
 *
 * Supports:
 * - Bearer token in Authorization header
 * - X-API-Key header
 * - Constant-time comparison via crypto.timingSafeEqual
 */

import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import { Logger } from '../logger';

const log = new Logger('auth');

/** Load API keys from environment (comma-separated) */
function loadApiKeys(): Buffer[] {
    const raw = process.env['SCG_API_KEYS'] || '';
    if (!raw.trim()) return [];
    return raw.split(',')
        .map(k => k.trim())
        .filter(k => k.length > 0)
        .map(k => Buffer.from(k, 'utf-8'));
}

let apiKeys = loadApiKeys();

if (apiKeys.length === 0) {
    log.warn('No API keys configured (SCG_API_KEYS). All requests will be rejected.');
}

// ────────── Per-IP Brute-Force Rate Limiting ──────────

interface FailureRecord {
    count: number;
    lockedUntil: number; // epoch ms; 0 = not locked
    lastFailureAt: number; // epoch ms of most recent failure
}

const ipFailures = new Map<string, FailureRecord>();

/**
 * Maximum tracked IPs to prevent unbounded memory growth during DDoS.
 * When exceeded, the oldest entry (first in Map insertion order) is evicted.
 */
const MAX_IP_TRACKING = 10_000;

/** Lockout durations: 5 failures = 30s, 10+ failures = 5min */
function getLockoutMs(failures: number): number {
    if (failures >= 10) return 5 * 60 * 1000;  // 5 minutes
    if (failures >= 5)  return 30 * 1000;       // 30 seconds
    return 0;
}

/**
 * Check whether an IP is currently throttled.
 * Returns true if the request should be rejected.
 */
function isThrottled(ip: string): boolean {
    const record = ipFailures.get(ip);
    if (!record) return false;
    if (record.lockedUntil > 0 && Date.now() < record.lockedUntil) return true;
    // Lock expired — keep the failure count so escalation still works
    return false;
}

function recordFailure(ip: string): void {
    const record = ipFailures.get(ip) || { count: 0, lockedUntil: 0, lastFailureAt: 0 };
    record.count++;
    record.lastFailureAt = Date.now();
    const lockoutMs = getLockoutMs(record.count);
    if (lockoutMs > 0) {
        record.lockedUntil = Date.now() + lockoutMs;
        log.warn('IP locked out due to repeated auth failures', {
            ip, failures: record.count, lockoutMs,
        });
    }
    ipFailures.set(ip, record);

    // Evict oldest entries when map exceeds size limit (DDoS protection)
    if (ipFailures.size > MAX_IP_TRACKING) {
        const now = Date.now();
        // First pass: try to evict unlocked, stale entries
        let evicted = false;
        for (const [evictIp, evictRecord] of ipFailures.entries()) {
            if (evictRecord.lockedUntil < now && evictRecord.count < 5) {
                ipFailures.delete(evictIp);
                evicted = true;
                break;
            }
        }
        // Fallback: evict the oldest entry regardless (first in Map order)
        if (!evicted) {
            const oldestIp = ipFailures.keys().next().value;
            if (oldestIp !== undefined) {
                ipFailures.delete(oldestIp);
            }
        }
    }
}

function resetFailures(ip: string): void {
    ipFailures.delete(ip);
}

// Periodic cleanup of stale entries (every 60s)
setInterval(() => {
    const now = Date.now();
    const staleThreshold = 10 * 60 * 1000; // 10 minutes
    for (const [ip, record] of ipFailures.entries()) {
        // Only remove entries whose last failure was > 10 minutes ago
        // AND whose lockout (if any) has expired.
        // This prevents slow brute-force attacks from resetting the counter.
        if (record.lastFailureAt < now - staleThreshold &&
            (record.lockedUntil === 0 || record.lockedUntil < now)) {
            ipFailures.delete(ip);
        }
    }
}, 60_000).unref();

/**
 * Constant-time comparison to prevent timing attacks.
 */
function safeCompare(a: Buffer, b: Buffer): boolean {
    if (a.length !== b.length) {
        // Burn the same time as a real comparison, then return false
        crypto.timingSafeEqual(a, a);
        return false;
    }
    return crypto.timingSafeEqual(a, b);
}

/**
 * Extract API key from request headers.
 * Checks Authorization: Bearer <token> first, then X-API-Key header.
 */
function extractKey(req: Request): string | null {
    const authHeader = req.headers['authorization'];
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
        return authHeader.slice(7);
    }
    const xApiKey = req.headers['x-api-key'];
    if (typeof xApiKey === 'string' && xApiKey.length > 0) {
        return xApiKey;
    }
    return null;
}

/**
 * Authentication middleware.
 * Fail-closed: rejects if no keys configured or no valid key presented.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    // Health check and metrics bypass
    if (req.path === '/health' || req.path === '/ready' || req.path === '/metrics') {
        next();
        return;
    }

    // Pre-auth brute-force check — reject before any key validation
    const clientIp = req.ip || 'unknown';
    if (isThrottled(clientIp)) {
        log.warn('Auth rejected: IP throttled', { path: req.path, ip: clientIp });
        res.status(429).json({ error: 'Too many authentication failures. Try again later.' });
        return;
    }

    if (apiKeys.length === 0) {
        log.warn('Auth rejected: no API keys configured', { path: req.path });
        res.status(503).json({ error: 'Service not configured — no API keys set' });
        return;
    }

    const presented = extractKey(req);
    if (!presented) {
        recordFailure(clientIp);
        log.warn('Auth rejected: no key presented', { path: req.path, ip: clientIp });
        res.status(401).json({ error: 'Authentication required. Provide Bearer token or X-API-Key header.' });
        return;
    }

    const presentedBuf = Buffer.from(presented, 'utf-8');
    const valid = apiKeys.some(key => safeCompare(presentedBuf, key));

    if (!valid) {
        recordFailure(clientIp);
        log.warn('Auth rejected: invalid key', { path: req.path, ip: clientIp });
        res.status(403).json({ error: 'Invalid API key' });
        return;
    }

    // Successful auth — reset failure counter
    resetFailures(clientIp);
    next();
}

// ────────── SIGHUP: Hot-Reload API Keys ──────────

process.on('SIGHUP', () => {
    const newKeys = loadApiKeys();
    if (newKeys.length === 0) {
        log.warn('SIGHUP: refusing to clear API keys — new set is empty');
        return;
    }
    apiKeys = newKeys;
    log.info('SIGHUP: API keys reloaded', { count: newKeys.length });
});
