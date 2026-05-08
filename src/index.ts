#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { shutdown } from "./db.js";
import {
  AddThoughtSchema,
  SearchThoughtsSchema,
  ListThoughtsSchema,
  UpdateThoughtSchema,
  DeleteThoughtSchema,
  GetContextForSchema,
  ReviewPendingSchema,
  ApproveThoughtSchema,
  RejectThoughtSchema,
  AuditLogSchema,
  MemoryStatsSchema,
  GetWritePolicySchema,
  UpdateWritePolicySchema,
  PurgeRejectedSchema,
  addThought,
  searchThoughts,
  listThoughts,
  updateThought,
  deleteThought,
  getContextFor,
  reviewPending,
  approveThought,
  rejectThought,
  getAuditLog,
  getMemoryStats,
  getWritePolicy,
  updateWritePolicy,
  purgeRejected,
} from "./tools.js";

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "acp-brain",
  version: "0.3.0",
});

// ---------------------------------------------------------------------------
// Tool registration — uses registerTool() to avoid overload ambiguity
// when Zod shapes contain keys like "title" that overlap ToolAnnotations.
// ---------------------------------------------------------------------------

server.registerTool(
  "add_thought",
  {
    description:
      "Store a thought with auto-generated Nova embedding and provenance tracking. Classifies memory as evidence/observation/instruction. Instructions from agents require review before appearing in search.",
    inputSchema: AddThoughtSchema.shape,
  },
  async (args) => {
    try {
      const result = await addThought(AddThoughtSchema.parse(args));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "search_thoughts",
  {
    description:
      "Semantic vector search across approved thoughts. Supports type, tag, keyword, and memory_class filters. By default excludes pending/rejected thoughts.",
    inputSchema: SearchThoughtsSchema.shape,
  },
  async (args) => {
    try {
      const results = await searchThoughts(SearchThoughtsSchema.parse(args));
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "list_thoughts",
  {
    description: "Browse thoughts by type, tag, date range, memory class, and review status with pagination.",
    inputSchema: ListThoughtsSchema.shape,
  },
  async (args) => {
    try {
      const results = await listThoughts(ListThoughtsSchema.parse(args));
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "update_thought",
  {
    description:
      "Edit content or metadata of an existing thought by UUID. Re-generates embedding if content changes. Metadata is merged (not replaced).",
    inputSchema: UpdateThoughtSchema.shape,
  },
  async (args) => {
    try {
      const result = await updateThought(UpdateThoughtSchema.parse(args));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "delete_thought",
  {
    description: "Remove a thought by UUID. Captures a snapshot in the audit log before deletion.",
    inputSchema: DeleteThoughtSchema.shape,
  },
  async (args) => {
    try {
      const result = await deleteThought(DeleteThoughtSchema.parse(args));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "get_context_for",
  {
    description:
      "Aggregation query — everything the brain knows about a topic, person, or project. Combines semantic search + keyword matching, grouped by type. Only returns approved thoughts.",
    inputSchema: GetContextForSchema.shape,
  },
  async (args) => {
    try {
      const result = await getContextFor(GetContextForSchema.parse(args));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Review queue tools
// ---------------------------------------------------------------------------

server.registerTool(
  "review_pending",
  {
    description:
      "List thoughts pending human review. These are typically instructions written by agents that require approval before appearing in search results.",
    inputSchema: ReviewPendingSchema.shape,
  },
  async (args) => {
    try {
      const result = await reviewPending(ReviewPendingSchema.parse(args));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "approve_thought",
  {
    description:
      "Approve a pending thought so it appears in search results. Only thoughts with review_status='pending' can be approved.",
    inputSchema: ApproveThoughtSchema.shape,
  },
  async (args) => {
    try {
      const result = await approveThought(ApproveThoughtSchema.parse(args));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "reject_thought",
  {
    description:
      "Reject a pending thought. It will remain in the database (for audit) but never appear in search results. Requires a reason.",
    inputSchema: RejectThoughtSchema.shape,
  },
  async (args) => {
    try {
      const result = await rejectThought(RejectThoughtSchema.parse(args));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Phase 2: Audit, stats, policy, retention tools
// ---------------------------------------------------------------------------

server.registerTool(
  "audit_log",
  {
    description:
      "Query the memory audit trail. Filter by thought_id, action type, actor, and date range. Shows who wrote/approved/rejected/deleted what and when.",
    inputSchema: AuditLogSchema.shape,
  },
  async (args) => {
    try {
      const result = await getAuditLog(AuditLogSchema.parse(args));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "memory_stats",
  {
    description:
      "Get memory usage statistics: total thoughts, breakdown by class/source/status, top writing agents, and pending review count.",
    inputSchema: MemoryStatsSchema.shape,
  },
  async (args) => {
    try {
      const result = await getMemoryStats(MemoryStatsSchema.parse(args));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "get_write_policy",
  {
    description:
      "View the current write policy: which memory classes require review, trusted agents, and rate limits.",
    inputSchema: GetWritePolicySchema.shape,
  },
  async () => {
    try {
      const result = getWritePolicy();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "update_write_policy",
  {
    description:
      "Update the write policy at runtime. Changes persist until server restart (env vars are the durable config).",
    inputSchema: UpdateWritePolicySchema.shape,
  },
  async (args) => {
    try {
      const result = updateWritePolicy(UpdateWritePolicySchema.parse(args));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "purge_rejected",
  {
    description:
      "Purge rejected thoughts older than a cutoff date (default: 30 days). Use dry_run=true to preview what would be deleted.",
    inputSchema: PurgeRejectedSchema.shape,
  },
  async (args) => {
    try {
      const result = await purgeRejected(PurgeRejectedSchema.parse(args));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("acp-brain MCP server v0.3.0 running on stdio (Safe Agent Memory enabled)");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  shutdown().finally(() => process.exit(1));
});

// Graceful shutdown
process.on("SIGINT", () => {
  shutdown().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0));
});
