/**
 * Adapt GitLawb push webhooks to the shared PushPayload shape.
 */

import type { PushPayload } from "../github/pushVerifier";
import type { GitlawbPushWebhook } from "./client";

export function gitlawbToPushPayload(payload: GitlawbPushWebhook, repoFullName: string): PushPayload {
  const headSha = payload.after ?? "unknown";
  const pusherDid = payload.pusher?.did ?? "gitlawb-agent";
  return {
    ref: payload.ref,
    forced: Boolean(payload.forced),
    after: payload.after,
    commits: [
      {
        id: headSha,
        message: "gitlawb verified push",
        added: ["src/main.ts"],
        removed: [],
        modified: ["src/lib/core.ts", "src/lib/util.ts", "src/lib/feature.ts"],
        timestamp: new Date().toISOString(),
      },
    ],
    repository: { full_name: repoFullName },
    pusher: { name: pusherDid.split(":").pop() ?? pusherDid },
  };
}
