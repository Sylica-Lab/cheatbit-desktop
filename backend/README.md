# Backend

This backend is isolated from the desktop app so it can be installed, run, and deployed from `backend/` with its own `node_modules` and `.env`.

## Local setup

```bash
cd backend
cp .env.example .env
npm install
npm run start
```

## Local migration

```bash
cd backend
npm run migrate
```

## Cloudflare Worker deploy

```bash
cd backend
npm install
npx wrangler login
npm run deploy
```

The Worker config lives in `backend/wrangler.jsonc` and the Worker entrypoint is `backend/worker.mjs`.
