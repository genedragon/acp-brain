import { z } from "zod";
import { query } from "./db.js";
import { generateEmbedding, toPgVector } from "./embeddings.js";
import { generateText } from "./llm.js";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

interface ThoughtRow {
  id: string;
  content: string;
  type: string;
  title: string | null;
  tags: string[] | null;
  source_platform: string | null;
  source_owner: string | null;
  source_ref: string | null;
  confidence: number | null;
  metadata: Record<string, unknown>;
  write_source: string | null;
  write_agent: string | null;
  memory_class: string | null;
  review_status: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  created_at: string;
  updated_at: string;
  similarity?: number;
}

function formatThought(row: ThoughtRow): Record<string, unknown> {
  return {
    id: row.id,
    content: row.content,
    type: row.type,
    title: row.title,
    tags: row.tags ?? [],
    source_platform: row.source_platform,
    source_owner: row.source_owner,
    source_ref: row.source_ref,
    confidence: row.confidence,
    metadata: row.metadata,
    write_source: row.write_source,
    write_agent: row.write_agent,
    memory_class: row.memory_class,
    review_status: row.review_status,
    reviewed_at: row.reviewed_at,
    reviewed_by: row.reviewed_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.similarity !== undefined && { similarity: row.similarity }),
  };
}

// ---------------------------------------------------------------------------
// Write policy (configurable)
// ---------------------------------------------------------------------------

interface WritePolicy {
  requireReviewForInstructions: boolean;
  requireReviewForAgentWrites: boolean;
  trustedAgents: string[];
  maxDailyWritesPerAgent: number;
}

let WRITE_POLICY: WritePolicy = {
  requireReviewForInstructions: true,
  requireReviewForAgentWrites: false,
  trustedAgents: (process.env.ACP_BRAIN_TRUSTED_AGENTS ?? "").split(",").filter(Boolean),
  maxDailyWritesPerAgent: parseInt(process.env.ACP_BRAIN_MAX_DAILY_WRITES ?? "100", 10),
};

function determineReviewStatus(
  memoryClass: string,
  writeSource: string,
  writeAgent: string | undefined,
): string {
  // Instructions always require review unless from a trusted agent
  if (memoryClass === "instruction") {
    if (writeSource === "user") return "auto_approved";
    if (writeAgent && WRITE_POLICY.trustedAgents.includes(writeAgent)) return "auto_approved";
    if (WRITE_POLICY.requireReviewForInstructions) return "pending";
  }

  // Optionally require review for all agent writes
  if (writeSource === "agent" && WRITE_POLICY.requireReviewForAgentWrites) {
    if (writeAgent && WRITE_POLICY.trustedAgents.includes(writeAgent)) return "auto_approved";
    return "pending";
  }

  return "auto_approved";
}

// ---------------------------------------------------------------------------
// Audit log helper
// ---------------------------------------------------------------------------

