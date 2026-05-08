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
    -- Phase 1: Safe Agent Memory Contract
    write_source     TEXT DEFAULT 'user',       -- 'user' | 'agent' | 'system'
    write_agent      TEXT,                      -- agent identifier
    memory_class     TEXT DEFAULT 'evidence',   -- 'evidence' | 'observation' | 'instruction'
    review_status    TEXT DEFAULT 'auto_approved', -- 'pending' | 'approved' | 'rejected' | 'auto_approved'
    reviewed_at      TIMESTAMPTZ,
    reviewed_by      TEXT,
    -- Timestamps
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_thoughts_type ON thoughts(type);
CREATE INDEX IF NOT EXISTS idx_thoughts_tags ON thoughts USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_thoughts_source_platform ON thoughts(source_platform);
CREATE INDEX IF NOT EXISTS idx_thoughts_source_owner ON thoughts(source_owner);
CREATE INDEX IF NOT EXISTS idx_thoughts_created ON thoughts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_thoughts_review_status ON thoughts(review_status);
CREATE INDEX IF NOT EXISTS idx_thoughts_memory_class ON thoughts(memory_class);
CREATE INDEX IF NOT EXISTS idx_thoughts_write_source ON thoughts(write_source);
CREATE INDEX IF NOT EXISTS idx_thoughts_write_agent ON thoughts(write_agent);

-- HNSW index for vector similarity search (no training data needed)
CREATE INDEX IF NOT EXISTS idx_thoughts_embedding ON thoughts USING hnsw(embedding vector_cosine_ops);

-- Audit log for memory writes (provenance + review trail)
CREATE TABLE IF NOT EXISTS memory_audit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thought_id      UUID REFERENCES thoughts(id) ON DELETE SET NULL,
    action          TEXT NOT NULL,     -- 'created' | 'updated' | 'approved' | 'rejected' | 'deleted'
    actor           TEXT NOT NULL,     -- who did it (user alias or agent name)
    actor_type      TEXT NOT NULL,     -- 'user' | 'agent' | 'system'
    reason          TEXT,              -- why (especially for rejections)
    snapshot        JSONB,             -- thought content at time of action
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_thought ON memory_audit_log(thought_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON memory_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON memory_audit_log(action);

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
