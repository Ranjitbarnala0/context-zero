/**
 * Programmatic migration runner.
 *
 * Reuses the same logic as db/migrate.ts but runs against the existing
 * connection pool so it can be called from server startup code.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { db } from './index';
import { Logger } from '../logger';

const log = new Logger('migrations');

/**
 * Run all pending SQL migrations from the db/migrations directory.
 * Returns the number of migrations applied. Throws on failure.
 */
export async function runPendingMigrations(): Promise<number> {
    // Locate migrations directory — works from both src/ (ts-node) and dist/ (compiled)
    const migrationsDir = path.resolve(__dirname, '../../db/migrations');

    if (!fs.existsSync(migrationsDir)) {
        log.warn('Migrations directory not found, skipping', { path: migrationsDir });
        return 0;
    }

    // Acquire advisory lock to prevent concurrent migration runs (e.g., multi-node Docker deployments).
    // Lock ID 73297 is arbitrary but fixed — all ContextZero processes use the same value.
    await db.query(`SELECT pg_advisory_lock(73297)`);

    try {

    // Ensure tracking table exists
    await db.query(`
        CREATE TABLE IF NOT EXISTS _migrations (
            id SERIAL PRIMARY KEY,
            filename VARCHAR(255) NOT NULL UNIQUE,
            applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            checksum VARCHAR(64) NOT NULL
        )
    `);

    // Get already-applied migrations
    const applied = await db.query(`SELECT filename FROM _migrations ORDER BY id`);
    const appliedSet = new Set(
        (applied.rows as { filename: string }[]).map(r => r.filename),
    );

    // Discover migration files
    const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort();

    let appliedCount = 0;
    for (const file of files) {
        if (appliedSet.has(file)) continue;

        const filePath = path.join(migrationsDir, file);
        const sql = fs.readFileSync(filePath, 'utf-8');
        const checksum = crypto.createHash('sha256').update(sql).digest('hex');

        log.info(`Applying migration: ${file}`);

        // Run each migration in its own transaction
        await db.query('BEGIN');
        try {
            await db.query(sql);
            await db.query(
                `INSERT INTO _migrations (filename, checksum) VALUES ($1, $2)`,
                [file, checksum],
            );
            await db.query('COMMIT');
            log.info(`Migration applied: ${file}`);
            appliedCount++;
        } catch (err) {
            await db.query('ROLLBACK');
            throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    if (appliedCount === 0) {
        log.info('All migrations already applied');
    } else {
        log.info(`${appliedCount} migration(s) applied successfully`);
    }

    return appliedCount;

    } finally {
        // Release advisory lock so other processes can migrate
        await db.query(`SELECT pg_advisory_unlock(73297)`);
    }
}
