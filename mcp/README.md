# proofofdev — MCP server

An [MCP](https://modelcontextprotocol.io) server that wraps the
[Proof of Dev](https://www.proofofdev.xyz) agent API, so Claude Code /
Claude clients get first-class tools instead of hand-built curl. It comes
in two transports with **identical tools** (one shared definition module,
`src/lib/mcpTools.ts` in the backend repo — the E2E suite diffs the two
tool lists so they cannot drift):

- **Remote (recommended):** hosted on the API itself — connect with just
  a URL, nothing to install. See "Remote install" below.
- **Stdio (local):** run it yourself from this package. See
  "Install (Claude Code)" below.

> **Live status:** the remote endpoint goes live when the Proof of Dev
> backend is redeployed — `https://api.proofofdev.xyz/mcp` does not
> resolve until then. The stdio server works today against any running
> backend (local or deployed) via `POD_API_URL`.

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

## Remote install (Claude Code)

```bash
claude mcp add --transport http proofofdev https://api.proofofdev.xyz/mcp
```

Or in `.mcp.json` / your Claude config:

```json
{
  "mcpServers": {
    "proofofdev": {
      "type": "http",
      "url": "https://api.proofofdev.xyz/mcp"
    }
  }
}
```

The remote server is **stateless** (Streamable HTTP, JSON responses, no
sessions) — it survives backend restarts and needs no sticky routing.
Prefer remote unless you're developing the backend itself; prefer stdio
for a local/unreleased API.

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
