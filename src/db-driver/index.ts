/**
 * ContextZero — Database Driver
 *
 * PostgreSQL connection pool with transaction support,
 * query timing, structured logging, and graceful shutdown.
 */

import { Pool, PoolClient, QueryResult } from 'pg';
import * as dotenv from 'dotenv';
import { Logger } from '../logger';

dotenv.config();

const log = new Logger('db-driver');

class DatabaseDriver {
    private static instance: DatabaseDriver;
    private pool: Pool;

    private constructor() {
        const maxConnections = parseInt(process.env['DB_MAX_CONNECTIONS'] || '20', 10);
        this.pool = new Pool({
            host: process.env['DB_HOST'] || 'localhost',
            port: parseInt(process.env['DB_PORT'] || '5432', 10),
            database: process.env['DB_NAME'] || 'scg_v2',
            user: process.env['DB_USER'] || 'postgres',
            password: process.env['DB_PASSWORD'] || 'postgres',
            max: maxConnections,
            idleTimeoutMillis: parseInt(process.env['DB_IDLE_TIMEOUT_MS'] || '30000', 10),
            connectionTimeoutMillis: parseInt(process.env['DB_CONNECTION_TIMEOUT_MS'] || '5000', 10),
        });

        this.pool.on('error', (err: Error) => {
            log.error('Unexpected error on idle database client', err);
        });

        this.pool.on('connect', () => {
            log.debug('New database client connected');
        });

        log.info('Database driver initialized', {
            host: process.env['DB_HOST'] || 'localhost',
            database: process.env['DB_NAME'] || 'scg_v2',
            max_connections: maxConnections,
        });
    }

    public static getInstance(): DatabaseDriver {
        if (!DatabaseDriver.instance) {
            DatabaseDriver.instance = new DatabaseDriver();
        }
        return DatabaseDriver.instance;
    }

    public async query(text: string, params?: unknown[]): Promise<QueryResult> {
        const slowQueryMs = parseInt(process.env['DB_SLOW_QUERY_MS'] || '500', 10);
        const start = Date.now();

        // Pool exhaustion warning
        if (this.pool.waitingCount > 0) {
            log.warn('Pool exhaustion: queries waiting for connections', {
                waitingCount: this.pool.waitingCount,
                totalCount: this.pool.totalCount,
                idleCount: this.pool.idleCount,
            });
        }

        try {
            const result = await this.pool.query(text, params);
            const duration = Date.now() - start;
            if (duration > slowQueryMs) {
                log.warn('Slow query detected', { query: text.substring(0, 200), duration_ms: duration, rows: result.rowCount });
            }
            return result;
        } catch (error) {
            const duration = Date.now() - start;
            log.error('Query execution failed', error, { query: text.substring(0, 200), duration_ms: duration });
            throw error;
        }
    }

    public async queryWithClient(client: PoolClient, text: string, params?: unknown[]): Promise<QueryResult> {
        const slowQueryMs = parseInt(process.env['DB_SLOW_QUERY_MS'] || '500', 10);
        const start = Date.now();
        try {
            const result = await client.query(text, params);
            const duration = Date.now() - start;
            if (duration > slowQueryMs) {
                log.warn('Slow query on client', { query: text.substring(0, 200), duration_ms: duration });
            }
            return result;
        } catch (error) {
            log.error('Client query failed', error, { query: text.substring(0, 200) });
            throw error;
        }
    }

    public async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        const start = Date.now();
        try {
            await client.query('BEGIN');
            const result = await callback(client);
            await client.query('COMMIT');
            log.debug('Transaction committed', { duration_ms: Date.now() - start });
            return result;
        } catch (e) {
            await client.query('ROLLBACK');
            log.error('Transaction rolled back', e, { duration_ms: Date.now() - start });
            throw e;
        } finally {
            client.release();
        }
    }

    public async batchInsert(statements: { text: string; params: unknown[] }[]): Promise<void> {
        await this.transaction(async (client) => {
            for (const stmt of statements) {
                await client.query(stmt.text, stmt.params);
            }
        });
    }

    public async healthCheck(): Promise<{ connected: boolean; latency_ms: number }> {
        const start = Date.now();
        try {
            await this.pool.query('SELECT 1');
            return { connected: true, latency_ms: Date.now() - start };
        } catch {
            return { connected: false, latency_ms: Date.now() - start };
        }
    }

    public getPoolStats(): { total: number; idle: number; waiting: number } {
        return {
            total: this.pool.totalCount,
            idle: this.pool.idleCount,
            waiting: this.pool.waitingCount,
        };
    }

    public async close(): Promise<void> {
        log.info('Closing database connection pool');
        await this.pool.end();
    }
}

export const db = DatabaseDriver.getInstance();