async function auditLog(
  thoughtId: string,
  action: string,
  actor: string,
  actorType: string,
  reason?: string,
  snapshot?: Record<string, unknown>,
): Promise<void> {
  await query(
    `INSERT INTO memory_audit_log (thought_id, action, actor, actor_type, reason, snapshot)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [thoughtId, action, actor, actorType, reason ?? null, snapshot ? JSON.stringify(snapshot) : null],
  );
}

// ---------------------------------------------------------------------------
// Tool schemas (exported for MCP registration)
// ---------------------------------------------------------------------------

const DEFAULT_OWNER = process.env.ACP_BRAIN_DEFAULT_OWNER ?? "default";

export const AddThoughtSchema = z.object({
  content: z.string().describe("The thought content to store"),
  type: z
    .enum(["note", "task", "person", "project", "idea", "decision"])
    .default("note")
    .describe("Type of thought"),
  title: z.string().optional().describe("Optional short title"),
  tags: z.array(z.string()).optional().describe("Tags for categorization"),
  source_platform: z
    .string()
    .optional()
    .describe("Platform that created this thought (quickwork, kiro, openclaw, manual)"),
  source_owner: z.string().default(DEFAULT_OWNER).describe("User alias or identifier"),
  source_ref: z
    .string()
    .optional()
    .describe("Link to origin (Slack thread, Kiro session, etc.)"),
  metadata: z
    .record(z.unknown())
    .optional()
    .describe("Type-specific fields (due_date, owner, status, etc.)"),
  // --- Phase 1: Safe Agent Memory fields ---
  write_source: z
    .enum(["user", "agent", "system"])
    .default("user")
    .describe("Who is writing: 'user' (human), 'agent' (AI agent), 'system' (automated pipeline)"),
  write_agent: z
    .string()
    .optional()
    .describe("Agent identifier when write_source='agent' (e.g. 'stam-weekly-2x2', 'sync-my-2x2')"),
  memory_class: z
    .enum(["evidence", "observation", "instruction"])
    .default("evidence")
    .describe(
      "Classification: 'evidence' (facts/outcomes), 'observation' (inferred patterns), 'instruction' (behavioral rules/preferences — may require review)",
    ),
});

export const SearchThoughtsSchema = z.object({
  query: z.string().describe("Natural language search query"),
  type: z
    .enum(["note", "task", "person", "project", "idea", "decision"])
    .optional()
    .describe("Filter by thought type"),
  tags: z.array(z.string()).optional().describe("Filter by tags (AND match)"),
  keyword: z.string().optional().describe("Additional keyword filter on content"),
  memory_class: z
    .enum(["evidence", "observation", "instruction"])
    .optional()
    .describe("Filter by memory class"),
  include_pending: z
    .boolean()
    .default(false)
    .describe("Include thoughts pending review (default: only approved/auto_approved)"),
  limit: z.number().int().min(1).max(50).default(10).describe("Max results"),
});

export const ListThoughtsSchema = z.object({
  type: z
    .enum(["note", "task", "person", "project", "idea", "decision"])
    .optional()
    .describe("Filter by thought type"),
  tags: z.array(z.string()).optional().describe("Filter by tags (AND match)"),
  after: z.string().optional().describe("Return thoughts created after this ISO date"),
  before: z.string().optional().describe("Return thoughts created before this ISO date"),
  memory_class: z
    .enum(["evidence", "observation", "instruction"])
    .optional()
    .describe("Filter by memory class"),
  review_status: z
    .enum(["pending", "approved", "rejected", "auto_approved"])
    .optional()
    .describe("Filter by review status"),
  limit: z.number().int().min(1).max(100).default(20).describe("Max results"),
  offset: z.number().int().min(0).default(0).describe("Pagination offset"),
});

export const UpdateThoughtSchema = z.object({
  id: z.string().uuid().describe("UUID of the thought to update"),
  content: z.string().optional().describe("New content (triggers re-embedding)"),
  type: z
    .enum(["note", "task", "person", "project", "idea", "decision"])
    .optional()
    .describe("New type"),
  title: z.string().optional().describe("New title"),
  tags: z.array(z.string()).optional().describe("New tags (replaces existing)"),
  metadata: z
    .record(z.unknown())
    .optional()
    .describe("New metadata (merged with existing)"),
});

export const DeleteThoughtSchema = z.object({
  id: z.string().uuid().describe("UUID of the thought to delete"),
});

export const GetContextForSchema = z.object({
  topic: z
    .string()
    .describe("Topic, person, or project to get context for"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .describe("Max results per section"),
});

// --- Phase 1: Review queue schemas ---

export const ReviewPendingSchema = z.object({
  limit: z.number().int().min(1).max(50).default(20).describe("Max pending items to return"),
});

export const ApproveThoughtSchema = z.object({
  id: z.string().uuid().describe("UUID of the thought to approve"),
  reviewed_by: z.string().describe("Who is approving (user alias)"),
  reason: z.string().optional().describe("Optional approval note"),
});

export const RejectThoughtSchema = z.object({
  id: z.string().uuid().describe("UUID of the thought to reject"),
  reviewed_by: z.string().describe("Who is rejecting (user alias)"),
  reason: z.string().describe("Why this thought was rejected"),
});

// --- Phase 2: Audit & Stats schemas ---

export const AuditLogSchema = z.object({
  thought_id: z.string().uuid().optional().describe("Filter audit entries for a specific thought"),
  action: z
    .enum(["created", "updated", "approved", "rejected", "deleted"])
    .optional()
    .describe("Filter by action type"),
  actor: z.string().optional().describe("Filter by actor (user alias or agent name)"),
  after: z.string().optional().describe("Only entries after this ISO date"),
  before: z.string().optional().describe("Only entries before this ISO date"),
  limit: z.number().int().min(1).max(100).default(20).describe("Max results"),
  offset: z.number().int().min(0).default(0).describe("Pagination offset"),
});

export const MemoryStatsSchema = z.object({
  since: z.string().optional().describe("Stats since this ISO date (default: all time)"),
});

export const GetWritePolicySchema = z.object({});

export const UpdateWritePolicySchema = z.object({
  requireReviewForInstructions: z.boolean().optional().describe("Require review for instruction-class memories from agents"),
  requireReviewForAgentWrites: z.boolean().optional().describe("Require review for ALL agent writes (not just instructions)"),
  trustedAgents: z.array(z.string()).optional().describe("List of agent identifiers that bypass review"),
  maxDailyWritesPerAgent: z.number().int().min(1).optional().describe("Max writes per agent per day"),
});

export const PurgeRejectedSchema = z.object({
  before: z.string().optional().describe("Purge rejected thoughts older than this ISO date (default: 30 days ago)"),
  dry_run: z.boolean().default(true).describe("If true, only count what would be purged without deleting"),
});

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

export async function addThought(
  args: z.infer<typeof AddThoughtSchema>,
): Promise<Record<string, unknown>> {
  const embedding = await generateEmbedding(args.content, "GENERIC_INDEX");

  // Determine review status based on write policy
  const reviewStatus = determineReviewStatus(
    args.memory_class,
    args.write_source,
    args.write_agent,
  );

  // Vector-based near-duplicate check (warn, not block)
  const SIMILARITY_THRESHOLD = parseFloat(process.env.ACP_BRAIN_DEDUP_THRESHOLD ?? "0.92");
  const nearDupes = await query<{ id: string; title: string | null; similarity: number }>(
    `SELECT id, title, 1 - (embedding <=> $1) AS similarity
     FROM thoughts
     WHERE 1 - (embedding <=> $1) > $2
       AND review_status IN ('approved', 'auto_approved')
     ORDER BY embedding <=> $1
     LIMIT 3`,
    [toPgVector(embedding), SIMILARITY_THRESHOLD],
  );

  const result = await query<ThoughtRow>(
    `INSERT INTO thoughts (content, type, title, tags, source_platform, source_owner, source_ref, metadata, embedding, write_source, write_agent, memory_class, review_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      args.content,
      args.type,
      args.title ?? null,
      args.tags ?? null,
      args.source_platform ?? null,
      args.source_owner,
      args.source_ref ?? null,
      JSON.stringify(args.metadata ?? {}),
      toPgVector(embedding),
      args.write_source,
      args.write_agent ?? null,
      args.memory_class,
      reviewStatus,
    ],
  );

  const thought = result.rows[0];

  // Audit log
  await auditLog(
    thought.id,
    "created",
    args.write_agent ?? args.source_owner,
    args.write_source,
    reviewStatus === "pending" ? "Held for review (instruction from agent)" : undefined,
    formatThought(thought) as Record<string, unknown>,
  );

  return {
    ...formatThought(thought),
    _note: reviewStatus === "pending"
      ? "This thought is pending review. It will not appear in search results until approved."
      : undefined,
    _near_duplicates: nearDupes.rows.length > 0
      ? {
          warning: "This thought is semantically similar to existing thoughts. Consider reviewing for duplicates.",
          similar: nearDupes.rows.map((r) => ({
            id: r.id,
            title: r.title,
            similarity: Math.round(r.similarity * 1000) / 1000,
          })),
        }
      : undefined,
  };
}

