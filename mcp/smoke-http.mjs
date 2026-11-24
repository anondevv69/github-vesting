/**
 * Smoke test for the REMOTE (Streamable HTTP) proofofdev MCP endpoint.
 *
 * Usage: MCP_URL=http://127.0.0.1:3210/mcp node smoke-http.mjs [repo]
 * Expects the Proof of Dev backend running with the seeded test grant.
 * Runs: initialize → notifications/initialized → tools/list →
 * tools/call vesting_status → unknown-tool error → malformed-body error.
 * Prints a transcript and exits non-zero on any failed check.
 * TEST-ONLY tooling — not part of the server.
 */

const url = process.env.MCP_URL ?? "http://127.0.0.1:3210/mcp";
const repo = process.argv[2] ?? "testowner/testrepo";
let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};

async function rpc(body, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    // JSON mode returns plain JSON; SSE mode wraps payloads in data: lines.
    const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
    json = JSON.parse(dataLine ? dataLine.slice(5) : text);
  } catch {
    /* leave null */
  }
  return { status: res.status, json, raw: text };
}

// 1. initialize
const init = await rpc({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-http", version: "0.0.1" },
  },
});
check("initialize", init.json?.result?.serverInfo?.name === "proofofdev",
  `server=${JSON.stringify(init.json?.result?.serverInfo)} protocol=${init.json?.result?.protocolVersion}`);

// 2. tools/list
const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
const names = (list.json?.result?.tools ?? []).map((t) => t.name).sort();
check("tools/list has 8 tools", names.length === 8, names.join(","));
console.log("TOOLS_JSON:" + JSON.stringify(names));

// 3. tools/call vesting_status
const call = await rpc({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "vesting_status", arguments: { repo } },
});
const callText = call.json?.result?.content?.[0]?.text ?? "";
check("tools/call vesting_status ok", callText.includes('"ok": true') || callText.includes('"ok":true'),
  callText.slice(0, 120).replace(/\n/g, " "));

// 4. unknown tool → clean error (JSON-RPC error or isError result, not a crash)
const bad = await rpc({
  jsonrpc: "2.0",
  id: 4,
  method: "tools/call",
  params: { name: "no_such_tool", arguments: {} },
});
check("unknown tool errors cleanly",
  Boolean(bad.json?.error) || bad.json?.result?.isError === true,
  `status=${bad.status}`);

// 5. malformed body → JSON-RPC error, not HTML
const malformed = await rpc("{not json");
check("malformed body → JSON-RPC error",
  Boolean(malformed.json?.error) && malformed.status < 500,
  `status=${malformed.status} code=${malformed.json?.error?.code}`);

console.log(failures === 0 ? "SMOKE-HTTP: ALL PASS" : `SMOKE-HTTP: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
