-- Migration 001: Safe Agent Memory Contract
-- Adds provenance tracking, memory classification, and review queue
-- Run: psql -d openbrain -f migrations/001_safe_agent_memory.sql

-- ---------------------------------------------------------------------------
-- 1. Provenance columns on thoughts
-- ---------------------------------------------------------------------------

ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS write_source TEXT DEFAULT 'user';
  -- 'user' | 'agent' | 'system'

ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS write_agent TEXT;
  -- Agent identifier (e.g. 'stam-weekly-2x2', 'sync-my-2x2', 'quickwork')

ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS memory_class TEXT DEFAULT 'evidence';
  -- 'evidence' = what happened (facts, outcomes)
  -- 'observation' = inferred patterns (lower certainty)
  -- 'instruction' = behavioral directives (preferences, rules, guardrails)

ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS review_status TEXT DEFAULT 'auto_approved';
  -- 'pending' | 'approved' | 'rejected' | 'auto_approved'

ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS reviewed_by TEXT;

-- ---------------------------------------------------------------------------
-- 2. Indexes for new columns
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_thoughts_review_status ON thoughts(review_status);
CREATE INDEX IF NOT EXISTS idx_thoughts_memory_class ON thoughts(memory_class);
CREATE INDEX IF NOT EXISTS idx_thoughts_write_source ON thoughts(write_source);
CREATE INDEX IF NOT EXISTS idx_thoughts_write_agent ON thoughts(write_agent);

-- ---------------------------------------------------------------------------
-- 3. Audit log table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS memory_audit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thought_id      UUID REFERENCES thoughts(id) ON DELETE SET NULL,
    action          TEXT NOT NULL,
      -- 'created' | 'updated' | 'approved' | 'rejected' | 'deleted'
    actor           TEXT NOT NULL,
      -- who did it (user alias or agent name)
    actor_type      TEXT NOT NULL,
      -- 'user' | 'agent' | 'system'
    reason          TEXT,
      -- why (especially for rejections)
    snapshot        JSONB,
      -- thought content at time of action (for audit trail)
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_thought ON memory_audit_log(thought_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON memory_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON memory_audit_log(action);

-- ---------------------------------------------------------------------------
-- 4. Review policy: auto-approve evidence/observation, hold instructions
-- ---------------------------------------------------------------------------
-- This is enforced at the application layer (tools.ts), not as a DB trigger,
-- because the policy may change and should be configurable without migrations.
