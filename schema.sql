-- OpenBrain Schema
-- PostgreSQL 16 + pgvector
-- Run: psql -d openbrain -f schema.sql

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS thoughts (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content          TEXT NOT NULL,
    type             TEXT DEFAULT 'note',
    title            TEXT,
    tags             TEXT[],
    source_platform  TEXT,
    source_owner     TEXT,
    source_ref       TEXT,
    confidence       DECIMAL(3,2),
    metadata         JSONB DEFAULT '{}',
    embedding        VECTOR(1024),
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_thoughts_type ON thoughts(type);
CREATE INDEX IF NOT EXISTS idx_thoughts_tags ON thoughts USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_thoughts_source_platform ON thoughts(source_platform);
CREATE INDEX IF NOT EXISTS idx_thoughts_source_owner ON thoughts(source_owner);
CREATE INDEX IF NOT EXISTS idx_thoughts_created ON thoughts(created_at DESC);

-- HNSW index for vector similarity search (no training data needed)
CREATE INDEX IF NOT EXISTS idx_thoughts_embedding ON thoughts USING hnsw(embedding vector_cosine_ops);

-- Auto-update updated_at on row modification
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER thoughts_updated_at
    BEFORE UPDATE ON thoughts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();
