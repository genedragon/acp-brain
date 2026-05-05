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
  addThought,
  searchThoughts,
  listThoughts,
  updateThought,
  deleteThought,
  getContextFor,
} from "./tools.js";

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "acp-brain",
  version: "0.2.0",
});

// ---------------------------------------------------------------------------
// Tool registration — uses registerTool() to avoid overload ambiguity
// when Zod shapes contain keys like "title" that overlap ToolAnnotations.
// ---------------------------------------------------------------------------

server.registerTool(
  "add_thought",
  {
    description:
      "Store a thought with auto-generated Nova embedding. Accepts content plus optional type, title, tags, source, and metadata.",
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
      "Semantic vector search across all thoughts. Supports optional type, tag, and keyword filters. Returns ranked results with similarity scores.",
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
    description: "Browse thoughts by type, tag, and date range with pagination.",
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
    description: "Remove a thought by UUID.",
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
      "Aggregation query — everything the brain knows about a topic, person, or project. Combines semantic search + keyword matching, grouped by type.",
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
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("OpenBrain MCP server running on stdio");
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
