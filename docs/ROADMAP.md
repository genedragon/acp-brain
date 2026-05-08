# acp-brain Feature Roadmap

**Last updated:** 2026-05-08  
**Status:** Draft — pending Gene approval  
**License:** MIT (standalone MCP server for maximum adoption)

---

## Current State (v0.2.0)

What acp-brain has today:

| Component | Status |
|-----------|--------|
| PostgreSQL + pgvector backend | ✅ Deployed (wardcrew.org) |
| Amazon Nova embeddings (Bedrock) | ✅ |
| MCP server (stdio) | ✅ |
| `add_thought` / `search_thoughts` / `list_thoughts` / `update_thought` / `delete_thought` / `get_context_for` | ✅ |
| Single `thoughts` table with tags, source, confidence, metadata | ✅ |
| HNSW vector index | ✅ |
| 4 runtime dependencies (lean) | ✅ |

**Strengths vs OB1:** Leaner, MIT-licensed, no SaaS intermediary (Bedrock direct), smaller attack surface, self-hosted.

**Gaps vs OB1:** No provenance/audit trail, no review queue, no multi-table routing, no agent memory contract, no RLS, no dashboards.

---

## Phase 1: Safe Agent Memory Contract (Sprint 1 — ~1 week)

**Goal:** Formalize the distinction between evidence and instruction in memory writes. Prevent prompt injection via memory.

### 1.1 Schema Changes

```sql
-- Add provenance columns to thoughts table
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS write_source TEXT;        -- 'user' | 'agent' | 'system'
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS write_agent TEXT;         -- agent identifier (e.g. 'stam-weekly-2x2')
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS memory_class TEXT;        -- 'evidence' | 'instruction' | 'observation'
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS review_status TEXT DEFAULT 'auto_approved';  -- 'pending' | 'approved' | 'rejected' | 'auto_approved'
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS reviewed_by TEXT;

-- Index for filtering by review status
CREATE INDEX IF NOT EXISTS idx_thoughts_review_status ON thoughts(review_status);
CREATE INDEX IF NOT EXISTS idx_thoughts_memory_class ON thoughts(memory_class);
```

### 1.2 Memory Classification Rules

| Class | Description | Can agents write directly? | Example |
|-------|-------------|---------------------------|---------|
| `evidence` | What happened — raw facts, outcomes, meeting notes | ✅ Auto-approved | "Gene met with Bardia on May 5, discussed STAM hiring" |
| `observation` | Inferred patterns — system-detected, lower certainty | ✅ Auto-approved | "Gene tends to review 2x2 reports on Mondays" |
| `instruction` | Behavioral directives — preferences, rules, guardrails | 🚫 Requires review | "Always CC Joe Howard on STAM emails" |

### 1.3 New MCP Tools

- `add_thought` — add `write_source`, `write_agent`, `memory_class` params (backward-compatible defaults)
- `review_pending` — list thoughts awaiting human review
- `approve_thought(id)` / `reject_thought(id)` — human review actions

### 1.4 Recall/Writeback Contract

Formalize the pattern:
1. **Recall before work** — agent calls `search_thoughts` / `get_context_for` at task start
2. **Writeback after work** — agent calls `add_thought` with provenance at task end
3. **No raw transcripts** — only compact, labeled memory
4. **Instructions require review** — agents cannot self-grant behavioral rules

---

## Phase 2: Review Queue + Audit Trail (Sprint 2 — ~1 week)

**Goal:** Give Gene (or any platform admin) visibility into what agents write to memory, with approval/rejection workflow.

### 2.1 Review Queue Table

```sql
CREATE TABLE IF NOT EXISTS memory_audit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thought_id      UUID REFERENCES thoughts(id),
    action          TEXT NOT NULL,  -- 'created' | 'updated' | 'approved' | 'rejected' | 'deleted'
    actor           TEXT NOT NULL,  -- who did it (user alias or agent name)
    actor_type      TEXT NOT NULL,  -- 'user' | 'agent' | 'system'
    reason          TEXT,           -- why (especially for rejections)
    snapshot        JSONB,          -- thought content at time of action
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_thought ON memory_audit_log(thought_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON memory_audit_log(created_at DESC);
```

### 2.2 Policy Engine

```typescript
interface WritePolicy {
  requireReviewForInstructions: boolean;  // default: true
  requireReviewForAgentWrites: boolean;   // default: false (evidence OK)
  allowedAgents: string[];                // whitelist of trusted agents
  maxDailyWrites: number;                 // rate limit per agent
}
```

### 2.3 Integration with Agent Queue

