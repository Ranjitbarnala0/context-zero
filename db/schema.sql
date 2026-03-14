-- ContextZero Database Schema (PostgreSQL)
-- Defines the structural truth, behavioral profiles, contracts, and inferred relations.

-- Required extensions
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1. Repositories and Snapshots
CREATE TABLE repositories (
    repo_id UUID PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    default_branch VARCHAR(255) NOT NULL,
    visibility VARCHAR(50) NOT NULL,
    language_set TEXT[] NOT NULL,
    base_path TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE snapshots (
    snapshot_id UUID PRIMARY KEY,
    repo_id UUID NOT NULL REFERENCES repositories(repo_id) ON DELETE CASCADE,
    commit_sha VARCHAR(40) NOT NULL,
    branch VARCHAR(255) NOT NULL,
    parent_snapshot_id UUID REFERENCES snapshots(snapshot_id) ON DELETE SET NULL,
    indexed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    index_status VARCHAR(50) NOT NULL,
    UNIQUE (repo_id, commit_sha)
);

-- 2. Files and Scope
CREATE TABLE files (
    file_id UUID PRIMARY KEY,
    snapshot_id UUID NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    content_hash VARCHAR(64) NOT NULL,
    language VARCHAR(50) NOT NULL,
    parse_status VARCHAR(50) NOT NULL,
    UNIQUE (snapshot_id, path)
);

-- 3. Symbols
CREATE TABLE symbols (
    symbol_id UUID PRIMARY KEY,
    repo_id UUID NOT NULL REFERENCES repositories(repo_id) ON DELETE CASCADE,
    stable_key TEXT NOT NULL,
    canonical_name VARCHAR(255) NOT NULL,
    kind VARCHAR(50) NOT NULL,
    logical_namespace TEXT,
    UNIQUE (repo_id, stable_key)
);

CREATE TABLE symbol_versions (
    symbol_version_id UUID PRIMARY KEY,
    symbol_id UUID NOT NULL REFERENCES symbols(symbol_id) ON DELETE CASCADE,
    snapshot_id UUID NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    file_id UUID NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
    range_start_line INT NOT NULL,
    range_start_col INT NOT NULL,
    range_end_line INT NOT NULL,
    range_end_col INT NOT NULL,
    signature TEXT,
    ast_hash VARCHAR(64) NOT NULL,
    body_hash VARCHAR(64) NOT NULL,
    normalized_ast_hash VARCHAR(64),
    summary TEXT,
    visibility VARCHAR(50) NOT NULL,
    language VARCHAR(50) NOT NULL,
    uncertainty_flags TEXT[],
    UNIQUE (symbol_id, snapshot_id)
);

-- 4. Graphs and Relations
CREATE TABLE structural_relations (
    relation_id UUID PRIMARY KEY,
    src_symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    dst_symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    relation_type VARCHAR(50) NOT NULL,
    strength FLOAT NOT NULL DEFAULT 1.0,
    source VARCHAR(50) NOT NULL,
    confidence FLOAT NOT NULL,
    UNIQUE (src_symbol_version_id, dst_symbol_version_id, relation_type)
);

-- 5. Behavioral, Contract, and Semantic Profiles
CREATE TABLE behavioral_profiles (
    behavior_profile_id UUID PRIMARY KEY,
    symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    purity_class VARCHAR(50) NOT NULL,
    resource_touches TEXT[],
    db_reads TEXT[],
    db_writes TEXT[],
    network_calls TEXT[],
    cache_ops TEXT[],
    file_io TEXT[],
    auth_operations TEXT[],
    validation_operations TEXT[],
    exception_profile TEXT[],
    state_mutation_profile TEXT[],
    transaction_profile TEXT[],
    UNIQUE(symbol_version_id)
);

CREATE TABLE contract_profiles (
    contract_profile_id UUID PRIMARY KEY,
    symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    input_contract TEXT,
    output_contract TEXT,
    error_contract TEXT,
    schema_refs TEXT[],
    api_contract_refs TEXT[],
    serialization_contract TEXT,
    security_contract TEXT,
    derived_invariants_count INT NOT NULL DEFAULT 0,
    UNIQUE(symbol_version_id)
);

CREATE TABLE invariants (
    invariant_id UUID PRIMARY KEY,
    repo_id UUID NOT NULL REFERENCES repositories(repo_id) ON DELETE CASCADE,
    scope_symbol_id UUID REFERENCES symbols(symbol_id) ON DELETE CASCADE,
    scope_level VARCHAR(50) NOT NULL,
    expression TEXT NOT NULL,
    source_type VARCHAR(50) NOT NULL,
    strength FLOAT NOT NULL DEFAULT 1.0,
    validation_method VARCHAR(50) NOT NULL,
    last_verified_snapshot_id UUID REFERENCES snapshots(snapshot_id) ON DELETE SET NULL
);

-- 6. Homolog Inference and Evidence
CREATE TABLE evidence_bundles (
    evidence_bundle_id UUID PRIMARY KEY,
    semantic_score FLOAT NOT NULL,
    structural_score FLOAT NOT NULL,
    behavioral_score FLOAT NOT NULL,
    contract_score FLOAT NOT NULL,
    test_score FLOAT NOT NULL,
    history_score FLOAT NOT NULL,
    contradiction_flags TEXT[],
    feature_payload JSONB NOT NULL,
    generated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE inferred_relations (
    inferred_relation_id UUID PRIMARY KEY,
    src_symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    dst_symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    relation_type VARCHAR(50) NOT NULL,
    confidence FLOAT NOT NULL,
    review_state VARCHAR(50) NOT NULL,
    evidence_bundle_id UUID NOT NULL REFERENCES evidence_bundles(evidence_bundle_id) ON DELETE CASCADE,
    valid_from_snapshot_id UUID NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    valid_to_snapshot_id UUID REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    UNIQUE (src_symbol_version_id, dst_symbol_version_id, relation_type, valid_from_snapshot_id)
);

-- 7. Tests and Transactions
CREATE TABLE test_artifacts (
    test_artifact_id UUID PRIMARY KEY,
    symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    framework VARCHAR(50) NOT NULL,
    related_symbols TEXT[],
    assertion_summary TEXT,
    coverage_hints JSONB,
    UNIQUE(symbol_version_id)
);

CREATE TABLE change_transactions (
    txn_id UUID PRIMARY KEY,
    repo_id UUID NOT NULL REFERENCES repositories(repo_id) ON DELETE CASCADE,
    base_snapshot_id UUID NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    created_by VARCHAR(255) NOT NULL,
    state VARCHAR(50) NOT NULL,
    target_symbol_versions TEXT[],
    patches JSONB NOT NULL,
    impact_report_ref JSONB DEFAULT NULL,
    validation_report_ref JSONB DEFAULT NULL,
    propagation_report_ref JSONB DEFAULT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 8. Transaction File Backups (persistent rollback)
CREATE TABLE transaction_file_backups (
    backup_id UUID PRIMARY KEY,
    txn_id UUID NOT NULL REFERENCES change_transactions(txn_id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    original_content TEXT,  -- NULL means file didn't exist before
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 9. Semantic Vectors (native TF-IDF embeddings)
CREATE TABLE semantic_vectors (
    vector_id UUID PRIMARY KEY,
    symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    view_type VARCHAR(50) NOT NULL,  -- 'name', 'body', 'signature', 'behavior', 'contract'
    sparse_vector JSONB NOT NULL,  -- {token: tfidf_score, ...}
    minhash_signature BIGINT[] NOT NULL,  -- MinHash for LSH (values can exceed signed int32 range)
    token_count INTEGER NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE(symbol_version_id, view_type)
);

-- 10. IDF Corpus (inverse document frequency stats)
CREATE TABLE idf_corpus (
    corpus_id UUID PRIMARY KEY,
    snapshot_id UUID NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    view_type VARCHAR(50) NOT NULL,
    document_count INTEGER NOT NULL,
    token_document_counts JSONB NOT NULL,  -- {token: doc_count, ...}
    computed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE(snapshot_id, view_type)
);

-- 11. LSH Banding table for sub-linear semantic candidate retrieval
CREATE TABLE lsh_bands (
    symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    view_type TEXT NOT NULL,
    band_index SMALLINT NOT NULL,
    band_hash INTEGER NOT NULL,
    PRIMARY KEY (symbol_version_id, view_type, band_index)
);

CREATE INDEX idx_lsh_bands_lookup ON lsh_bands (view_type, band_index, band_hash);

-- 12. Migrations tracking table
CREATE TABLE IF NOT EXISTS _migrations (
    id SERIAL PRIMARY KEY,
    filename VARCHAR(255) NOT NULL UNIQUE,
    applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    checksum VARCHAR(64) NOT NULL DEFAULT ''
);

-- Performance indexes
CREATE INDEX idx_files_snapshot_id ON files(snapshot_id);
CREATE INDEX idx_symbol_versions_symbol_id ON symbol_versions(symbol_id);
CREATE INDEX idx_symbol_versions_snapshot_id ON symbol_versions(snapshot_id);
CREATE INDEX idx_structural_relations_src ON structural_relations(src_symbol_version_id);
CREATE INDEX idx_structural_relations_dst ON structural_relations(dst_symbol_version_id);
CREATE INDEX idx_inferred_relations_src ON inferred_relations(src_symbol_version_id);
CREATE INDEX idx_inferred_relations_dst ON inferred_relations(dst_symbol_version_id);

-- Query optimization indexes
CREATE INDEX idx_symbols_repo_canonical ON symbols(repo_id, canonical_name);
CREATE INDEX idx_symbols_canonical_name_trgm ON symbols USING gin (canonical_name gin_trgm_ops);
CREATE INDEX idx_invariants_scope_symbol ON invariants(scope_symbol_id);
CREATE INDEX idx_change_transactions_repo_state ON change_transactions(repo_id, state);
CREATE INDEX idx_symbol_versions_file_id ON symbol_versions(file_id);

-- Additional performance indexes
CREATE INDEX idx_txn_file_backups_txn ON transaction_file_backups(txn_id);
CREATE INDEX idx_semantic_vectors_sv ON semantic_vectors(symbol_version_id);
CREATE INDEX idx_semantic_vectors_view ON semantic_vectors(view_type);
CREATE INDEX idx_sv_body_hash ON symbol_versions(body_hash);
CREATE INDEX idx_sv_ast_hash ON symbol_versions(ast_hash);
CREATE INDEX idx_sv_normalized_ast_hash ON symbol_versions(normalized_ast_hash);
CREATE INDEX idx_bp_purity_class ON behavioral_profiles(purity_class);
CREATE INDEX idx_test_artifacts_related ON test_artifacts USING gin(related_symbols);

-- Auto-update triggers
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
