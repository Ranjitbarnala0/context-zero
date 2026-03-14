/**
 * ContextZero — LRU Cache with TTL
 *
 * In-process caching layer for hot-path database queries.
 * No external dependencies (no Redis). Simple, fast, correct.
 *
 * Features:
 * - LRU eviction when max size exceeded
 * - Per-entry TTL
 * - Typed get/set
 * - Cache statistics
 * - Manual invalidation by key or prefix
 */

import { Logger } from '../logger';

const log = new Logger('cache');

interface CacheEntry<T> {
    value: T;
    expiresAt: number;
    accessedAt: number;
}

export class LRUCache<T = unknown> {
    private store: Map<string, CacheEntry<T>> = new Map();
    private maxSize: number;
    private defaultTTLMs: number;
    private hits: number = 0;
    private misses: number = 0;
    private cleanupInterval: ReturnType<typeof setInterval>;

    constructor(maxSize: number = 1000, defaultTTLMs: number = 300_000) {
        this.maxSize = maxSize;
        this.defaultTTLMs = defaultTTLMs;
        this.cleanupInterval = setInterval(() => this.evictExpired(), 60_000);
        if (this.cleanupInterval.unref) this.cleanupInterval.unref();
    }

    public get(key: string): T | undefined {
        const entry = this.store.get(key);
        if (!entry) {
            this.misses++;
            return undefined;
        }
        if (Date.now() > entry.expiresAt) {
            this.store.delete(key);
            this.misses++;
            return undefined;
        }
        this.hits++;
        entry.accessedAt = Date.now();
        // Move to end (most recently used)
        this.store.delete(key);
        this.store.set(key, entry);
        return entry.value;
    }

    public set(key: string, value: T, ttlMs?: number): void {
        // Evict if at capacity
        if (this.store.size >= this.maxSize && !this.store.has(key)) {
            // Delete the least recently used (first entry in Map)
            const firstKey = this.store.keys().next().value;
            if (firstKey !== undefined) {
                this.store.delete(firstKey);
            }
        }
        this.store.set(key, {
            value,
            expiresAt: Date.now() + (ttlMs ?? this.defaultTTLMs),
            accessedAt: Date.now(),
        });
    }

    public invalidate(key: string): boolean {
        return this.store.delete(key);
    }

    public invalidateByPrefix(prefix: string): number {
        const toDelete: string[] = [];
        for (const key of this.store.keys()) {
            if (key.startsWith(prefix)) {
                toDelete.push(key);
            }
        }
        for (const key of toDelete) {
            this.store.delete(key);
        }
        return toDelete.length;
    }

    public clear(): void {
        this.store.clear();
    }

    public stats(): { size: number; hits: number; misses: number; hitRate: number } {
        const total = this.hits + this.misses;
        return {
            size: this.store.size,
            hits: this.hits,
            misses: this.misses,
            hitRate: total > 0 ? this.hits / total : 0,
        };
    }

    private evictExpired(): void {
        const now = Date.now();
        let evicted = 0;
        for (const [key, entry] of this.store) {
            if (now > entry.expiresAt) {
                this.store.delete(key);
                evicted++;
            }
        }
        if (evicted > 0) {
            log.debug('Cache cleanup', { evicted, remaining: this.store.size });
        }
    }

    public destroy(): void {
        clearInterval(this.cleanupInterval);
        this.store.clear();
    }
}

// Pre-configured caches for ContextZero subsystems
export const symbolCache = new LRUCache(2000, 300_000);      // 5 min TTL
export const profileCache = new LRUCache(2000, 300_000);      // 5 min TTL
export const capsuleCache = new LRUCache(500, 120_000);        // 2 min TTL
export const homologCache = new LRUCache(500, 120_000);        // 2 min TTL
export const queryCache = new LRUCache(5000, 60_000);          // 1 min TTL
