-- Migration 004: LSH Banding table for sub-linear semantic candidate retrieval
-- Locality-Sensitive Hashing bands for MinHash signatures.
--
-- Each symbol_version's MinHash signature is split into bands of R consecutive
-- rows. Each band produces one hash. Two symbols sharing any (view_type, band_index, band_hash)
-- are LSH candidates, enabling O(matches) retrieval instead of O(N) full scan.

CREATE TABLE IF NOT EXISTS lsh_bands (
    symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    view_type TEXT NOT NULL,
    band_index SMALLINT NOT NULL,
    band_hash INTEGER NOT NULL,
    PRIMARY KEY (symbol_version_id, view_type, band_index)
);

CREATE INDEX idx_lsh_bands_lookup ON lsh_bands (view_type, band_index, band_hash);
