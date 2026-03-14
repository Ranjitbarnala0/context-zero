-- Migration 005: Add body_source to symbol_versions
--
-- Stores the actual source code body of each symbol version directly in the DB.
-- This transforms ContextZero from a metadata index into a self-contained
-- code knowledge base — enabling:
--   1. Symbol-scoped code serving without disk I/O
--   2. Accurate body-view TF-IDF embeddings (was using summaries)
--   3. Semantic code search against actual source
--   4. Rich context capsules with real code in all nodes
--   5. Docker/remote compatibility (no repo mount needed for queries)

ALTER TABLE symbol_versions ADD COLUMN IF NOT EXISTS body_source TEXT;
