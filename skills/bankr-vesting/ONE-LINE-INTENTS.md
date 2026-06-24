# One-line intents → agent API

Replace `{API}` with your deployed backend URL (`VESTING_API_URL` / `SERVER_URL`).

Linked Bankr wallet → header `x-wallet-address: 0x…` on every call.

| User says | Agent does |
|-----------|------------|
| **my vesting progress** | `GET {API}/api/agent/briefing?wallet=0x…` → paste `tweetReply` |
| **how many pushes until release?** | briefing or `GET {API}/api/agent/status?repo=owner/repo` |
| **list my github locks** | `GET {API}/api/agent/grants?wallet=0x…` |
| **start github vesting** | `GET {API}/api/agent/setup-link?wallet=0x…` → paste `{VESTING_SITE_URL}/create` |
| **start gitlawb vesting** | setup-link + note wizard supports GitLawb (DID repos on [gitlawb.com](https://gitlawb.com/start)) |
| **vest Space on my repo** | setup-link + explain wizard (approve/lock via web) |
| **vesting on anondevv69/github-vesting** | `GET {API}/api/agent/status?repo=anondevv69/github-vesting` |
| **what is a milestone?** | Explain: every N verified pushes → token release (no API) |

## Forbidden replies

- "I can't lock tokens for you" **without** loading this skill and returning the setup link
- Empty reply when briefing returns `tweetReply`
- Paraphrasing stats **without** the lock/create URL on its own line

## Example curl

```bash
curl -H "x-wallet-address: 0xbff8c6c34f1efacf6844350de907cca6f07c76b8" \
  "http://localhost:3000/api/agent/briefing"
```

```bash
curl "http://localhost:3000/api/agent/status?repo=anondevv69/github-vesting"
```