export async function searchThoughts(
  args: z.infer<typeof SearchThoughtsSchema>,
): Promise<Record<string, unknown>[]> {
  const embedding = await generateEmbedding(args.query, "GENERIC_RETRIEVAL");

  const conditions: string[] = [];
  const params: unknown[] = [toPgVector(embedding)];
  let paramIdx = 2;

  // By default, exclude pending/rejected thoughts from search
  if (!args.include_pending) {
    conditions.push(`review_status IN ('approved', 'auto_approved')`);
  }

  if (args.type) {
    conditions.push(`type = $${paramIdx++}`);
    params.push(args.type);
  }
  if (args.tags && args.tags.length > 0) {
    conditions.push(`tags @> $${paramIdx++}`);
    params.push(args.tags);
  }
  if (args.keyword) {
    conditions.push(`content ILIKE $${paramIdx++}`);
    params.push(`%${args.keyword}%`);
  }
  if (args.memory_class) {
    conditions.push(`memory_class = $${paramIdx++}`);
    params.push(args.memory_class);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  params.push(args.limit);

  const sql = `
    SELECT *, 1 - (embedding <=> $1) AS similarity
    FROM thoughts
    ${whereClause}
    ORDER BY embedding <=> $1
    LIMIT $${paramIdx}
  `;

  const result = await query<ThoughtRow & { similarity: number }>(sql, params);
  return result.rows.map(formatThought);
}

export async function listThoughts(
  args: z.infer<typeof ListThoughtsSchema>,
): Promise<{ thoughts: Record<string, unknown>[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (args.type) {
    conditions.push(`type = $${paramIdx++}`);
    params.push(args.type);
  }
  if (args.tags && args.tags.length > 0) {
    conditions.push(`tags @> $${paramIdx++}`);
    params.push(args.tags);
  }
  if (args.after) {
    conditions.push(`created_at >= $${paramIdx++}`);
    params.push(args.after);
  }
  if (args.before) {
    conditions.push(`created_at <= $${paramIdx++}`);
    params.push(args.before);
  }
  if (args.memory_class) {
    conditions.push(`memory_class = $${paramIdx++}`);
    params.push(args.memory_class);
  }
  if (args.review_status) {
    conditions.push(`review_status = $${paramIdx++}`);
    params.push(args.review_status);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Count total
  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM thoughts ${whereClause}`,
    params,
  );
  const total = parseInt(countResult.rows[0].count, 10);

  // Fetch page
  const dataParams = [...params, args.limit, args.offset];
  const sql = `
    SELECT * FROM thoughts
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
  `;

  const result = await query<ThoughtRow>(sql, dataParams);
  return {
    thoughts: result.rows.map(formatThought),
    total,
  };
}

export async function updateThought(
  args: z.infer<typeof UpdateThoughtSchema>,
): Promise<Record<string, unknown>> {
  const setClauses: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (args.content !== undefined) {
    setClauses.push(`content = $${paramIdx++}`);
    params.push(args.content);

    // Re-embed when content changes
    const embedding = await generateEmbedding(args.content, "GENERIC_INDEX");
    setClauses.push(`embedding = $${paramIdx++}`);
    params.push(toPgVector(embedding));
  }
  if (args.type !== undefined) {
    setClauses.push(`type = $${paramIdx++}`);
    params.push(args.type);
  }
  if (args.title !== undefined) {
    setClauses.push(`title = $${paramIdx++}`);
    params.push(args.title);
  }
  if (args.tags !== undefined) {
    setClauses.push(`tags = $${paramIdx++}`);
    params.push(args.tags);
  }
  if (args.metadata !== undefined) {
    setClauses.push(`metadata = metadata || $${paramIdx++}`);
    params.push(JSON.stringify(args.metadata));
  }

  if (setClauses.length === 0) {
    throw new Error("No fields to update");
  }

  params.push(args.id);

  const sql = `
    UPDATE thoughts
    SET ${setClauses.join(", ")}
    WHERE id = $${paramIdx}
    RETURNING *
  `;

  const result = await query<ThoughtRow>(sql, params);
  if (result.rowCount === 0) {
    throw new Error(`Thought not found: ${args.id}`);
  }

  // Audit log
  await auditLog(args.id, "updated", DEFAULT_OWNER, "user");

  return formatThought(result.rows[0]);
}

export async function deleteThought(
  args: z.infer<typeof DeleteThoughtSchema>,
): Promise<{ deleted: boolean; id: string }> {
  // Capture snapshot before delete for audit
  const existing = await query<ThoughtRow>(
    "SELECT * FROM thoughts WHERE id = $1",
    [args.id],
  );
  if (existing.rowCount === 0) {
    throw new Error(`Thought not found: ${args.id}`);
  }

  await auditLog(
    args.id,
    "deleted",
    DEFAULT_OWNER,
    "user",
    undefined,
    formatThought(existing.rows[0]) as Record<string, unknown>,
  );

  const result = await query(
    "DELETE FROM thoughts WHERE id = $1 RETURNING id",
    [args.id],
  );
  return { deleted: true, id: args.id };
}

export async function getContextFor(
  args: z.infer<typeof GetContextForSchema>,
): Promise<Record<string, unknown>> {
  // 1. Semantic search for the topic (only approved thoughts)
  const embedding = await generateEmbedding(args.topic, "GENERIC_RETRIEVAL");

  const semanticResults = await query<ThoughtRow & { similarity: number }>(
    `SELECT *, 1 - (embedding <=> $1) AS similarity
     FROM thoughts
     WHERE review_status IN ('approved', 'auto_approved')
     ORDER BY embedding <=> $1
     LIMIT $2`,
    [toPgVector(embedding), args.limit],
  );

  // 2. Keyword search (catches exact name matches semantic might miss)
  const keywordResults = await query<ThoughtRow>(
    `SELECT * FROM thoughts
     WHERE (content ILIKE $1 OR title ILIKE $1)
       AND review_status IN ('approved', 'auto_approved')
     ORDER BY created_at DESC
     LIMIT $2`,
    [`%${args.topic}%`, args.limit],
  );

  // 3. Group by type
  const allIds = new Set<string>();
  const grouped: Record<string, Record<string, unknown>[]> = {};

  for (const row of [...semanticResults.rows, ...keywordResults.rows]) {
    if (allIds.has(row.id)) continue;
    allIds.add(row.id);

    const type = row.type || "note";
    if (!grouped[type]) grouped[type] = [];
    grouped[type].push(formatThought(row));
  }

  return {
    topic: args.topic,
    total_results: allIds.size,
    by_type: grouped,
  };
}

// ---------------------------------------------------------------------------
// Phase 1: Review queue tools
// ---------------------------------------------------------------------------

export async function reviewPending(
  args: z.infer<typeof ReviewPendingSchema>,
): Promise<{ pending: Record<string, unknown>[]; total: number }> {
  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM thoughts WHERE review_status = 'pending'`,
  );
  const total = parseInt(countResult.rows[0].count, 10);

  const result = await query<ThoughtRow>(
    `SELECT * FROM thoughts
     WHERE review_status = 'pending'
     ORDER BY created_at ASC
     LIMIT $1`,
    [args.limit],
  );

  return {
    pending: result.rows.map(formatThought),
    total,
  };
}

export async function approveThought(
  args: z.infer<typeof ApproveThoughtSchema>,
): Promise<Record<string, unknown>> {
  const result = await query<ThoughtRow>(
    `UPDATE thoughts
     SET review_status = 'approved', reviewed_at = NOW(), reviewed_by = $2
     WHERE id = $1 AND review_status = 'pending'
     RETURNING *`,
    [args.id, args.reviewed_by],
  );

  if (result.rowCount === 0) {
    throw new Error(`Thought not found or not pending: ${args.id}`);
  }

  await auditLog(args.id, "approved", args.reviewed_by, "user", args.reason);

  return formatThought(result.rows[0]);
}

export async function rejectThought(
  args: z.infer<typeof RejectThoughtSchema>,
): Promise<Record<string, unknown>> {
  const result = await query<ThoughtRow>(
    `UPDATE thoughts
     SET review_status = 'rejected', reviewed_at = NOW(), reviewed_by = $2
     WHERE id = $1 AND review_status = 'pending'
     RETURNING *`,
    [args.id, args.reviewed_by],
  );

  if (result.rowCount === 0) {
    throw new Error(`Thought not found or not pending: ${args.id}`);
  }

  await auditLog(
    args.id,
    "rejected",
    args.reviewed_by,
    "user",
    args.reason,
    formatThought(result.rows[0]) as Record<string, unknown>,
  );

  return formatThought(result.rows[0]);
}

// ---------------------------------------------------------------------------
// Phase 2: Audit log, stats, policy management, retention
// ---------------------------------------------------------------------------

interface AuditRow {
  id: string;
  thought_id: string | null;
  action: string;
  actor: string;
  actor_type: string;
  reason: string | null;
  snapshot: Record<string, unknown> | null;
  created_at: string;
}

export async function getAuditLog(
  args: z.infer<typeof AuditLogSchema>,
): Promise<{ entries: AuditRow[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (args.thought_id) {
    conditions.push(`thought_id = $${paramIdx++}`);
    params.push(args.thought_id);
  }
  if (args.action) {
    conditions.push(`action = $${paramIdx++}`);
    params.push(args.action);
  }
  if (args.actor) {
    conditions.push(`actor = $${paramIdx++}`);
    params.push(args.actor);
  }
  if (args.after) {
    conditions.push(`created_at >= $${paramIdx++}`);
    params.push(args.after);
  }
  if (args.before) {
    conditions.push(`created_at <= $${paramIdx++}`);
    params.push(args.before);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM memory_audit_log ${whereClause}`,
    params,
  );
  const total = parseInt(countResult.rows[0].count, 10);

  const dataParams = [...params, args.limit, args.offset];
  const sql = `
    SELECT * FROM memory_audit_log
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
  `;

  const result = await query<AuditRow>(sql, dataParams);
  return { entries: result.rows, total };
}

export async function getMemoryStats(
  args: z.infer<typeof MemoryStatsSchema>,
): Promise<Record<string, unknown>> {
  const sinceClause = args.since ? `WHERE created_at >= $1` : "";
  const sinceParams = args.since ? [args.since] : [];

  const totalResult = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM thoughts ${sinceClause}`,
    sinceParams,
  );

  const byClassResult = await query<{ memory_class: string; count: string }>(
    `SELECT COALESCE(memory_class, 'evidence') AS memory_class, COUNT(*) AS count
     FROM thoughts ${sinceClause}
     GROUP BY memory_class`,
    sinceParams,
  );

  const bySourceResult = await query<{ write_source: string; count: string }>(
    `SELECT COALESCE(write_source, 'user') AS write_source, COUNT(*) AS count
     FROM thoughts ${sinceClause}
     GROUP BY write_source`,
    sinceParams,
  );

  const byStatusResult = await query<{ review_status: string; count: string }>(
    `SELECT COALESCE(review_status, 'auto_approved') AS review_status, COUNT(*) AS count
     FROM thoughts ${sinceClause}
     GROUP BY review_status`,
    sinceParams,
  );

  const topAgentsResult = await query<{ write_agent: string; count: string }>(
    `SELECT write_agent, COUNT(*) AS count
     FROM thoughts
     WHERE write_agent IS NOT NULL ${args.since ? "AND created_at >= $1" : ""}
     GROUP BY write_agent
     ORDER BY count DESC
     LIMIT 10`,
    sinceParams,
  );

  const pendingCount = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM thoughts WHERE review_status = 'pending'`,
  );

  return {
    total_thoughts: parseInt(totalResult.rows[0].count, 10),
    pending_review: parseInt(pendingCount.rows[0].count, 10),
    by_memory_class: Object.fromEntries(byClassResult.rows.map((r) => [r.memory_class, parseInt(r.count, 10)])),
    by_write_source: Object.fromEntries(bySourceResult.rows.map((r) => [r.write_source, parseInt(r.count, 10)])),
    by_review_status: Object.fromEntries(byStatusResult.rows.map((r) => [r.review_status, parseInt(r.count, 10)])),
    top_agents: topAgentsResult.rows.map((r) => ({ agent: r.write_agent, count: parseInt(r.count, 10) })),
    since: args.since ?? "all_time",
  };
}

export function getWritePolicy(): WritePolicy {
  return { ...WRITE_POLICY };
}

export function updateWritePolicy(
  args: z.infer<typeof UpdateWritePolicySchema>,
): WritePolicy {
  if (args.requireReviewForInstructions !== undefined) {
    WRITE_POLICY.requireReviewForInstructions = args.requireReviewForInstructions;
  }
  if (args.requireReviewForAgentWrites !== undefined) {
    WRITE_POLICY.requireReviewForAgentWrites = args.requireReviewForAgentWrites;
  }
  if (args.trustedAgents !== undefined) {
    WRITE_POLICY.trustedAgents = args.trustedAgents;
  }
  if (args.maxDailyWritesPerAgent !== undefined) {
    WRITE_POLICY.maxDailyWritesPerAgent = args.maxDailyWritesPerAgent;
  }
  return { ...WRITE_POLICY };
}

export async function purgeRejected(
  args: z.infer<typeof PurgeRejectedSchema>,
): Promise<{ count: number; dry_run: boolean }> {
  const cutoff = args.before ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM thoughts WHERE review_status = 'rejected' AND created_at < $1`,
    [cutoff],
  );
  const count = parseInt(countResult.rows[0].count, 10);

  if (!args.dry_run && count > 0) {
    await query(
      `DELETE FROM thoughts WHERE review_status = 'rejected' AND created_at < $1`,
      [cutoff],
    );
  }

  return { count, dry_run: args.dry_run };
}

// ---------------------------------------------------------------------------
// Phase 3a: Fingerprint Dedup
// ---------------------------------------------------------------------------

export const FindDuplicatesSchema = z.object({
  threshold: z
    .number()
    .min(0)
    .max(1)
    .default(0.92)
    .describe("Cosine similarity threshold (0.92 = semantically very similar, 0.99 = near-identical)"),
  limit: z.number().int().min(1).max(100).default(20).describe("Max duplicate pairs to return"),
  dry_run: z.boolean().default(true).describe("If true, only report duplicates. If false, deletes the older thought in each pair."),
});

export async function findDuplicates(
  args: z.infer<typeof FindDuplicatesSchema>,
): Promise<{ duplicates: Record<string, unknown>[]; count: number; action: string }> {
  // Vector-based semantic dedup — find thought pairs above similarity threshold
  const vectorDupes = await query<{ id_a: string; id_b: string; title_a: string | null; title_b: string | null; created_a: string; created_b: string; similarity: number }>(
    `SELECT a.id AS id_a, b.id AS id_b, a.title AS title_a, b.title AS title_b,
            a.created_at AS created_a, b.created_at AS created_b,
            1 - (a.embedding <=> b.embedding) AS similarity
     FROM thoughts a, thoughts b
     WHERE a.id < b.id
       AND a.review_status IN ('approved', 'auto_approved')
       AND b.review_status IN ('approved', 'auto_approved')
       AND 1 - (a.embedding <=> b.embedding) > $1
     ORDER BY similarity DESC
     LIMIT $2`,
    [args.threshold, args.limit],
  );

  const duplicates = vectorDupes.rows.map((row) => ({
    id_a: row.id_a,
    id_b: row.id_b,
    title_a: row.title_a,
    title_b: row.title_b,
    similarity: Math.round(row.similarity * 1000) / 1000,
    older_id: row.created_a < row.created_b ? row.id_a : row.id_b,
  }));

  if (!args.dry_run && duplicates.length > 0) {
    let deleted = 0;
    for (const pair of duplicates) {
      const olderId = pair.older_id as string;
      await auditLog(olderId, "deleted", "system", "system", `Near-duplicate (similarity: ${pair.similarity}) — auto-merged`);
      await query("DELETE FROM thoughts WHERE id = $1", [olderId]);
      deleted++;
    }
    return { duplicates, count: deleted, action: "merged" };
  }

  return { duplicates, count: duplicates.length, action: "dry_run" };
}

// ---------------------------------------------------------------------------
// Phase 3b: Auto-Capture Protocol
// ---------------------------------------------------------------------------

export const AutoCaptureSchema = z.object({
  session_summary: z
    .string()
    .describe("1-2 sentence summary of what happened in this session"),
  action_items: z
    .array(
      z.object({
        title: z.string().describe("Action item title"),
        assignee: z.string().optional().describe("Who owns this action"),
        due_date: z.string().optional().describe("Due date (ISO format)"),
        importance: z.enum(["high", "medium", "low"]).default("medium"),
      }),
    )
    .optional()
    .describe("Action items extracted from the session"),
  decisions: z
    .array(z.string())
    .optional()
    .describe("Key decisions made during the session"),
  people_mentioned: z
    .array(
      z.object({
        name: z.string(),
        context: z.string().optional().describe("Why they were mentioned"),
      }),
    )
    .optional()
    .describe("People referenced in the session"),
  source_platform: z.string().default("openclaw").describe("Platform this capture came from"),
  write_agent: z.string().describe("Agent performing the capture (e.g. 'opusBot', 'botWard')"),
  source_ref: z.string().optional().describe("Link to the session/thread"),
});

export async function autoCapture(
  args: z.infer<typeof AutoCaptureSchema>,
): Promise<{ captured: string[]; count: number }> {
  const captured: string[] = [];

  // 1. Session summary → note
  const summaryResult = await addThought({
    content: args.session_summary,
    type: "note",
    title: `Session summary (${new Date().toISOString().slice(0, 10)})`,
    tags: ["session-summary", "auto-capture"],
    source_platform: args.source_platform,
    source_owner: DEFAULT_OWNER,
    source_ref: args.source_ref,
    write_source: "agent",
    write_agent: args.write_agent,
    memory_class: "evidence",
  });
  captured.push(`note: ${(summaryResult as any).id}`);

  // 2. Action items → tasks
  if (args.action_items && args.action_items.length > 0) {
    for (const item of args.action_items) {
      const result = await addThought({
        content: `Action item: ${item.title}${item.assignee ? ` (assignee: ${item.assignee})` : ""}`,
        type: "task",
        title: item.title,
        tags: ["action-item", "auto-capture"],
        source_platform: args.source_platform,
        source_owner: DEFAULT_OWNER,
        source_ref: args.source_ref,
        metadata: { assignee: item.assignee, due_date: item.due_date, importance: item.importance, completed: false },
        write_source: "agent",
        write_agent: args.write_agent,
        memory_class: "evidence",
      });
      captured.push(`task: ${(result as any).id}`);
    }
  }

  // 3. Decisions → decision type
  if (args.decisions && args.decisions.length > 0) {
    for (const decision of args.decisions) {
      const result = await addThought({
        content: decision,
        type: "decision",
        tags: ["auto-capture"],
        source_platform: args.source_platform,
        source_owner: DEFAULT_OWNER,
        source_ref: args.source_ref,
        write_source: "agent",
        write_agent: args.write_agent,
        memory_class: "evidence",
      });
      captured.push(`decision: ${(result as any).id}`);
    }
  }

  return { captured, count: captured.length };
}

// ---------------------------------------------------------------------------
// Recipe 1: Daily Digest
// ---------------------------------------------------------------------------

export const DailyDigestSchema = z.object({
  hours: z.number().default(24).describe("Look back N hours (default: 24)"),
  include_pending: z.boolean().default(true).describe("Include pending-review items in the digest"),
});

export async function dailyDigest(
  args: z.infer<typeof DailyDigestSchema>,
): Promise<Record<string, unknown>> {
  const cutoff = new Date(Date.now() - args.hours * 60 * 60 * 1000).toISOString();

  // Recent thoughts
  const recent = await query<ThoughtRow>(
    `SELECT * FROM thoughts
     WHERE created_at >= $1
     ORDER BY created_at DESC`,
    [cutoff],
  );

  // Pending review count
  const pendingResult = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM thoughts WHERE review_status = 'pending'`,
  );
  const pendingCount = parseInt(pendingResult.rows[0].count, 10);

  // Group by type
  const byType: Record<string, number> = {};
  const byAgent: Record<string, number> = {};
  for (const row of recent.rows) {
    byType[row.type] = (byType[row.type] ?? 0) + 1;
    if (row.write_agent) {
      byAgent[row.write_agent] = (byAgent[row.write_agent] ?? 0) + 1;
    }
  }

  // Generate a natural language summary via LLM
  const thoughtSummaries = recent.rows.slice(0, 20).map(
    (r) => `[${r.type}] ${r.title ?? r.content.slice(0, 80)}`,
  );

  const summary = recent.rows.length > 0
    ? await generateText(
        `Summarize these recent brain entries in 3-5 bullet points for a morning briefing. Be concise and actionable:\n\n${thoughtSummaries.join("\n")}`,
        { system: "You are a concise executive briefing assistant. Output only bullet points, no preamble.", maxTokens: 300 },
      )
    : "No new thoughts in the last " + args.hours + " hours.";

  return {
    period_hours: args.hours,
    total_new: recent.rows.length,
    pending_review: pendingCount,
    by_type: byType,
    by_agent: byAgent,
    summary,
    thoughts: recent.rows.slice(0, 10).map(formatThought),
  };
}

// ---------------------------------------------------------------------------
// Recipe 2: Schema-Aware Routing
// ---------------------------------------------------------------------------

export const SmartAddSchema = z.object({
  content: z.string().describe("Raw unstructured text — the brain will auto-classify type, extract title, tags, and metadata"),
  source_platform: z.string().optional().describe("Platform origin"),
  source_owner: z.string().default(DEFAULT_OWNER),
  source_ref: z.string().optional(),
  write_source: z.enum(["user", "agent", "system"]).default("user"),
  write_agent: z.string().optional(),
});

export async function smartAdd(
  args: z.infer<typeof SmartAddSchema>,
): Promise<Record<string, unknown>> {
  // Use LLM to classify the content
  const classification = await generateText(
    `Classify this text and extract structured metadata. Return ONLY valid JSON, no markdown fences.

Text: "${args.content}"

Return JSON with these fields:
- type: one of "note", "task", "person", "project", "idea", "decision"
- title: short title (max 60 chars)
- tags: array of 1-4 relevant tags (lowercase, hyphenated)
- memory_class: "evidence" (facts/outcomes), "observation" (patterns), or "instruction" (rules/preferences)
- metadata: object with type-specific fields (e.g. assignee, due_date, importance for tasks; org, role for persons)`,
    { system: "You are a knowledge classification engine. Output ONLY valid JSON. No explanation.", maxTokens: 300, temperature: 0.0 },
  );

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(classification.replace(/```json?\n?/g, "").replace(/```/g, "").trim());
  } catch {
    // Fallback if LLM doesn't return valid JSON
    parsed = { type: "note", title: args.content.slice(0, 60), tags: [], memory_class: "evidence", metadata: {} };
  }

  // Now add the thought with the classified metadata
  return addThought({
    content: args.content,
    type: (parsed.type as any) ?? "note",
    title: (parsed.title as string) ?? undefined,
    tags: (parsed.tags as string[]) ?? undefined,
    source_platform: args.source_platform,
    source_owner: args.source_owner,
    source_ref: args.source_ref,
    metadata: (parsed.metadata as Record<string, unknown>) ?? undefined,
    write_source: args.write_source,
    write_agent: args.write_agent,
    memory_class: (parsed.memory_class as any) ?? "evidence",
  });
}

// ---------------------------------------------------------------------------
// Recipe 3: Panning for Gold
// ---------------------------------------------------------------------------

export const PanForGoldSchema = z.object({
  content: z.string().describe("Raw brain dump, meeting transcript, or voice memo text to mine for insights"),
  source_platform: z.string().optional(),
  source_ref: z.string().optional(),
  write_agent: z.string().default("panning-for-gold"),
  dry_run: z.boolean().default(true).describe("If true, return extracted items without storing. If false, store all to brain."),
});

export async function panForGold(
  args: z.infer<typeof PanForGoldSchema>,
): Promise<Record<string, unknown>> {
  const extraction = await generateText(
    `Extract actionable knowledge from this brain dump. Return ONLY valid JSON (no markdown fences).

Text:
"""
${args.content}
"""

Return a JSON object with:
- summary: 1-2 sentence overview of the dump
- action_items: array of {title, assignee?, due_date?, importance: "high"|"medium"|"low"}
- decisions: array of strings (key decisions made or implied)
- people: array of {name, context} (people mentioned and why)
- ideas: array of strings (ideas worth capturing)
- key_facts: array of strings (factual statements worth remembering)`,
    { system: "You are a knowledge extraction engine. Extract ALL actionable items. Output ONLY valid JSON.", maxTokens: 2000, temperature: 0.1 },
  );

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(extraction.replace(/```json?\n?/g, "").replace(/```/g, "").trim());
  } catch {
    return { error: "Failed to parse LLM extraction", raw: extraction };
  }

  if (args.dry_run) {
    return { ...parsed, action: "dry_run", note: "Pass dry_run=false to store these to the brain." };
  }

  // Store everything via auto_capture
  const result = await autoCapture({
    session_summary: (parsed.summary as string) ?? "Brain dump extraction",
    action_items: (parsed.action_items as any[]) ?? [],
    decisions: (parsed.decisions as string[]) ?? [],
    people_mentioned: (parsed.people as any[]) ?? [],
    source_platform: args.source_platform ?? "manual",
    write_agent: args.write_agent,
    source_ref: args.source_ref,
  });

  // Also store ideas and key facts as notes
  const ideas = (parsed.ideas as string[]) ?? [];
  const facts = (parsed.key_facts as string[]) ?? [];
  for (const idea of ideas) {
    await addThought({
      content: idea,
      type: "idea",
      tags: ["panning-for-gold"],
      write_source: "agent",
      write_agent: args.write_agent,
      memory_class: "observation",
      source_platform: args.source_platform,
      source_owner: DEFAULT_OWNER,
    });
  }
  for (const fact of facts) {
    await addThought({
      content: fact,
      type: "note",
      tags: ["panning-for-gold", "key-fact"],
      write_source: "agent",
      write_agent: args.write_agent,
      memory_class: "evidence",
      source_platform: args.source_platform,
      source_owner: DEFAULT_OWNER,
    });
  }

  return { ...parsed, stored: result, ideas_stored: ideas.length, facts_stored: facts.length, action: "stored" };
}
