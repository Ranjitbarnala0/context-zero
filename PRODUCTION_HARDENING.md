# ContextZero — Production Hardening Specification

## Scope

This document specifies all security fixes, schema upgrades, engine additions, and performance improvements applied to ContextZero.

---

## 1. Critical Security Fixes

### 1.1 Eliminate User-Controlled Base Paths
**Problem:** `repo_base_path` accepted from API request body enables arbitrary file read/write.
**Fix:** Repository base paths must be registered at ingestion time and stored in the `repositories` table. All subsequent operations resolve paths ONLY from the DB-stored base path. The API never accepts filesystem paths from request bodies for read/write operations.

### 1.2 Depth Cap on Graph Traversal
**Problem:** Blast radius `depth` parameter is unbounded, enabling DoS.
**Fix:** Hard cap `depth` at 5. Validate all numeric inputs at the API layer.

### 1.3 Input Validation Layer
**Problem:** No validation on UUID formats, string lengths, numeric bounds.
**Fix:** New validation middleware that rejects malformed inputs before they reach engines.

### 1.4 Persistent Rollback State
**Problem:** File backups stored in process memory; lost on restart.
**Fix:** Store backups in a new `transaction_file_backups` table in Postgres.

---

## 2. Database Schema v2 (Migration 002)

### 2.1 Fix Report Columns
Change `impact_report_ref`, `validation_report_ref`, `propagation_report_ref` from `VARCHAR(255)` to `JSONB`.

### 2.2 Add Repository Base Path
Add `base_path TEXT` column to `repositories`.

### 2.3 Add Transaction File Backups Table
New table for persistent rollback support.

### 2.4 Add Missing Performance Indexes
- `symbol_versions.body_hash`
- `symbol_versions.ast_hash`
- `behavioral_profiles.purity_class`

### 2.5 Fix target_symbol_versions Type
Change from `TEXT[]` to `UUID[]` (application-level; Postgres stores both as arrays).

### 2.6 Add updated_at Trigger
Auto-update `updated_at` on repositories and change_transactions.

### 2.7 Add Semantic Vector Storage
Add `semantic_vectors` table for storing multi-view embedding vectors as float arrays natively (JSONB float arrays for portability, upgradeable to pgvector).

### 2.8 Add Normalized AST Hashes
Add `normalized_ast_hash` column to `symbol_versions` for whitespace/rename-invariant comparison.

---

## 3. Native Semantic Embedding Engine

### 3.1 Design Philosophy
No external API dependencies. No cloud embedding services. A native engine that understands code structure.

### 3.2 Multi-View Code Tokenizer
For each symbol, generate 5 token streams:
1. **Name tokens:** Split camelCase/snake_case, stem, lowercase
2. **Body tokens:** All identifiers, literals, operators from the AST body
3. **Signature tokens:** Parameter names, types, return type
4. **Behavior tokens:** Resource access patterns, side effect categories
5. **Contract tokens:** Input/output types, error types, decorator patterns

### 3.3 TF-IDF Sparse Vector Generation
- Compute term frequency per symbol, inverse document frequency across the snapshot
- Generate sparse vectors per view
- Store as JSONB for portability

### 3.4 MinHash + LSH for Candidate Generation
- Compute MinHash signatures (128 permutations) per symbol body
- Use Locality-Sensitive Hashing bands for O(1) candidate retrieval
- Replaces the missing ANN search the blueprint requires

### 3.5 Cosine Similarity for Precise Scoring
- Compute cosine similarity between TF-IDF vectors
- Multi-view weighted combination feeds directly into homolog Dimension 1

### 3.6 Normalized AST for Logic Similarity
- Normalize AST: strip comments, normalize whitespace, alpha-rename variables
- Hash the normalized form
- Compare normalized hashes for Dimension 2 (replaces binary exact-match)

---

## 4. Test Artifacts Population

### 4.1 Problem
The `test_artifacts` table is never populated. All code querying it returns empty.

### 4.2 Solution
During ingestion, identify test files (`.test.`, `.spec.`, `__tests__/`) and:
- Create test_artifact records
- Extract assertion patterns (expect, assert, should)
- Link to tested symbols via import/call analysis
- Populate `related_symbols` from call graph within test bodies

---

## 5. Incremental Indexing

### 5.1 Design
- Accept a list of changed file paths (from git diff)
- Only re-parse changed files
- Invalidate symbol versions, relations, profiles for changed symbols
- Re-compute behavioral and contract profiles for affected symbols
- Mark stale homolog relations for re-evaluation

### 5.2 Implementation
New method `ingestIncremental(repoId, snapshotId, changedPaths)` that:
1. Deletes old symbol_versions for changed files
2. Re-extracts symbols from changed files only
3. Re-computes relations touching changed symbols
4. Re-computes behavioral/contract profiles
5. Marks affected inferred_relations as stale

---

## 6. Caching Layer

### 6.1 Design
In-process LRU cache with TTL. No Redis dependency for v1 (can be added later).

### 6.2 Cached Items
- Symbol version lookups (TTL: 5 min)
- Behavioral profiles (TTL: 5 min)
- Contract profiles (TTL: 5 min)
- Compiled capsules by (symbolVersionId + mode) (TTL: 2 min)
- Homolog results (TTL: 2 min)

---

## 7. Code Quality Fixes

- Remove all unsafe `as` casts where possible; add runtime guards
- Fix dynamic import in ingestor hot path
- Fix `.sort()` in-place mutation in homolog engine
- Fix force-unwrap `!` in TS adapter signature extraction
- Deduplicate schema.sql / migration (schema.sql generated from migrations)
- Add pagination to all list endpoints
- Add missing `auth_policy_peer` and `error_mapping_peer` classification paths

---

## 8. Implementation Order

1. Database migration 002 (foundation)
2. Input validation middleware (security)
3. Security fixes across all files (base paths, depth caps)
4. Semantic embedding engine (core value)
5. AST normalization engine
6. Test artifacts population
7. Incremental indexing
8. Caching layer
9. Homolog engine upgrades (use new semantic engine)
10. API layer upgrades (pagination, validation)
11. Integration testing
