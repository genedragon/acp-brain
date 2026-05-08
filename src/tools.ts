import { z } from "zod";
import { query } from "./db.js";
import { generateEmbedding, toPgVector } from "./embeddings.js";

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
