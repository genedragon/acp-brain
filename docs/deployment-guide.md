# ACP Brain — Deployment Guide

Deploy ACP Brain as a persistent HTTP service on an ACP instance.

## Architecture

```
ACP Instance (EC2)
├── OpenClaw Gateway (port 18789)
│   └── Connects to ACP Brain via http://127.0.0.1:18790/mcp (URL mode)
├── ACP Brain Service (port 18790, systemd)
│   ├── Local: http://127.0.0.1:18790/mcp (no auth)
│   ├── Local: http://127.0.0.1:18790/health
│   └── PostgreSQL 16 + pgvector → openbrain database
└── nginx (port 443)
    └── /brain/ → 127.0.0.1:18790 (bearer token required for external access)
```

**Key design:** ACP Brain runs as an independent systemd service — it survives gateway restarts.

## Prerequisites

- **PostgreSQL 16** (Zulip's PG instance works)
- **pgvector extension** (`apt install postgresql-16-pgvector` or build from source)
- **Node.js 18+** (already present for OpenClaw)
- **Amazon Bedrock access** (instance IAM role with InvokeModel permission for Nova embeddings)
- **OpenClaw 2026.4.14+** (earlier versions crash on MCP config)

## Phase 1: Install pgvector

```bash
# Check if already available
sudo -u postgres psql -c "SELECT * FROM pg_available_extensions WHERE name = 'vector';"

# Install (Ubuntu 24.04 ARM64)
sudo apt-get update && sudo apt-get install -y postgresql-16-pgvector

# If not in apt, build from source:
cd /tmp && git clone --branch v0.8.0 https://github.com/pgvector/pgvector.git
cd pgvector && make PG_CONFIG=/usr/lib/postgresql/16/bin/pg_config
sudo make install PG_CONFIG=/usr/lib/postgresql/16/bin/pg_config
```

## Phase 2: Create Database

```bash
sudo -u postgres createdb openbrain
sudo -u postgres psql -d openbrain -f /path/to/acp-brain/schema.sql

# Grant access to the service user
sudo -u postgres psql -c "CREATE ROLE ubuntu LOGIN CREATEDB;"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE openbrain TO ubuntu;"
sudo -u postgres psql -d openbrain -c "GRANT ALL ON ALL TABLES IN SCHEMA public TO ubuntu;"
sudo -u postgres psql -d openbrain -c "GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ubuntu;"
```

## Phase 3: Install ACP Brain

```bash
cd /home/ubuntu
git clone https://github.com/genedragon/acp-brain.git
cd acp-brain
npm install
```

## Phase 4: Configure as systemd Service

Create `/home/ubuntu/.config/systemd/user/acp-brain.service`:

```ini
[Unit]
Description=ACP Brain — Persistent AI Memory (MCP HTTP)
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/ubuntu/acp-brain
ExecStart=/usr/local/bin/npx tsx src/index.ts
Restart=always
RestartSec=10
Environment=DATABASE_URL=postgresql://ubuntu@localhost:5432/openbrain
Environment=AWS_REGION=us-west-2
Environment=AWS_PROFILE=default
Environment=ACP_BRAIN_DEFAULT_OWNER=gene
Environment=ACP_BRAIN_PORT=18790
StandardOutput=journal
StandardError=journal
SyslogIdentifier=acp-brain

[Install]
WantedBy=default.target
```

Start the service:
```bash
systemctl --user daemon-reload
systemctl --user enable acp-brain
systemctl --user start acp-brain
systemctl --user status acp-brain
```

Verify:
```bash
curl -s http://127.0.0.1:18790/health
# Expected: {"status":"ok","service":"acp-brain","version":"0.3.0","transport":"http"}
```

## Phase 5: Configure OpenClaw MCP Connection

⚠️ **CRITICAL: Use the CLI. Do NOT edit openclaw.json directly.**

The key `"mcpServers"` is INVALID in openclaw.json and will crash the gateway. Always use:

```bash
openclaw mcp set acp-brain '{"url":"http://127.0.0.1:18790/mcp"}'
```

Verify:
```bash
openclaw mcp list
openclaw mcp show acp-brain
```

Then restart the gateway:
```bash
systemctl --user restart openclaw-gateway
```

## Phase 6: Configure External Access (Optional)

To allow external MCP clients (Quick Desktop, Kiro, etc.) to connect:

Add to nginx (`/etc/nginx/zulip-include/acp-brain`):

```nginx
location /brain/ {
    # Bearer token authentication
    if ($http_authorization != "Bearer YOUR_SECRET_TOKEN") {
        return 401;
    }

    proxy_pass http://127.0.0.1:18790/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

External clients connect to: `https://your-domain/brain/mcp` with bearer token.

## Phase 7: Data Migration (if migrating from local)

On the source machine:
```bash
pg_dump -d openbrain -t thoughts --data-only --column-inserts > thoughts_export.sql
scp thoughts_export.sql ubuntu@your-instance:/tmp/
```

On the target instance:
```bash
sudo -u postgres psql -d openbrain -f /tmp/thoughts_export.sql
sudo -u postgres psql -d openbrain -c "REINDEX INDEX idx_thoughts_embedding;"
rm /tmp/thoughts_export.sql
```

## Verify

```bash
# Service health
curl -s http://127.0.0.1:18790/health

# Gateway MCP connection
journalctl --user -u openclaw-gateway --no-pager -n 20 | grep -i brain

# Test via agent (DM any bot on Zulip):
# "Use the acp-brain tool to search for 'deployment'"
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Gateway crashes on restart | `"mcpServers"` key in openclaw.json | Remove it. Use `openclaw mcp set` instead. |
| `createDedupeCache is not a function` | Old Zulip plugin (pre-PR #17) | Pull latest from genedragon/openclaw-zulip |
| Bedrock auth fails | Expired SSO in ~/.aws/config | Simplify to bare region+output. Let SDK use IMDS. |
| Service won't start | Port 18790 in use | Check `lsof -i :18790` |
| Thoughts not found after migration | HNSW index stale | `REINDEX INDEX idx_thoughts_embedding;` |

## Updates

```bash
cd /home/ubuntu/acp-brain
git pull
npm install
systemctl --user restart acp-brain
```
