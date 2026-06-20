# Deploy to Railway

## 1. Backend service

1. Create a [Railway](https://railway.app) project → **New Project** → **Deploy from GitHub repo**
2. Add **Redis** plugin → copy `REDIS_URL` into service variables
3. Set environment variables (from `.env.example`):

| Variable | Example |
|----------|---------|
| `NODE_ENV` | `production` |
| `SERVER_URL` | `https://your-app.up.railway.app` |
| `FRONTEND_URL` | `https://vest.yourdomain.com` |
| `REDIS_URL` | from Railway Redis |
| `GITHUB_*` | GitHub App credentials |
| `ORACLE_PRIVATE_KEY` | oracle hot wallet |
| `GIT_ESCROW_ADDRESS` | `0x76dd4…` |
| `BASE_RPC_URL` | Base RPC |
| `SESSION_SECRET` | random string |

4. Nixpacks runs `npm ci` once (install), then `npm run build` (no-op), then `npm start` via **tsx**
5. Health check: `GET /health` — returns 200 when the process is up; `configured: false` + `missingEnv` if vars are unset
6. Bind host defaults to `0.0.0.0` (Railway). Set `PORT` automatically via Railway; do **not** hardcode it.

**GitHub App webhook:** `https://YOUR-SERVER-URL/api/webhook/github`

**OAuth callback:** `https://YOUR-SERVER-URL/api/oauth/github/callback`

## 2. Frontend (Vercel / Cloudflare Pages)

```bash
cd frontend
# Set VITE_API_URL=https://YOUR-SERVER-URL
npm run build
```

Deploy `frontend/dist` with env:

- `VITE_API_URL` = Railway backend URL
- `VITE_GIT_ESCROW_ADDRESS` = escrow contract
- `VITE_CHAIN` = `base`

Point `FRONTEND_URL` on the backend to this URL for CORS.

## 3. Custom domain (optional)

- `api.yourdomain.com` → Railway backend
- `vest.yourdomain.com` → frontend

Update `SERVER_URL`, `FRONTEND_URL`, GitHub App webhook, and skill manifest URLs.

## 4. Bankr skill

After deploy, update `skills/bankr-vesting/skill-manifest.json`:

- `apiBaseUrl` → your `SERVER_URL`
- `defaultSiteUrl` → your `FRONTEND_URL`

Install command for users/agents:

```text
install GitHub Vesting skill at https://github.com/anondevv69/github-vesting/tree/main/skills/bankr-vesting
```

Test agent API:

```bash
curl -H "x-wallet-address: 0xYOUR_WALLET" "https://YOUR-SERVER-URL/api/agent/briefing"
```
