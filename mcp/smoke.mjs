/**
 * Smoke test for the proofofdev MCP server: spawns it over stdio, runs
 * initialize → notifications/initialized → tools/list → one tools/call
 * (vesting_status), and prints the transcript.
 *
 * Usage: POD_API_URL=http://127.0.0.1:3210 node smoke.mjs [repo]
 * Expects the Proof of Dev API to be reachable at POD_API_URL.
 * TEST-ONLY tooling — not part of the server.
 */
import { spawn } from "child_process";
import { createInterface } from "readline";
import { fileURLToPath } from "url";
import path from "path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = process.argv[2] ?? "testowner/testrepo";
const apiUrl = process.env.POD_API_URL ?? "http://127.0.0.1:3210";

const child = spawn("npx", ["tsx", "src/server.ts"], {
  cwd: here,
  env: { ...process.env, POD_API_URL: apiUrl },
  stdio: ["pipe", "pipe", "inherit"],
});

const pending = new Map();
let nextId = 1;
const rl = createInterface({ input: child.stdout });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.log(`[stdout non-json] ${line}`);
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

function send(method, params) {
  const id = nextId++;
  const payload = { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
  console.log(`\n>>> ${method} ${JSON.stringify(params ?? {})}`);
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30_000);
    child.stdin.write(JSON.stringify(payload) + "\n");
  });
}

function notify(method) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
}

try {
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "proofofdev-smoke", version: "0.1.0" },
  });
  console.log(`<<< initialize -> server: ${JSON.stringify(init.result?.serverInfo)} protocol: ${init.result?.protocolVersion}`);

  notify("notifications/initialized");

  const list = await send("tools/list", {});
  const names = (list.result?.tools ?? []).map((t) => t.name);
  console.log(`<<< tools/list -> ${names.join(", ")}`);

  const call = await send("tools/call", {
    name: "vesting_status",
    arguments: { repo },
  });
  const text = (call.result?.content ?? []).map((c) => c.text).join("\n");
  console.log(`<<< tools/call vesting_status(${repo}) ->\n${text}`);

  const ok =
    init.result?.serverInfo?.name === "proofofdev" &&
    names.includes("vesting_status") &&
    names.includes("report_ship") &&
    text.includes('"ok": true') &&
    text.includes(repo);
  console.log(`\nSMOKE ${ok ? "PASS" : "FAIL"}`);
  child.kill();
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.error("SMOKE ERROR:", err);
  child.kill();
  process.exit(1);
}
