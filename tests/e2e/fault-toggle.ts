/**
 * TEST-ONLY fault toggle for the launch-gate suite (round-3).
 * Usage: npx tsx tests/e2e/fault-toggle.ts prepared-launch-get on|off
 *
 * Sets/deletes the fake-redis control key that makes GETs of
 * prepared-launch records return a Redis error, so the suite can
 * prove registration fails closed (LAUNCH_PREPARED_LOOKUP_FAILED)
 * when the prepared-record lookup errors — instead of treating the
 * error as "no record" and skipping the recognition checks.
 */
import Redis from "ioredis";

async function main() {
  const [what, mode] = process.argv.slice(2);
  if (what !== "prepared-launch-get" || (mode !== "on" && mode !== "off")) {
    throw new Error("usage: fault-toggle.ts prepared-launch-get on|off");
  }
  const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6399");
  if (mode === "on") await redis.set("__fault_prepared_launch_get", "1");
  else await redis.del("__fault_prepared_launch_get");
  console.log(`FAULT prepared-launch-get ${mode}`);
  redis.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
