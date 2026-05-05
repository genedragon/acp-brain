# ACP Brain — Persistent AI Memory Layer

Curated knowledge store for ACP agents. PostgreSQL + pgvector + Amazon Nova Embeddings, served via MCP (Model Context Protocol).

## What It Is

ACP Brain is a **curated knowledge layer** for ACP. Unlike agent workspace files (daily logs, scratchpad notes), ACP Brain stores **intentional knowledge** — decisions, architecture, people, projects, ideas — that any agent on the instance can search semantically.

**It does NOT replace agent workspace files.** Agents continue using `MEMORY.md` and `memory/YYYY-MM-DD.md` for operational state. ACP Brain is the long-term, shared knowledge store.

## Architecture

```
┌──────────────────────────────────────────┐
│ ACP Instance                              │
│                                           │
│  OpenClaw agents ──► ACP Brain MCP Server │
│  (opusBot, botWard,     │                 │
│   sysAdmin, etc.)       ▼                 │
│                    PostgreSQL 16           │
│                    + pgvector (HNSW)       │
│                    + Amazon Nova embeddings│
│                    (via Bedrock)           │
└──────────────────────────────────────────┘
```

## Tools (6)

| Tool | Purpose |
|------|---------|
| `add_thought` | Store a thought with auto-generated embedding |
| `search_thoughts` | Semantic vector search with optional filters |
| `list_thoughts` | Browse by type, tag, and date range |
| `update_thought` | Edit content or metadata (re-embeds on content change) |
| `delete_thought` | Remove a thought by UUID |
| `get_context_for` | Aggregation — everything the brain knows about a topic |

## Thought Types

| Type | Use For |
|------|---------|
| `note` | General knowledge, observations |
| `task` | Action items, to-dos |
| `person` | People — contacts, roles, relationships |
| `project` | Projects — status, architecture, decisions |
| `idea` | Ideas for future work |
| `decision` | Architecture decisions, design choices |

## Prerequisites

- **PostgreSQL 16** with `pgvector` extension
- **Amazon Bedrock** access (Nova embeddings model)
- **Node.js 18+**
- **AWS credentials** (instance role or profile with Bedrock invoke access)

## Quick Start

```bash
# 1. Create the database
sudo -u postgres createdb openbrain
psql -d openbrain -f schema.sql

# 2. Install dependencies
npm install

# 3. Set environment
export DATABASE_URL="postgresql://localhost:5432/openbrain"
export AWS_REGION="us-west-2"
export ACP_BRAIN_DEFAULT_OWNER="your-username"

# 4. Start the MCP server
npm start
```

## Configuration

| Environment Variable | Default | Purpose |
|---------------------|---------|---------|
| `DATABASE_URL` | `postgresql://localhost:5432/openbrain` | PostgreSQL connection string |
| `AWS_REGION` | `us-east-1` | AWS region for Bedrock |
| `ACP_BRAIN_DEFAULT_OWNER` | `default` | Default `source_owner` for new thoughts |

## OpenClaw MCP Configuration

Add to your `openclaw.json` to give agents access:

```json
{
  "mcpServers": {
    "acp-brain": {
      "command": "tsx",
      "args": ["/path/to/acp-brain/src/index.ts"],
      "env": {
        "DATABASE_URL": "postgresql://localhost:5432/openbrain",
        "AWS_REGION": "us-west-2",
        "ACP_BRAIN_DEFAULT_OWNER": "your-username"
      }
    }
  }
}
```

## Schema

Single table: `thoughts`

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Auto-generated primary key |
| `content` | TEXT | The thought content |
| `type` | TEXT | note, task, person, project, idea, decision |
| `title` | TEXT | Optional short title |
| `tags` | TEXT[] | Tags for categorization |
| `source_platform` | TEXT | Origin platform (openclaw, quickwork, kiro, manual) |
| `source_owner` | TEXT | User alias |
| `source_ref` | TEXT | Link to origin (URL, thread ID, etc.) |
| `confidence` | DECIMAL | Optional confidence score (0.00–1.00) |
| `metadata` | JSONB | Extensible type-specific fields |
| `embedding` | VECTOR(1024) | Amazon Nova 1024-dim embedding |
| `created_at` | TIMESTAMPTZ | Auto-set on insert |
| `updated_at` | TIMESTAMPTZ | Auto-updated on modification |

## Curation Model

ACP Brain is a **curated** store — not a dump. The intended workflow:

1. **Agent proposes** a thought worth saving (based on conversation context)
2. **Human reviews** (or agent saves autonomously for high-confidence items)
3. **Thought is stored** with proper type, tags, and source attribution

This ensures the knowledge base stays high-signal. Operational noise stays in agent workspace files.

## License

BSL 1.1 (same as ACP platform)
