-- Migration 002: ContextZero Production Hardening
-- Date: 2026-03-13
-- Description: JSONB report columns, file backup table, semantic vectors,
--              IDF corpus, normalized AST hashes, performance indexes, auto-updated_at triggers.

BEGIN;

-- ============================================================
-- 1. Fix report columns: VARCHAR(255) -> JSONB with NULL defaults
-- ============================================================
ALTER TABLE change_transactions ALTER COLUMN impact_report_ref TYPE JSONB USING impact_report_ref::jsonb;
ALTER TABLE change_transactions ALTER COLUMN validation_report_ref TYPE JSONB USING validation_report_ref::jsonb;
ALTER TABLE change_transactions ALTER COLUMN propagation_report_ref TYPE JSONB USING propagation_report_ref::jsonb;
ALTER TABLE change_transactions ALTER COLUMN impact_report_ref SET DEFAULT NULL;
ALTER TABLE change_transactions ALTER COLUMN validation_report_ref SET DEFAULT NULL;
ALTER TABLE change_transactions ALTER COLUMN propagation_report_ref SET DEFAULT NULL;

-- ============================================================
-- 2. Add repository base_path column
-- ============================================================
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS base_path TEXT;

-- ============================================================
-- 3. Add transaction_file_backups table for persistent rollback
-- ============================================================
CREATE TABLE IF NOT EXISTS transaction_file_backups (
    backup_id UUID PRIMARY KEY,
    txn_id UUID NOT NULL REFERENCES change_transactions(txn_id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    original_content TEXT,  -- NULL means file didn't exist before
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_txn_file_backups_txn ON transaction_file_backups(txn_id);

-- ============================================================
-- 4. Add normalized_ast_hash to symbol_versions
-- ============================================================
ALTER TABLE symbol_versions ADD COLUMN IF NOT EXISTS normalized_ast_hash VARCHAR(64);

-- ============================================================
-- 5. Add semantic_vectors table for native TF-IDF embeddings
-- ============================================================
CREATE TABLE IF NOT EXISTS semantic_vectors (
    vector_id UUID PRIMARY KEY,
    symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    view_type VARCHAR(50) NOT NULL,  -- 'name', 'body', 'signature', 'behavior', 'contract'
    sparse_vector JSONB NOT NULL,  -- {token: tfidf_score, ...}
    minhash_signature INTEGER[] NOT NULL,  -- MinHash for LSH
    token_count INTEGER NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE(symbol_version_id, view_type)
);
CREATE INDEX IF NOT EXISTS idx_semantic_vectors_sv ON semantic_vectors(symbol_version_id);
CREATE INDEX IF NOT EXISTS idx_semantic_vectors_view ON semantic_vectors(view_type);

-- ============================================================
-- 6. Add idf_corpus table for inverse document frequency stats
-- ============================================================
CREATE TABLE IF NOT EXISTS idf_corpus (
    corpus_id UUID PRIMARY KEY,
    snapshot_id UUID NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    view_type VARCHAR(50) NOT NULL,
    document_count INTEGER NOT NULL,
    token_document_counts JSONB NOT NULL,  -- {token: doc_count, ...}
    computed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE(snapshot_id, view_type)
);

-- ============================================================
-- 7. Add missing performance indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_sv_body_hash ON symbol_versions(body_hash);
CREATE INDEX IF NOT EXISTS idx_sv_ast_hash ON symbol_versions(ast_hash);
CREATE INDEX IF NOT EXISTS idx_sv_normalized_ast_hash ON symbol_versions(normalized_ast_hash);
CREATE INDEX IF NOT EXISTS idx_bp_purity_class ON behavioral_profiles(purity_class);
CREATE INDEX IF NOT EXISTS idx_test_artifacts_related ON test_artifacts USING gin(related_symbols);

-- ============================================================
-- 8. Add updated_at auto-trigger
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_repositories_updated_at
    BEFORE UPDATE ON repositories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_change_transactions_updated_at
    BEFORE UPDATE ON change_transactions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;