Aligns with existing sub-agent guardrail:
- Sub-agents can't send external comms → PM dispatches
- Sub-agents can't write instructions to memory → Review queue dispatches

Same trust model, applied to memory.

---

## Phase 3: Multi-Agent Memory Isolation (Sprint 3 — ~1-2 weeks)

**Goal:** Support multiple agents with scoped memory access (Row Level Security equivalent without Supabase).

### 3.1 Workspace/Project Scoping

```sql
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS workspace_id TEXT DEFAULT 'default';
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS visibility TEXT DEFAULT 'private'; -- 'private' | 'shared' | 'public'

CREATE INDEX IF NOT EXISTS idx_thoughts_workspace ON thoughts(workspace_id);
```

### 3.2 Agent Access Policies

```typescript
interface AgentMemoryScope {
  agent_id: string;
  can_read: string[];      // workspace IDs this agent can read
  can_write: string[];     // workspace IDs this agent can write  
  memory_classes: string[]; // which classes it can write ('evidence', 'observation')
}
```

### 3.3 Token-Based Auth

Replace bare Postgres credentials with scoped access tokens:
- Each agent gets a token with embedded permissions
- MCP server validates token → applies scope filter to all queries
- Supports the acp-platform multi-tenant model

---

## Phase 4: Connectors & Recipes (Sprint 4+ — ongoing)

**Goal:** Grow the ecosystem with import/export capabilities (equivalent to OB1 `/recipes`).

### Priority Connectors

| Connector | Description | Effort |
|-----------|-------------|--------|
| OB1 bridge | Import/export between OB1 and acp-brain (for users who have both) | Medium |
| Slack capture | Auto-ingest bookmarked/reacted Slack messages | Medium |
| Calendar digest | Daily meeting summary → thoughts | Low |
| GitHub commit log | Repo activity → evidence memories | Low |
| Voice memo | Transcribe → extract → thoughts | Medium |

### Recipe Format (MIT-licensed, clean-room)

```
recipes/
├── slack-capture/
│   ├── README.md
│   ├── metadata.json
│   └── src/
├── calendar-digest/
└── github-activity/
```

---

## Phase 5: Dashboard & Observability (Future)

- Memory usage stats (thoughts/day, by agent, by class)
- Review queue UI (web dashboard or Zulip bot)
- Memory health: stale thoughts, contradictions, duplicates
- Embedding drift detection

---

## Architecture Principles (Learned from OB1 Evaluation)

1. **Memory lives outside the model** — any AI can read/write via MCP
2. **Evidence vs. instruction separation** — classify at write time
3. **Review before trust** — agent-written instructions require human approval
4. **Provenance on every write** — who wrote it, when, from what context
5. **Lean dependencies** — resist adding SaaS intermediaries
6. **MIT license** — maximize adoption, ecosystem > moat for this component
7. **Self-hostable** — no vendor lock-in, any Postgres works
8. **Recall before work, writeback after** — not continuous streaming

---

## Comparison: What We Take vs. What We Skip

| OB1 Feature | Adopt? | Rationale |
|-------------|--------|-----------|
| Safe Memory Contract | ✅ Clean-room | Core safety pattern |
| Review queue | ✅ Build our own | Aligns with existing agent guardrails |
| Provenance sidecars | ✅ Schema extension | Essential for trust |
| Recall/writeback pattern | ✅ Formalize in docs | Already doing implicitly |
| Supabase dependency | 🚫 Skip | We use direct Postgres |
| OpenRouter | 🚫 Skip | We use Bedrock directly |
| RLS via Supabase | 🟡 Adapt | Implement as application-layer scoping |
| Community recipes model | ✅ Adopt the format | Good DX pattern |
| Dashboards | ⏳ Later | Nice-to-have, not core |
| Extensions learning path | 🚫 Skip | Different product (tutorial vs. tool) |
| ClawHub/OpenClaw plugin | 🟡 Maybe | Could publish to MCP registry instead |

---

## Timeline Estimate

| Phase | Scope | Est. Effort | Priority |
|-------|-------|-------------|----------|
| Phase 1 | Safe Memory Contract | 3-5 days | 🔴 High — do first |
| Phase 2 | Review Queue + Audit | 3-5 days | 🔴 High |
| Phase 3 | Multi-Agent Isolation | 5-8 days | 🟡 Medium |
| Phase 4 | Connectors/Recipes | Ongoing | 🟡 Medium |
| Phase 5 | Dashboard | TBD | 🟢 Low |

**Next action:** Implement Phase 1 schema changes + update MCP tools.
