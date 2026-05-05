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
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.similarity !== undefined && { similarity: row.similarity }),
  };
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
});

export const SearchThoughtsSchema = z.object({
  query: z.string().describe("Natural language search query"),
  type: z
    .enum(["note", "task", "person", "project", "idea", "decision"])
    .optional()
    .describe("Filter by thought type"),
  tags: z.array(z.string()).optional().describe("Filter by tags (AND match)"),
  keyword: z.string().optional().describe("Additional keyword filter on content"),
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

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

export async function addThought(
  args: z.infer<typeof AddThoughtSchema>,
): Promise<Record<string, unknown>> {
  const embedding = await generateEmbedding(args.content, "GENERIC_INDEX");

  const result = await query<ThoughtRow>(
    `INSERT INTO thoughts (content, type, title, tags, source_platform, source_owner, source_ref, metadata, embedding)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
    ],
  );

  return formatThought(result.rows[0]);
}

export async function searchThoughts(
  args: z.infer<typeof SearchThoughtsSchema>,
): Promise<Record<string, unknown>[]> {
  const embedding = await generateEmbedding(args.query, "GENERIC_RETRIEVAL");

  const conditions: string[] = [];
  const params: unknown[] = [toPgVector(embedding)];
  let paramIdx = 2;

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
  return formatThought(result.rows[0]);
}

export async function deleteThought(
  args: z.infer<typeof DeleteThoughtSchema>,
): Promise<{ deleted: boolean; id: string }> {
  const result = await query(
    "DELETE FROM thoughts WHERE id = $1 RETURNING id",
    [args.id],
  );
  if (result.rowCount === 0) {
    throw new Error(`Thought not found: ${args.id}`);
  }
  return { deleted: true, id: args.id };
}

export async function getContextFor(
  args: z.infer<typeof GetContextForSchema>,
): Promise<Record<string, unknown>> {
  // 1. Semantic search for the topic
  const embedding = await generateEmbedding(args.topic, "GENERIC_RETRIEVAL");

  const semanticResults = await query<ThoughtRow & { similarity: number }>(
    `SELECT *, 1 - (embedding <=> $1) AS similarity
     FROM thoughts
     ORDER BY embedding <=> $1
     LIMIT $2`,
    [toPgVector(embedding), args.limit],
  );

  // 2. Keyword search (catches exact name matches semantic might miss)
  const keywordResults = await query<ThoughtRow>(
    `SELECT * FROM thoughts
     WHERE content ILIKE $1 OR title ILIKE $1
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
