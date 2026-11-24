# proofofdev — MCP server

A stdio [MCP](https://modelcontextprotocol.io) server that wraps the
[Proof of Dev](https://www.proofofdev.xyz) agent API, so Claude Code /
Claude clients get first-class tools instead of hand-built curl:

| Tool | What it does |
|---|---|
| `vesting_status` | Vesting progress for one repo (`owner/repo`) |
| `agent_briefing` | Summary of all locks for a wallet |
| `agent_grants` | Detailed grant list for a wallet |
| `repo_recent_pushes` | Latest counted pushes across all grants |
| `prepare_lock` | Prepare (never sign) approve+lock transactions |
| `report_ship` | File a ship report — attestation signal only |
| `ship_report` | Read a ship report's state (reported/confirmed/paid/rejected/expired) |
| `link_status` | Wallets linked to a GitHub login |

Trust model, same as the API: reads are unauthenticated; `prepare_lock`
returns **unsigned** transactions and this server holds no keys and cannot
move funds; `report_ship` is a claim that never releases tokens —
settlement is always the GitHub webhook → verifier → oracle.

## Install (Claude Code)

Self-contained package — its dependencies live in `mcp/node_modules` and
do not touch the vesting server's build. One-time setup:

```bash
cd mcp && npm install
```

Then register it (run from the repo root, adjusting the path to where this
repo lives on your machine):

```bash
claude mcp add proofofdev -- npx tsx "$PWD/mcp/src/server.ts"
```

Or by hand in `.mcp.json` (project) / your Claude config:

```json
{
  "mcpServers": {
    "proofofdev": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/github-vesting/mcp/src/server.ts"],
      "env": { "POD_API_URL": "https://api.proofofdev.xyz" }
    }
  }
}
```

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `POD_API_URL` | `https://api.proofofdev.xyz` | Agent API base URL. Point it at a local server (e.g. `http://127.0.0.1:3210`) for development/testing. |

## Run standalone

```bash
POD_API_URL=https://api.proofofdev.xyz npx tsx src/server.ts
```

(Stdio transport — it speaks MCP on stdin/stdout and logs to stderr, so
running it by hand looks silent. Drive it from an MCP client.)
