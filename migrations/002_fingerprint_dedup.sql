-- Migration 002: Content Fingerprint Dedup
-- Adds content fingerprinting for near-duplicate detection
-- Run: psql -d openbrain -f migrations/002_fingerprint_dedup.sql

-- ---------------------------------------------------------------------------
-- 1. Fingerprint column
-- ---------------------------------------------------------------------------

ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS content_fingerprint TEXT;

-- Unique-ish index (not UNIQUE constraint — allow intentional dupes with metadata)
CREATE INDEX IF NOT EXISTS idx_thoughts_fingerprint ON thoughts(content_fingerprint);

-- ---------------------------------------------------------------------------
-- 2. Backfill existing thoughts with fingerprints
-- Uses MD5 of normalized content (lowercase, trimmed, collapsed whitespace)
-- ---------------------------------------------------------------------------

UPDATE thoughts
SET content_fingerprint = md5(
  lower(
    regexp_replace(
      trim(content),
      '\s+', ' ', 'g'
    )
  )
)
WHERE content_fingerprint IS NULL;
