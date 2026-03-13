/**
 * ContextZero — Database Migration Runner
 *
 * Applies versioned SQL migrations in order. Tracks applied migrations
 * in a `_migrations` table to ensure idempotency.
 *
 * Usage:
 *   npx ts-node db/migrate.ts          # Apply all pending migrations
 *   npx ts-node db/migrate.ts --status # Show migration status
 */

import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function main(): Promise<void> {
    const pool = new Pool({
        host: process.env['DB_HOST'] || 'localhost',
        port: parseInt(process.env['DB_PORT'] || '5432', 10),
        database: process.env['DB_NAME'] || 'scg_v2',
        user: process.env['DB_USER'] || 'postgres',
        password: process.env['DB_PASSWORD'] || 'postgres',
    });

    try {
        // Ensure migrations tracking table exists
        await pool.query(`
            CREATE TABLE IF NOT EXISTS _migrations (
                id SERIAL PRIMARY KEY,
                filename VARCHAR(255) NOT NULL UNIQUE,
                applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
                checksum VARCHAR(64) NOT NULL
            )
        `);

        // Get already-applied migrations
        const applied = await pool.query(`SELECT filename FROM _migrations ORDER BY id`);
        const appliedSet = new Set(applied.rows.map((r: { filename: string }) => r.filename));

        // Discover migration files
        const files = fs.readdirSync(MIGRATIONS_DIR)
            .filter(f => f.endsWith('.sql'))
            .sort();

        if (process.argv.includes('--status')) {
            console.log('\n  Migration Status\n  ================\n');
            for (const file of files) {
                const status = appliedSet.has(file) ? '\x1b[32m APPLIED \x1b[0m' : '\x1b[33m PENDING \x1b[0m';
                console.log(`  ${status}  ${file}`);
            }
            console.log(`\n  Total: ${files.length} migrations, ${appliedSet.size} applied\n`);
            return;
        }

        // Apply pending migrations
        let applied_count = 0;
        for (const file of files) {
            if (appliedSet.has(file)) {
                continue;
            }

            const filePath = path.join(MIGRATIONS_DIR, file);
            const sql = fs.readFileSync(filePath, 'utf-8');
            const crypto = await import('crypto');
            const checksum = crypto.createHash('sha256').update(sql).digest('hex');

            console.log(`  Applying: ${file}...`);

            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query(sql);
                await client.query(
                    `INSERT INTO _migrations (filename, checksum) VALUES ($1, $2)`,
                    [file, checksum]
                );
                await client.query('COMMIT');
                console.log(`  \x1b[32m✓\x1b[0m ${file} applied successfully`);
                applied_count++;
            } catch (err) {
                await client.query('ROLLBACK');
                console.error(`  \x1b[31m✗\x1b[0m ${file} FAILED:`, err);
                process.exit(1);
            } finally {
                client.release();
            }
        }

        if (applied_count === 0) {
            console.log('  All migrations already applied. Nothing to do.');
        } else {
            console.log(`\n  \x1b[32m${applied_count} migration(s) applied successfully.\x1b[0m\n`);
        }
    } finally {
        await pool.end();
    }
}

main().catch(err => {
    console.error('Migration runner failed:', err);
    process.exit(1);
});
