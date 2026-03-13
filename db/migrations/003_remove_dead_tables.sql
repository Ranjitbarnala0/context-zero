-- Migration 003: Remove dead tables
-- The semantic_profiles table was superseded by semantic_vectors (native TF-IDF embeddings).

DROP TABLE IF EXISTS semantic_profiles;
