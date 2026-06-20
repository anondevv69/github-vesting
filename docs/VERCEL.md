# Deploy frontend (Vercel)

## 1. One-time setup

```bash
cd frontend
vercel login
```

## 2. Environment variables (Vercel project settings)

| Variable | Value |
|----------|-------|
| `VITE_API_URL` | Railway backend URL (e.g. `https://your-app.up.railway.app`) |
| `VITE_GIT_ESCROW_ADDRESS` | `0x76dd4C6ea986684CDf822eC0832e142A2D5C8165` |
| `VITE_CHAIN` | `base` |

## 3. Deploy

From `frontend/`:

```bash
vercel --prod
```

Or connect the GitHub repo in the Vercel dashboard:

- **Root directory:** `frontend`
- **Build command:** `npm run build`
- **Output directory:** `dist`

`vercel.json` rewrites all routes to `index.html` for React Router.

## 4. Backend CORS

Set on Railway (backend service):

```bash
FRONTEND_URL=https://your-vercel-app.vercel.app
```

Or your custom domain (e.g. `https://vest.bankr.space`).

## 5. Custom domain (optional)

Add domain in Vercel → update `FRONTEND_URL` on backend + `skills/bankr-vesting/skill-manifest.json` (`defaultSiteUrl`, `VESTING_SITE_URL`).
