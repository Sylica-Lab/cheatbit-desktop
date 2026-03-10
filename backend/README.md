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

Billing can run through Dodo Payments by setting:

```bash
DODO_PAYMENTS_API_KEY=...
DODO_PAYMENTS_WEBHOOK_SECRET=...
DODO_PAYMENTS_ENVIRONMENT=live_mode
DODO_PRODUCT_ID=...
```

If `DODO_PRODUCT_ID` is omitted, the backend will try to auto-select the only recurring Dodo product on the account. Stripe can remain installed as a fallback provider, but `ALLOW_BUILT_IN_STRIPE_CONFIG=false` and empty Stripe secrets keep it disabled.

On Render specifically, `RENDER=true` is enough for the backend to fall back to `0.0.0.0:10000` even if `PORT` is missing.
