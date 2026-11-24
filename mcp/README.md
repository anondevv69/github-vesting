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
| `repo_recent_pushes` | Most recent counted (verified) pushes across all Proof of Dev grants |
| `prepare_lock` | Prepare (never sign) approve+lock transactions |
| `report_ship` | File a ship report — attestation signal only |
| `ship_report` | Read a ship report's state (reported/confirmed/paid/rejected/expired) |
| `link_status` | Wallets linked to a GitHub login, plus `pendingRewards` accrued while unlinked and their total |

Trust model, same as the API: reads are unauthenticated; `prepare_lock`
returns **unsigned** transactions and this server holds no keys and cannot
move funds; `report_ship` is a claim that never releases tokens —
settlement is always the GitHub webhook → verifier → oracle.

## How it works

```
MCP client (Claude Code / Claude app / another agent)
   │  JSON-RPC over one of two transports:
   │   • stdio — this package runs as a local child process of the client
   │   • HTTPS — POSTs to https://api.proofofdev.xyz/mcp
   │     (Streamable HTTP, stateless, JSON responses, no sessions)
   ▼
proofofdev MCP server  (tools defined once in src/lib/mcpTools.ts —
   │                    both transports register the identical 8 tools)
   │  each tool is a thin HTTP call to the agent API:
   │   vesting_status → GET  /api/agent/status        agent_briefing → GET /api/agent/briefing
   │   agent_grants   → GET  /api/agent/grants        repo_recent_pushes → GET /api/vesting/recent-pushes
   │   prepare_lock   → POST /api/agent/lock          report_ship → POST /api/agent/report-ship
   │   ship_report    → GET  /api/agent/ship-report   link_status → GET /api/dev/link-wallet/<login>
   ▼
Proof of Dev agent API  (POD_API_URL; the remote server calls it over
   loopback inside the backend, the stdio server calls the public URL)
```

The MCP layer is a **convenience façade only** — it holds no keys, signs
nothing, and is never part of settlement. Money moves on exactly one
path, with or without MCP involved: a push lands on GitHub → the GitHub
App webhook hits the backend → the verifier counts or rejects it → the
oracle calls `GitEscrow.release()` (vesting unlock) and/or
`ShipRewards.pay()` (per-merge reward) on-chain. `report_ship` files a
claim that the webhook later confirms or rejects; `prepare_lock` returns
unsigned transactions for a human or wallet tool to sign elsewhere.

### Troubleshooting

- **"Proof of Dev API unreachable at … The backend appears offline"** —
  the tool reached the MCP server but the agent API didn't answer. For
  the remote transport this means the backend is down (or not yet
  redeployed); for stdio, check `POD_API_URL` points at a running
  backend (local dev: `http://127.0.0.1:3210`).
- **Malformed request to `/mcp`** — the backend answers with a JSON-RPC
  parse error (`-32700`), not an HTML error page; an unknown tool name
  returns a clean JSON-RPC error. If you instead get HTML or a 404, the
  request hit something other than the MCP mount (wrong host/path, or a
  backend build from before the endpoint existed).
- **A tool returns an HTTP error body** — that's the agent API's own
  error, passed through verbatim (e.g. no grant for `vesting_status` on
  a repo that never locked — rewards may still exist for it; check
  `link_status` / `repo_recent_pushes`).

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
