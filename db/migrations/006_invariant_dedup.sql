-- Migration 006: Deduplicate invariants
--
-- The invariants table had no UNIQUE constraint on (repo_id, scope_symbol_id, expression),
-- so each re-ingestion created duplicate invariant rows. This caused blast radius
-- contract dimension to return duplicate impacts.

-- Step 1: Remove duplicates, keeping the one with the highest strength
DELETE FROM invariants a
USING invariants b
WHERE a.invariant_id > b.invariant_id
  AND a.repo_id = b.repo_id
  AND a.scope_symbol_id IS NOT DISTINCT FROM b.scope_symbol_id
  AND a.expression = b.expression;

-- Step 2: Add UNIQUE constraint to prevent future duplicates
CREATE UNIQUE INDEX IF NOT EXISTS idx_invariants_dedup
    ON invariants (repo_id, COALESCE(scope_symbol_id, '00000000-0000-0000-0000-000000000000'::uuid), expression);
