/**
 * TEST-ONLY minimal Redis (RESP2) server for local E2E tests.
 *
 * Why this exists: the sandbox has no redis-server binary and no docker.
 * The vesting server talks to Redis only through ioredis with a small
 * command set (GET/SET/DEL/SADD/SREM/SMEMBERS/SISMEMBER/INCR/EXPIRE/
 * RPUSH/LRANGE/LTRIM + INFO ready-check). This file implements exactly
 * that subset over the real Redis wire protocol, in-memory, so the
 * production code under test is completely unmodified.
 *
 * NOT for production. Data vanishes when the process exits.
 */
"use strict";
const net = require("net");

const store = new Map(); // key -> {type:'string'|'set'|'list', value}

function getEntry(key, type) {
  let e = store.get(key);
  if (!e) {
    e = {
      type,
      value:
        type === "set" ? new Set()
        : type === "list" ? []
        : type === "hash" ? new Map()
        : "",
    };
    store.set(key, e);
  }
  return e;
}

function bulk(s) {
  if (s === null || s === undefined) return "$-1\r\n";
  const b = Buffer.from(String(s));
  return `$${b.length}\r\n${b.toString()}\r\n`;
}
function int(n) { return `:${n}\r\n`; }
function ok() { return "+OK\r\n"; }
function err(msg) { return `-ERR ${msg}\r\n`; }
function arr(items) { return `*${items.length}\r\n` + items.join(""); }

