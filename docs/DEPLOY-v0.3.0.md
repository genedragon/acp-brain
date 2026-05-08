# acp-brain v0.3.0 Deployment Plan

## Summary
Upgrade from v0.2.0 → v0.3.0: Safe Agent Memory Contract + Review Queue + Audit Trail.

**Breaking changes:** None. Fully backward compatible. Existing 246 thoughts get safe defaults.

---

## Pre-Deployment Checklist

- [ ] Confirm Postgres access to wardcrew.org openbrain database
- [ ] Confirm current server process can be restarted (pm2/systemd/manual)
- [ ] Confirm AWS credentials (Bedrock) still valid on the server

---

## Step 1: Run Database Migration

```bash
# Connect to the wardcrew.org Postgres instance
psql -h localhost -d openbrain -U openbrain -f migrations/001_safe_agent_memory.sql
```

**Expected output:**
```
ALTER TABLE (x6)
CREATE INDEX (x4)
CREATE TABLE
CREATE INDEX (x3)
```

**Verify:**
```sql
-- Should return new columns
SELECT column_name FROM information_schema.columns 
WHERE table_name = 'thoughts' AND column_name IN ('write_source', 'write_agent', 'memory_class', 'review_status');

-- Should return 4 rows

-- Verify audit table exists
SELECT COUNT(*) FROM memory_audit_log;
-- Should return 0
```

---

## Step 2: Update Server Code

```bash
cd /path/to/acp-brain  # wherever it's deployed on wardcrew.org
git pull origin main
npm install  # in case any deps changed (they didn't, but safe practice)
```

---

## Step 3: Set Environment Variables (Optional)

```bash
# Add to .env or systemd service file:
export ACP_BRAIN_TRUSTED_AGENTS="quickwork,sync-my-2x2,stam-weekly-2x2,ingest-to-2x2"
export ACP_BRAIN_MAX_DAILY_WRITES=100
export ACP_BRAIN_DEFAULT_OWNER=genealpe
```

---

## Step 4: Restart the MCP Server

```bash
# If using pm2:
pm2 restart acp-brain

# If using systemd:
sudo systemctl restart acp-brain

# If manual:
pkill -f "tsx src/index.ts"
nohup npm run dev > /tmp/acp-brain.log 2>&1 &
```

**Verify startup:**
```bash
# Check logs for:
# "acp-brain MCP server v0.3.0 running on stdio (Safe Agent Memory enabled)"
tail -f /tmp/acp-brain.log
```

---

## Step 5: Smoke Test

```bash
# Test 1: Evidence write (should auto-approve)
# Via any connected MCP client:
add_thought(content="Deployment test: v0.3.0 Safe Agent Memory", write_source="user", memory_class="evidence", tags=["deployment-test"])

# Test 2: Agent instruction write (should go to pending)
add_thought(content="Test instruction: always format dates as YYYY-MM-DD", write_source="agent", write_agent="test-agent", memory_class="instruction")

# Test 3: Check pending queue
review_pending(limit=5)
# Should show the instruction from Test 2

# Test 4: Approve it
approve_thought(id="<uuid-from-test-2>", reviewed_by="genealpe")

# Test 5: Memory stats
memory_stats()
# Should show 247+ total, breakdown by class/source

# Test 6: Audit log
audit_log(limit=5)
# Should show the test entries
```

---

## Step 6: Update MCP Client Config (if needed)

If the MCP client (Quick, Kiro, etc.) caches tool schemas, restart it so it picks up the 8 new tools:
- `review_pending`, `approve_thought`, `reject_thought`
- `audit_log`, `memory_stats`, `get_write_policy`, `update_write_policy`, `purge_rejected`

---

## Rollback Plan

If something breaks:
```bash
# The migration is additive (ALTER TABLE ADD COLUMN IF NOT EXISTS)
# Rollback = just restart the old v0.2.0 code (ignores new columns)
git checkout v0.2.0  # or the previous commit
npm run dev
```

No data loss — new columns have defaults, old code simply doesn't read them.

---

## Post-Deployment

- [ ] Verify Quick's OpenBrain MCP connection still works
- [ ] Run `memory_stats()` to confirm 246+ thoughts accessible
- [ ] Test `search_thoughts` — results should exclude any `pending` thoughts by default
- [ ] Clean up test entries: `delete_thought(id=...)` for the deployment test thoughts
