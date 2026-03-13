/**
 * ContextZero — Rate Limiting Middleware
 *
 * In-memory sliding window rate limiter with per-route configuration.
 *
 * Features:
 * - Sliding window counter per client IP
 * - Per-route rate configurations
 * - Retry-After header on 429
 * - Periodic cleanup of expired windows
 */

import { Request, Response, NextFunction } from 'express';
import { Logger } from '../logger';

const log = new Logger('rate-limiter');

interface WindowEntry {
    count: number;
    windowStart: number;
}

interface RateConfig {
    maxRequests: number;
    windowMs: number;
}

/** Per-route rate configurations */
const ROUTE_LIMITS: Record<string, RateConfig> = {
    // Expensive computation endpoints
    '/scg_find_homologs':           { maxRequests: 20,  windowMs: 60_000 },
    '/scg_blast_radius':            { maxRequests: 30,  windowMs: 60_000 },
    '/scg_compile_context_capsule': { maxRequests: 30,  windowMs: 60_000 },
    // Write/mutation endpoints
    '/scg_ingest_repo':             { maxRequests: 5,   windowMs: 300_000 },
    '/scg_create_change_transaction': { maxRequests: 20, windowMs: 60_000 },
    '/scg_apply_patch':             { maxRequests: 30,  windowMs: 60_000 },
    '/scg_validate_change':         { maxRequests: 20,  windowMs: 60_000 },
    '/scg_commit_change':           { maxRequests: 10,  windowMs: 60_000 },
    '/scg_rollback_change':         { maxRequests: 10,  windowMs: 60_000 },
    // Default for all other endpoints
    '__default__':                  { maxRequests: 60,  windowMs: 60_000 },
};

class SlidingWindowLimiter {
    private windows: Map<string, WindowEntry> = new Map();
    private cleanupInterval: ReturnType<typeof setInterval>;

    constructor() {
        this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
        if (this.cleanupInterval.unref) {
            this.cleanupInterval.unref();
        }
    }

    public check(key: string, config: RateConfig): { allowed: boolean; retryAfterMs: number } {
        const now = Date.now();
        const entry = this.windows.get(key);

        if (!entry || (now - entry.windowStart) >= config.windowMs) {
            this.windows.set(key, { count: 1, windowStart: now });
            return { allowed: true, retryAfterMs: 0 };
        }

        if (entry.count >= config.maxRequests) {
            const retryAfterMs = config.windowMs - (now - entry.windowStart);
            return { allowed: false, retryAfterMs };
        }

        entry.count++;
        return { allowed: true, retryAfterMs: 0 };
    }

    private cleanup(): void {
        const now = Date.now();
        let cleaned = 0;
        for (const [key, entry] of this.windows) {
            if ((now - entry.windowStart) > 600_000) {
                this.windows.delete(key);
                cleaned++;
            }
        }
        if (cleaned > 0) {
            log.debug('Rate limiter cleanup', { cleaned, remaining: this.windows.size });
        }
    }

    public destroy(): void {
        clearInterval(this.cleanupInterval);
        this.windows.clear();
    }
}

const limiter = new SlidingWindowLimiter();

/**
 * Rate limiting middleware.
 * Uses client IP + route path as the window key.
 */
export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (req.path === '/health' || req.path === '/ready') {
        next();
        return;
    }

    const config = ROUTE_LIMITS[req.path] || ROUTE_LIMITS['__default__']!;
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${clientIp}:${req.path}`;

    const result = limiter.check(key, config);

    if (!result.allowed) {
        const retryAfterSec = Math.ceil(result.retryAfterMs / 1000);
        log.warn('Rate limit exceeded', { ip: clientIp, path: req.path, retry_after_sec: retryAfterSec });
        res.set('Retry-After', String(retryAfterSec));
        res.status(429).json({ error: 'Rate limit exceeded', retry_after_seconds: retryAfterSec });
        return;
    }

    next();
}

export { limiter };