function execCommand(args) {
  const cmd = (args[0] || "").toUpperCase();
  const a = args.slice(1);
  switch (cmd) {
    case "PING": return a.length ? bulk(a[0]) : "+PONG\r\n";
    case "INFO": return bulk("# Server\r\nredis_version:7.2.0\r\nloading:0\r\n");
    case "AUTH": case "SELECT": case "CLIENT": case "HELLO": case "COMMAND": case "RESET":
      return ok();
    case "QUIT": return ok();
    case "FLUSHALL": case "FLUSHDB": store.clear(); return ok();
    case "GET": {
      // Fault injection (round-3): while the control key is present,
      // GETs of prepared-launch records fail with a Redis error so
      // the launch-gate suite can prove the backend fails CLOSED on
      // a prepared-record lookup error (never treats it as "no
      // record"). Toggled via tests/e2e/fault-toggle.ts.
      if (
        store.has("__fault_prepared_launch_get") &&
        typeof a[0] === "string" &&
        a[0].includes("prepared_launch")
      ) {
        return err("injected prepared-launch lookup fault");
      }
      const e = store.get(a[0]);
      return e && e.type === "string" ? bulk(e.value) : bulk(null);
    }
    case "SET": {
      // SET key value [EX s|PX ms] [NX|XX] [KEEPTTL] [GET]
      const opts = a.slice(2).map((x) => String(x).toUpperCase());
      const exists = store.has(a[0]);
      if (opts.includes("NX") && exists) return bulk(null);
      if (opts.includes("XX") && !exists) return bulk(null);
      store.set(a[0], { type: "string", value: a[1] });
      return ok();
    }
    case "DEL": {
      let n = 0;
      for (const k of a) if (store.delete(k)) n++;
      return int(n);
    }
    case "EXISTS": return int(store.has(a[0]) ? 1 : 0);
    case "TYPE": {
      const e = store.get(a[0]);
      return `+${e ? e.type : "none"}\r\n`;
    }
    case "EXPIRE": case "PEXPIRE": return int(store.has(a[0]) ? 1 : 0);
    case "TTL": case "PTTL": return int(store.has(a[0]) ? -1 : -2);
    case "INCR": case "INCRBY": {
      const e = getEntry(a[0], "string");
      const cur = parseInt(e.value || "0", 10);
      const by = cmd === "INCRBY" ? parseInt(a[1] || "1", 10) : 1;
      e.value = String(cur + by);
      return int(cur + by);
    }
    case "SADD": {
      const e = getEntry(a[0], "set");
      let n = 0;
      for (const m of a.slice(1)) if (!e.value.has(m)) { e.value.add(m); n++; }
      return int(n);
    }
    case "SREM": {
      const e = store.get(a[0]);
      if (!e || e.type !== "set") return int(0);
      let n = 0;
      for (const m of a.slice(1)) if (e.value.delete(m)) n++;
      return int(n);
    }
    case "SMEMBERS": {
      const e = store.get(a[0]);
      if (!e || e.type !== "set") return arr([]);
      return arr([...e.value].map(bulk));
    }
    case "SISMEMBER": {
      const e = store.get(a[0]);
      return int(e && e.type === "set" && e.value.has(a[1]) ? 1 : 0);
    }
    case "RPUSH": case "LPUSH": {
      const e = getEntry(a[0], "list");
      for (const v of a.slice(1)) {
        if (cmd === "RPUSH") e.value.push(v); else e.value.unshift(v);
      }
      return int(e.value.length);
    }
    case "LRANGE": {
      const e = store.get(a[0]);
      if (!e || e.type !== "list") return arr([]);
      let start = parseInt(a[1], 10), stop = parseInt(a[2], 10);
      const len = e.value.length;
      if (start < 0) start = Math.max(0, len + start);
      if (stop < 0) stop = len + stop;
      stop = Math.min(stop, len - 1);
      if (start > stop || start >= len) return arr([]);
      return arr(e.value.slice(start, stop + 1).map(bulk));
    }
    case "LTRIM": {
      const e = store.get(a[0]);
      if (!e || e.type !== "list") return ok();
      let start = parseInt(a[1], 10), stop = parseInt(a[2], 10);
      const len = e.value.length;
      if (start < 0) start = Math.max(0, len + start);
      if (stop < 0) stop = len + stop;
      stop = Math.min(stop, len - 1);
      e.value = start > stop ? [] : e.value.slice(start, stop + 1);
      return ok();
    }
    case "HSET": {
      const e = getEntry(a[0], "hash");
      let n = 0;
      for (let i = 1; i + 1 < a.length; i += 2) {
        if (!e.value.has(a[i])) n++;
        e.value.set(a[i], a[i + 1]);
      }
      return int(n);
    }
    case "HGET": {
      const e = store.get(a[0]);
      if (!e || e.type !== "hash") return bulk(null);
      return bulk(e.value.has(a[1]) ? e.value.get(a[1]) : null);
    }
    case "HDEL": {
      const e = store.get(a[0]);
      if (!e || e.type !== "hash") return int(0);
      let n = 0;
      for (const f of a.slice(1)) if (e.value.delete(f)) n++;
      return int(n);
    }
    case "HGETALL": {
      const e = store.get(a[0]);
      if (!e || e.type !== "hash") return arr([]);
      const items = [];
      for (const [k, v] of e.value) items.push(bulk(k), bulk(v));
      return arr(items);
    }
    case "EVAL": {
      // TEST-ONLY: implements the one production Lua script — the
      // atomic claimPush in src/github/pushVerifier.ts — with the same
      // semantics (single command execution here is atomic, exactly
      // like a Lua script on real Redis), INCLUDING the round-2
      // in-script daily-cap (-2) and cooldown (-3) checks for
      // different SHAs. Any other script is an error so a new
      // production script can't silently pass tests.
      const script = a[0] || "";
      if (!script.includes("claimPush")) return err("fake-redis: unsupported EVAL script");
      const numKeys = parseInt(a[1] || "0", 10);
      const keys = a.slice(2, 2 + numKeys);
      const argv = a.slice(2 + numKeys);
      const [seenKey, dailyKey, logKey, countKey] = keys;
      const [sha, logEntry, maxDaily, enforceCap, cooldownMs, enforceCooldown, lines, nowMs] = argv;
      const seen = getEntry(seenKey, "set");
      if (seen.value.has(sha)) return int(-1);
      const daily = getEntry(dailyKey, "string");
      const dailyVal = parseInt(daily.value || "0", 10);
      if (enforceCap === "1" && dailyVal >= parseInt(maxDaily || "0", 10)) return int(-2);
      if (enforceCooldown === "1" && parseInt(lines || "0", 10) < 50) {
        const logE = store.get(logKey);
        const list = logE && logE.type === "list" ? logE.value : [];
        for (let i = list.length - 1; i >= 0; i--) {
          try {
            const entry = JSON.parse(list[i]);
            if (entry && entry.accepted !== false && typeof entry.ts === "number") {
              if (parseInt(nowMs || "0", 10) - entry.ts < parseInt(cooldownMs || "0", 10)) return int(-3);
              break;
            }
          } catch { /* keep scanning */ }
        }
      }
      seen.value.add(sha);
      daily.value = String(dailyVal + 1);
      const log = getEntry(logKey, "list");
      log.value.push(logEntry);
      if (log.value.length > 200) log.value = log.value.slice(-200);
      const counter = getEntry(countKey, "string");
      const total = parseInt(counter.value || "0", 10) + 1;
      counter.value = String(total);
      return int(total);
    }
    case "EVALSHA": return err("NOSCRIPT fake-redis has no script cache");
    case "LLEN": {
      const e = store.get(a[0]);
      return int(e && e.type === "list" ? e.value.length : 0);
    }
    case "KEYS": {
      const pat = (a[0] || "*").replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
      const re = new RegExp("^" + pat + "$");
      return arr([...store.keys()].filter((k) => re.test(k)).map(bulk));
    }
    default:
      console.log(`[fake-redis] unhandled command: ${cmd}`);
      return ok();
  }
}

