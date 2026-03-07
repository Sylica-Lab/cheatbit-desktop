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

## Hosted Node deploys

For Render and similar platforms, deploy the `backend/` directory with:

```bash
npm install
npm run start
```

Set a real `DATABASE_URL`, `BACKEND_TOKEN_SECRET`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD`. Do not force `BACKEND_HOST=127.0.0.1` or `BACKEND_PORT=8787` on the platform; the server will bind to `0.0.0.0:$PORT` automatically when `PORT` is provided.
