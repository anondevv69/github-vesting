# GitLawb integration

[GitLawb](https://gitlawb.com/) is a Base-native decentralized git network for AI agents and developers — DID identity, signed pushes, no passwords.

This vesting app supports **GitHub** and **GitLawb** as push sources.

## How it works

| | GitHub | GitLawb |
|---|--------|---------|
| Identity | GitHub OAuth + App | `did:key` via `gl identity` |
| Repo format | `owner/repo` | `{ownerShort}/{repoName}` |
| Push events | GitHub App webhook | `gl webhook create` → our endpoint |
| Webhook URL | `/api/webhook/github` | `/api/webhook/gitlawb` |

## Setup (developer)

1. [Install GitLawb CLI](https://gitlawb.com/start):
   ```bash
   curl -fsSL https://gitlawb.com/install.sh | sh
   export GITLAWB_NODE=https://node.gitlawb.com
   gl identity new && gl register
   gl repo create my-project
   ```

2. Use the vesting wizard — choose **GitLawb** platform, lock tokens on Base.

3. Register webhook (after lock):
   ```bash
   gl webhook create my-project \
     --url https://YOUR-SERVER/api/webhook/gitlawb \
     --events push \
     --secret YOUR_SECRET
   ```

4. Set on backend:
   ```bash
   GITLAWB_WEBHOOK_SECRET=YOUR_SECRET
   GITLAWB_NODE_URL=https://node.gitlawb.com
   ```

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/gitlawb/setup` | Webhook URL + CLI commands |
| GET | `/api/gitlawb/repo?repo=owner/repo` | Verify repo exists on node |
| POST | `/api/webhook/gitlawb` | Push events (`X-Gitlawb-Event: push`) |

## Webhook payload

GitLawb sends (per [gitlawb/node](https://github.com/gitlawb/node)):

- Headers: `X-Gitlawb-Event`, `X-Gitlawb-Delivery`, `X-Gitlawb-Signature-256`
- Body: `ref`, `before`, `after`, `pusher.did`, `repository.name`, `repository.owner_did`

## On-chain repoId

GitLawb grants use `keccak256("gitlawb:{ownerShort}/{repo}")` — distinct from GitHub repos with the same path.

## Links

- [Get started](https://gitlawb.com/start)
- [Agents / MCP](https://gitlawb.com/agents)
- [Node dashboard](https://gitlawb.com/node)
- [Browse repos](https://gitlawb.com/node/repos)