// Incremental RESP parser (arrays of bulk strings; also inline commands).
function makeParser(onCommand) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length === 0) return;
      if (buf[0] === 0x2a) { // '*'
        const lineEnd = buf.indexOf("\r\n");
        if (lineEnd === -1) return;
        const count = parseInt(buf.slice(1, lineEnd).toString(), 10);
        let pos = lineEnd + 2;
        const args = [];
        let complete = true;
        for (let i = 0; i < count; i++) {
          if (pos >= buf.length) { complete = false; break; }
          if (buf[pos] === 0x24) { // '$'
            const le = buf.indexOf("\r\n", pos);
            if (le === -1) { complete = false; break; }
            const len = parseInt(buf.slice(pos + 1, le).toString(), 10);
            const start = le + 2;
            if (buf.length < start + len + 2) { complete = false; break; }
            args.push(buf.slice(start, start + len).toString());
            pos = start + len + 2;
          } else if (buf[pos] === 0x3a) { // ':' integer (rare)
            const le = buf.indexOf("\r\n", pos);
            if (le === -1) { complete = false; break; }
            args.push(buf.slice(pos + 1, le).toString());
            pos = le + 2;
          } else { complete = false; break; }
        }
        if (!complete) return;
        buf = buf.slice(pos);
        onCommand(args);
      } else {
        const lineEnd = buf.indexOf("\r\n");
        if (lineEnd === -1) return;
        const line = buf.slice(0, lineEnd).toString().trim();
        buf = buf.slice(lineEnd + 2);
        if (line) onCommand(line.split(/\s+/));
      }
    }
  };
}

const port = parseInt(process.env.FAKE_REDIS_PORT || "6399", 10);
const server = net.createServer((socket) => {
  const feed = makeParser((args) => {
    try {
      socket.write(execCommand(args));
    } catch (e) {
      socket.write(err(e.message));
    }
  });
  socket.on("data", feed);
  socket.on("error", () => {});
});
server.listen(port, "127.0.0.1", () => console.log(`[fake-redis] listening on 127.0.0.1:${port}`));
