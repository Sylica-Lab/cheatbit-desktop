const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");
const dotenv = require("dotenv");
const { Client } = require("pg");
const Stripe = require("stripe");
const { getBuiltInStripeConfig } = require("./builtInBillingConfig");

loadEnvVariables();

const WORKER_RUNTIME = process.env.CLOUDFLARE_WORKER === "true";
const AUTO_INITIALIZE_DATABASE =
  process.env.RUN_DB_MIGRATIONS_ON_START === "true";
const builtInStripeConfig = shouldUseBuiltInStripeConfig()
  ? getBuiltInStripeConfig()
  : {
      publishableKey: "",
      secretKey: "",
      webhookSecret: "",
      priceId: "",
      productName: "",
      monthlyPriceUsd: null,
      publicUrl: "",
      billingReturnUrl: "",
    };
const PLATFORM_PORT = normalizePort(process.env.PORT);

const HOST =
  PLATFORM_PORT != null
    ? "0.0.0.0"
    : process.env.BACKEND_HOST || process.env.HOST || "127.0.0.1";
const PORT = PLATFORM_PORT || normalizePort(process.env.BACKEND_PORT) || 8787;
const PUBLIC_DIR = path.join(__dirname, "public");
const SCHEMA_PATH = path.join(__dirname, "schema.sql");
const MIGRATE_ONLY = process.argv.includes("--migrate-only");
const TOKEN_SECRET =
  process.env.BACKEND_TOKEN_SECRET || "interview-coder-dev-secret";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me-now";
const DATABASE_URL =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  "postgresql://postgres:postgres@127.0.0.1:5432/interview_coder";
const USE_SSL =
  process.env.DATABASE_SSL === "true" || process.env.PGSSLMODE === "require";
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const STRIPE_SECRET_KEY = resolveConfiguredString(
  process.env.STRIPE_SECRET_KEY,
  builtInStripeConfig.secretKey
);
const STRIPE_WEBHOOK_SECRET = resolveConfiguredString(
  process.env.STRIPE_WEBHOOK_SECRET,
  builtInStripeConfig.webhookSecret
);
const STRIPE_PRICE_ID = resolveConfiguredString(
  process.env.STRIPE_PRICE_ID,
  builtInStripeConfig.priceId
);
const STRIPE_PRODUCT_NAME =
  resolveConfiguredString(
    process.env.STRIPE_PRODUCT_NAME,
    builtInStripeConfig.productName
  ) ||
  "CheatBit Unlimited";
const STRIPE_MONTHLY_PRICE_USD = normalizePositiveNumber(
  process.env.STRIPE_MONTHLY_PRICE_USD,
  normalizePositiveNumber(builtInStripeConfig.monthlyPriceUsd, 20)
);
const STRIPE_MONTHLY_PRICE_CENTS = Math.round(STRIPE_MONTHLY_PRICE_USD * 100);
const BACKEND_PUBLIC_URL = (
  resolveConfiguredString(
    process.env.BACKEND_PUBLIC_URL,
    process.env.RENDER_EXTERNAL_URL,
    builtInStripeConfig.publicUrl
  ) ||
  `http://${HOST}:${PORT}`
).replace(/\/$/, "");
const BILLING_RETURN_URL = (
  resolveConfiguredString(
    process.env.BILLING_RETURN_URL,
    builtInStripeConfig.billingReturnUrl
  ) ||
  `${BACKEND_PUBLIC_URL}/billing/return`
).replace(/\/$/, "");

const PLAN_LIMITS = {
  free: { solveDaily: 20, debugDaily: 8, requestsPerHour: 40 },
  pro: { solveDaily: 1_000_000, debugDaily: 1_000_000, requestsPerHour: 1_000_000 },
  enterprise: { solveDaily: 2000, debugDaily: 800, requestsPerHour: 1200 },
};
const stripe = STRIPE_SECRET_KEY ? Stripe(STRIPE_SECRET_KEY) : null;
const stripeWebhookConfigured = Boolean(stripe && STRIPE_WEBHOOK_SECRET);
let databaseInitialized = false;
let workerInitializationPromise = null;
let nodeStartupPromise = null;

const server = http.createServer(async (req, res) => {
  try {
    addCorsHeaders(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || HOST}`);
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/health") {
      const nowResult = await query(
        "SELECT NOW() AS now, current_database() AS database_name"
      );
      const row = nowResult.rows[0];
      sendJson(res, 200, {
        ok: true,
        service: "cheatbit-backend",
        now: toIso(row.now),
        database: row.database_name,
      });
      return;
    }

    if ((req.method === "GET" || req.method === "HEAD") &&
        (pathname === "/" || pathname === "/admin")) {
      serveStatic(res, "dashboard.html", undefined, req.method === "HEAD");
      return;
    }

    if ((req.method === "GET" || req.method === "HEAD") && pathname === "/admin.css") {
      serveStatic(res, "dashboard.css", "text/css; charset=utf-8", req.method === "HEAD");
      return;
    }

    if ((req.method === "GET" || req.method === "HEAD") && pathname === "/admin.js") {
      serveStatic(
        res,
        "dashboard.js",
        "application/javascript; charset=utf-8",
        req.method === "HEAD"
      );
      return;
    }

    if (req.method === "GET" && pathname === "/billing/return") {
      if (url.searchParams.get("status") === "success") {
        const checkoutSessionId = String(
          url.searchParams.get("session_id") || ""
        ).trim();

        if (checkoutSessionId && stripe) {
          try {
            await syncCheckoutSessionById(checkoutSessionId);
          } catch (error) {
            console.error(
              "Failed to sync Stripe checkout session on billing return:",
              error
            );
          }
        }
      }

      serveBillingReturnPage(res, {
        status: String(url.searchParams.get("status") || "success"),
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/billing/webhook") {
      if (!stripe || !STRIPE_WEBHOOK_SECRET) {
        sendJson(res, 503, {
          error: "Stripe webhooks are not configured on this backend.",
        });
        return;
      }

      const signature = String(req.headers["stripe-signature"] || "");
      if (!signature) {
        sendJson(res, 400, { error: "Missing Stripe signature header." });
        return;
      }

      const rawBody = await parseRawBody(req);

      let event;
      try {
        event = stripe.webhooks.constructEvent(
          rawBody,
          signature,
          STRIPE_WEBHOOK_SECRET
        );
      } catch (error) {
        sendJson(res, 400, {
          error: "Invalid Stripe webhook signature.",
        });
        return;
      }

      await handleStripeWebhookEvent(event);
      sendJson(res, 200, { received: true });
      return;
    }

    if (req.method === "POST" && pathname === "/api/auth/register") {
      const body = await parseJsonBody(req);
      const name = normalizeName(body.name);
      const email = normalizeEmail(body.email);
      const password = String(body.password || "");

      if (!name || !email || password.length < 8) {
        sendJson(res, 400, {
          error:
            "Name, email, and a password with at least 8 characters are required.",
        });
        return;
      }

      try {
        const now = new Date();
        const user = await createUser({
          id: createId("usr"),
          name,
          email,
          passwordHash: hashPassword(password),
          role: "user",
          subscriptionPlan: "free",
          subscriptionStatus: "trial",
          rateLimits: PLAN_LIMITS.free,
          createdAt: now,
          updatedAt: now,
          lastLoginAt: now,
          subscriptionStartedAt: now,
          subscriptionRenewsAt: null,
        });

        const session = await createUserSession(user);
        sendJson(res, 201, { session });
      } catch (error) {
        if (error && error.code === "23505") {
          sendJson(res, 409, { error: "An account with that email already exists." });
          return;
        }
        throw error;
      }
      return;
    }

    if (req.method === "POST" && pathname === "/api/auth/login") {
      const body = await parseJsonBody(req);
      const email = normalizeEmail(body.email);
      const password = String(body.password || "");

      if (!email || !password) {
        sendJson(res, 400, { error: "Email and password are required." });
        return;
      }

      const user = await getUserByEmail(email);
      if (!user || !verifyPassword(password, user.passwordHash)) {
        sendJson(res, 401, { error: "Invalid email or password." });
        return;
      }

      const updatedUser = await updateUserLogin(user.id);
      const session = await createUserSession(updatedUser || user);
      sendJson(res, 200, { session });
      return;
    }

    if (req.method === "GET" && pathname === "/api/auth/me") {
      const auth = await requireUser(req);
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error });
        return;
      }

      const session = await createUserSession(auth.user);
      sendJson(res, 200, { session });
      return;
    }

    if (req.method === "GET" && pathname === "/api/account/dashboard") {
      const auth = await requireUser(req);
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error });
        return;
      }

      const dashboard = await buildUserDashboard(auth.user);
      sendJson(res, 200, { dashboard });
      return;
    }

    if (req.method === "GET" && pathname === "/api/usage/summary") {
      const auth = await requireUser(req);
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error });
        return;
      }

      sendJson(res, 200, {
        usage: await buildUsageSnapshot(auth.user),
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/usage/consume") {
      const auth = await requireUser(req);
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error });
        return;
      }

      const body = await parseJsonBody(req);
      const action = isAction(body.action) ? body.action : null;

      if (!action) {
        sendJson(res, 400, { error: "A valid action is required." });
        return;
      }

      const decision = await evaluateUsage(auth.user, action);
      if (!decision.allowed) {
        await recordUsageEvent(auth.user.id, action, false, decision.error);
        sendJson(res, decision.statusCode || 429, {
          allowed: false,
          error: decision.error,
          usage: await buildUsageSnapshot(auth.user),
        });
        return;
      }

      await recordUsageEvent(auth.user.id, action, true, null);
      sendJson(res, 200, {
        allowed: true,
        usage: await buildUsageSnapshot(auth.user),
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/billing/checkout-session") {
      const auth = await requireUser(req);
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error });
        return;
      }

      if (!stripe) {
        sendJson(res, 503, {
          error: "Stripe billing is not configured on this backend.",
        });
        return;
      }

      const checkoutSession = await createStripeCheckoutSession(auth.user);
      sendJson(res, 200, { url: checkoutSession.url });
      return;
    }

    if (req.method === "POST" && pathname === "/api/billing/portal-session") {
      const auth = await requireUser(req);
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error });
        return;
      }

      if (!stripe) {
        sendJson(res, 503, {
          error: "Stripe billing is not configured on this backend.",
        });
        return;
      }

      const portalSession = await createStripePortalSession(auth.user);
      sendJson(res, 200, { url: portalSession.url });
      return;
    }

    if (req.method === "POST" && pathname === "/api/admin/login") {
      const body = await parseJsonBody(req);
      const email = normalizeEmail(body.email);
      const password = String(body.password || "");
      const admin = await getAdminByEmail(email);

      if (!admin || !verifyPassword(password, admin.passwordHash)) {
        sendJson(res, 401, { error: "Invalid admin credentials." });
        return;
      }

      const token = signToken({
        sub: admin.id,
        role: "admin",
        email: admin.email,
      });

      sendJson(res, 200, {
        token,
        admin: {
          id: admin.id,
          email: admin.email,
          name: admin.name,
        },
      });
      return;
    }

    if (pathname.startsWith("/api/admin")) {
      const auth = await requireAdmin(req);
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error });
        return;
      }

      if (req.method === "GET" && pathname === "/api/admin/stats") {
        sendJson(res, 200, await buildAdminStats());
        return;
      }

      if (req.method === "GET" && pathname === "/api/admin/users") {
        const users = await getAllUsersWithUsage();
        sendJson(res, 200, { users });
        return;
      }

      if (req.method === "GET" && pathname === "/api/admin/events") {
        const events = await getAdminEvents(150);
        sendJson(res, 200, { events });
        return;
      }

      const userMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (req.method === "PATCH" && userMatch) {
        const userId = userMatch[1];
        const body = await parseJsonBody(req);
        const user = await getUserById(userId);

        if (!user) {
          sendJson(res, 404, { error: "User not found." });
          return;
        }

        const nextPlan = isPlan(body.subscriptionPlan)
          ? body.subscriptionPlan
          : user.subscriptionPlan;
        const nextStatus = isStatus(body.subscriptionStatus)
          ? body.subscriptionStatus
          : user.subscriptionStatus;
        const defaultLimits = PLAN_LIMITS[nextPlan];
        const currentLimits = body.applyPlanDefaults
          ? defaultLimits
          : {
              solveDaily: clampLimit(
                body.rateLimits?.solveDaily,
                user.rateLimits.solveDaily
              ),
              debugDaily: clampLimit(
                body.rateLimits?.debugDaily,
                user.rateLimits.debugDaily
              ),
              requestsPerHour: clampLimit(
                body.rateLimits?.requestsPerHour,
                user.rateLimits.requestsPerHour
              ),
            };

        const now = new Date();
        const nextRenewsAt =
          nextStatus === "active"
            ? user.subscriptionRenewsAt || new Date(now.getTime() + THIRTY_DAYS_MS)
            : null;
        const nextStartedAt =
          user.subscriptionStartedAt || now;

        const updatedUser = await updateUserSubscription(userId, {
          subscriptionPlan: nextPlan,
          subscriptionStatus: nextStatus,
          rateLimits: currentLimits,
          subscriptionStartedAt: nextStartedAt,
          subscriptionRenewsAt: nextRenewsAt,
        });

        sendJson(res, 200, {
          user: {
            ...sanitizeUser(updatedUser),
            usage: await buildUsageSnapshot(updatedUser),
          },
        });
        return;
      }
    }

    sendJson(res, 404, { error: "Route not found." });
  } catch (error) {
    console.error("Backend request failed:", error);
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Unexpected server error.",
    });
  }
});

if (require.main === module) {
  startNodeServer().catch((error) => {
    console.error("Failed to initialize PostgreSQL backend:", error);
    process.exit(1);
  });
}

async function initializeDatabase() {
  const schemaSql = fs.readFileSync(SCHEMA_PATH, "utf8");
  await query(schemaSql);
  await seedAdmin();
  databaseInitialized = true;
}

async function prepareWorkerRuntime() {
  if (!AUTO_INITIALIZE_DATABASE || databaseInitialized) {
    return;
  }

  if (!workerInitializationPromise) {
    workerInitializationPromise = initializeDatabase().finally(() => {
      if (!databaseInitialized) {
        workerInitializationPromise = null;
      }
    });
  }

  await workerInitializationPromise;
}

async function startNodeServer() {
  if (nodeStartupPromise) {
    return nodeStartupPromise;
  }

  nodeStartupPromise = (async () => {
    await initializeDatabase();

    if (MIGRATE_ONLY) {
      console.log(
        `CheatBit PostgreSQL migration complete: ${describeDatabaseTarget()}`
      );
      return;
    }

    if (!server.listening) {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(PORT, HOST, () => {
          server.removeListener("error", reject);
          console.log(
            `CheatBit backend listening on http://${HOST}:${PORT} (dashboard at /admin)`
          );
          console.log(`PostgreSQL: ${describeDatabaseTarget()}`);
          console.log(`Admin login: ${ADMIN_EMAIL}`);
          if (stripe) {
            console.log(
              `Stripe billing: checkout enabled${stripeWebhookConfigured ? " with webhook sync" : " without webhook sync"}`
            );
          } else {
            console.warn(
              "Stripe billing disabled. Set STRIPE_SECRET_KEY in .env."
            );
          }
          resolve();
        });
      });
    }
  })();

  return nodeStartupPromise;
}

function loadEnvVariables() {
  const candidatePaths = [
    path.join(process.cwd(), ".env"),
    path.join(__dirname, ".env"),
    path.join(__dirname, "..", ".env"),
    typeof process.resourcesPath === "string"
      ? path.join(process.resourcesPath, ".env")
      : null,
  ].filter(Boolean);

  for (const envPath of candidatePaths) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath, override: false });
      return;
    }
  }
}

function describeDatabaseTarget() {
  try {
    const parsed = new URL(DATABASE_URL);
    const databaseName = parsed.pathname.replace(/^\//, "") || "(default)";
    return `${parsed.hostname}:${parsed.port || "5432"}/${databaseName}`;
  } catch (_error) {
    return DATABASE_URL;
  }
}

function shouldUseBuiltInStripeConfig() {
  if (WORKER_RUNTIME) {
    return false;
  }

  return process.env.ALLOW_BUILT_IN_STRIPE_CONFIG !== "false";
}

async function seedAdmin() {
  await query(
    `
      INSERT INTO admin_users (id, name, email, password_hash)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (email)
      DO UPDATE SET
        name = EXCLUDED.name,
        password_hash = EXCLUDED.password_hash
    `,
    [createId("adm"), "Dashboard Admin", ADMIN_EMAIL, hashPassword(ADMIN_PASSWORD)]
  );
}

function addCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS, HEAD");
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function serveStatic(res, fileName, contentType, headOnly = false) {
  const filePath = path.join(PUBLIC_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    sendJson(res, 404, { error: "Static asset not found." });
    return;
  }

  const data = fs.readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type":
      contentType || mimeTypeFor(path.extname(fileName)) || "text/plain; charset=utf-8",
    "Content-Length": data.length,
  });
  res.end(headOnly ? undefined : data);
}

function mimeTypeFor(extension) {
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".js") return "application/javascript; charset=utf-8";
  return "application/octet-stream";
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("Request body too large."));
      }
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Invalid JSON request body."));
      }
    });
    req.on("error", reject);
  });
}

function parseRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += nextChunk.length;
      if (size > 1_000_000) {
        reject(new Error("Request body too large."));
        return;
      }

      chunks.push(nextChunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function serveBillingReturnPage(res, options) {
  const status = normalizeBillingReturnStatus(options.status);
  const title =
    status === "success"
      ? "Subscription updated"
      : status === "cancelled"
      ? "Checkout cancelled"
      : "Billing portal closed";
  const description =
    status === "success"
      ? "Your CheatBit subscription has been updated. Return to the app and refresh the dashboard."
      : status === "cancelled"
      ? "The Stripe checkout was cancelled. You can return to the app and try again at any time."
      : "You can return to CheatBit now.";
  const appUrl = `interview-coder://billing/return?status=${encodeURIComponent(
    status
  )}`;
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #050505;
        color: white;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        width: min(560px, calc(100vw - 32px));
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 24px;
        padding: 28px;
        background:
          radial-gradient(circle at top left, rgba(125, 249, 199, 0.14), transparent 34%),
          linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.01));
        box-shadow: 0 30px 100px rgba(0, 0, 0, 0.48);
      }
      h1 {
        margin: 0 0 10px;
        font-size: 28px;
      }
      p {
        margin: 0 0 18px;
        line-height: 1.6;
        color: rgba(255, 255, 255, 0.7);
      }
      a {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 12px 18px;
        border-radius: 14px;
        background: white;
        color: black;
        text-decoration: none;
        font-weight: 600;
      }
      .hint {
        margin-top: 14px;
        font-size: 13px;
        color: rgba(255, 255, 255, 0.55);
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(description)}</p>
      <a href="${escapeHtml(appUrl)}">Return to CheatBit</a>
      <div class="hint">If the app does not open automatically, use the button above and then refresh the dashboard once.</div>
    </main>
    <script>
      window.setTimeout(function () {
        window.location.href = ${JSON.stringify(appUrl)};
      }, 350);
    </script>
  </body>
</html>`;

  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
  });
  res.end(html);
}

async function createStripeCheckoutSession(user) {
  if (!stripe) {
    throw new Error("Stripe billing is not configured on this backend.");
  }

  const customerId = await ensureStripeCustomerId(user);
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: user.id,
    allow_promotion_codes: true,
    success_url: `${BILLING_RETURN_URL}?status=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${BILLING_RETURN_URL}?status=cancelled`,
    line_items: [buildStripeLineItem()],
    metadata: {
      appUserId: user.id,
      appUserEmail: user.email,
    },
    subscription_data: {
      metadata: {
        appUserId: user.id,
        appUserEmail: user.email,
      },
    },
  });

  if (!session.url) {
    throw new Error("Stripe did not return a checkout URL.");
  }

  return {
    url: session.url,
  };
}

async function createStripePortalSession(user) {
  if (!stripe) {
    throw new Error("Stripe billing is not configured on this backend.");
  }

  const customerId = user.stripeCustomerId || (await ensureStripeCustomerId(user));
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${BILLING_RETURN_URL}?status=portal`,
  });

  return {
    url: session.url,
  };
}

function buildStripeLineItem() {
  if (STRIPE_PRICE_ID) {
    return {
      price: STRIPE_PRICE_ID,
      quantity: 1,
    };
  }

  return {
    price_data: {
      currency: "usd",
      unit_amount: STRIPE_MONTHLY_PRICE_CENTS,
      recurring: {
        interval: "month",
      },
      product_data: {
        name: STRIPE_PRODUCT_NAME,
      },
    },
    quantity: 1,
  };
}

async function ensureStripeCustomerId(user) {
  if (!stripe) {
    throw new Error("Stripe billing is not configured on this backend.");
  }

  if (user.stripeCustomerId) {
    try {
      const existing = await stripe.customers.retrieve(user.stripeCustomerId);
      if (existing && !existing.deleted) {
        return existing.id;
      }
    } catch (error) {
      console.warn(
        `Stripe customer ${user.stripeCustomerId} could not be retrieved. Creating a replacement customer.`
      );
    }
  }

  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name,
    metadata: {
      appUserId: user.id,
    },
  });

  await updateUserBillingState(user.id, {
    stripeCustomerId: customer.id,
  });

  return customer.id;
}

async function handleStripeWebhookEvent(event) {
  if (event.type === "checkout.session.completed") {
    const checkoutSession = event.data.object;
    if (checkoutSession.mode === "subscription") {
      await syncCheckoutSessionById(checkoutSession.id);
    }
    return;
  }

  if (
    event.type === "customer.subscription.created" ||
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    await syncStripeSubscriptionObject(event.data.object);
    return;
  }

  if (
    event.type === "invoice.paid" ||
    event.type === "invoice.payment_failed"
  ) {
    const subscriptionId = extractStripeId(event.data.object.subscription);
    if (subscriptionId) {
      await syncStripeSubscriptionById(subscriptionId);
    }
  }
}

async function syncCheckoutSessionById(sessionId) {
  if (!stripe || !sessionId) {
    return null;
  }

  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ["subscription", "customer"],
  });

  const customerId = extractStripeId(session.customer);
  const subscriptionId = extractStripeId(session.subscription);
  const metadataUserId =
    session.metadata?.appUserId || session.client_reference_id || null;

  let user = metadataUserId ? await getUserById(metadataUserId) : null;
  if (!user && customerId) {
    user = await getUserByStripeCustomerId(customerId);
  }
  if (!user && subscriptionId) {
    user = await getUserByStripeSubscriptionId(subscriptionId);
  }

  if (!user) {
    return null;
  }

  if (customerId && customerId !== user.stripeCustomerId) {
    user = await updateUserBillingState(user.id, {
      stripeCustomerId: customerId,
      subscriptionSource: "stripe",
    });
  }

  if (subscriptionId) {
    return syncStripeSubscriptionById(
      subscriptionId,
      user ? user.id : null,
      customerId
    );
  }

  return user;
}

async function syncStripeSubscriptionById(
  subscriptionId,
  hintedUserId = null,
  hintedCustomerId = null
) {
  if (!stripe || !subscriptionId) {
    return null;
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["items.data.price"],
  });

  return syncStripeSubscriptionObject(
    subscription,
    hintedUserId,
    hintedCustomerId
  );
}

async function syncStripeSubscriptionObject(
  subscription,
  hintedUserId = null,
  hintedCustomerId = null
) {
  const customerId = hintedCustomerId || extractStripeId(subscription.customer);
  let user = hintedUserId ? await getUserById(hintedUserId) : null;

  if (!user && subscription.metadata?.appUserId) {
    user = await getUserById(subscription.metadata.appUserId);
  }
  if (!user && customerId) {
    user = await getUserByStripeCustomerId(customerId);
  }
  if (!user && subscription.id) {
    user = await getUserByStripeSubscriptionId(subscription.id);
  }

  if (!user) {
    console.warn(
      `Stripe subscription ${subscription.id} could not be matched to an app user.`
    );
    return null;
  }

  const firstItem = subscription.items?.data?.[0] || null;
  const periodStartUnix =
    firstItem?.current_period_start || subscription.current_period_start || null;
  const periodEndUnix =
    firstItem?.current_period_end || subscription.current_period_end || null;

  return updateUserBillingState(user.id, {
    subscriptionPlan: "pro",
    subscriptionStatus: mapStripeSubscriptionStatus(subscription.status),
    subscriptionSource: "stripe",
    rateLimits: PLAN_LIMITS.pro,
    subscriptionStartedAt: periodStartUnix
      ? new Date(periodStartUnix * 1000)
      : user.subscriptionStartedAt || new Date(),
    subscriptionRenewsAt: periodEndUnix
      ? new Date(periodEndUnix * 1000)
      : null,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscription.id,
    stripePriceId: firstItem?.price?.id || null,
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
  });
}

function mapStripeSubscriptionStatus(status) {
  if (status === "trialing") {
    return "trial";
  }

  if (status === "active") {
    return "active";
  }

  if (
    status === "past_due" ||
    status === "unpaid" ||
    status === "incomplete" ||
    status === "incomplete_expired"
  ) {
    return "past_due";
  }

  if (status === "paused") {
    return "suspended";
  }

  return "cancelled";
}

function extractStripeId(value) {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    return value;
  }

  return typeof value.id === "string" ? value.id : null;
}

async function query(text, params = []) {
  assertDatabaseConfiguration();

  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: USE_SSL ? { rejectUnauthorized: false } : undefined,
  });

  await client.connect();
  try {
    return await client.query(text, params);
  } finally {
    await client.end();
  }
}

function assertDatabaseConfiguration() {
  if (!WORKER_RUNTIME) {
    return;
  }

  const configuredUrl = String(DATABASE_URL || "").trim();
  if (!configuredUrl) {
    throw new Error(
      "DATABASE_URL is required when deploying the backend to Cloudflare."
    );
  }

  let parsed;
  try {
    parsed = new URL(configuredUrl);
  } catch (_error) {
    throw new Error(
      "DATABASE_URL must be a valid PostgreSQL connection string when deploying to Cloudflare."
    );
  }

  const host = parsed.hostname.toLowerCase();
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
    throw new Error(
      "DATABASE_URL cannot point to localhost when deploying the backend to Cloudflare. Use a public Postgres URL or Hyperdrive."
    );
  }
}

async function getAdminByEmail(email) {
  const result = await query(
    `
      SELECT id, name, email, password_hash, created_at
      FROM admin_users
      WHERE email = $1
      LIMIT 1
    `,
    [email]
  );

  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        name: row.name,
        email: row.email,
        passwordHash: row.password_hash,
        createdAt: toDate(row.created_at),
      }
    : null;
}

async function getUserByEmail(email) {
  const result = await query(
    `
      SELECT *
      FROM app_users
      WHERE email = $1
      LIMIT 1
    `,
    [email]
  );

  return result.rows[0] ? mapUserRow(result.rows[0]) : null;
}

async function getUserById(id) {
  const result = await query(
    `
      SELECT *
      FROM app_users
      WHERE id = $1
      LIMIT 1
    `,
    [id]
  );

  return result.rows[0] ? mapUserRow(result.rows[0]) : null;
}

async function getUserByStripeCustomerId(customerId) {
  const result = await query(
    `
      SELECT *
      FROM app_users
      WHERE stripe_customer_id = $1
      LIMIT 1
    `,
    [customerId]
  );

  return result.rows[0] ? mapUserRow(result.rows[0]) : null;
}

async function getUserByStripeSubscriptionId(subscriptionId) {
  const result = await query(
    `
      SELECT *
      FROM app_users
      WHERE stripe_subscription_id = $1
      LIMIT 1
    `,
    [subscriptionId]
  );

  return result.rows[0] ? mapUserRow(result.rows[0]) : null;
}

async function createUser(input) {
  const result = await query(
    `
      INSERT INTO app_users (
        id,
        name,
        email,
        password_hash,
        role,
        subscription_plan,
        subscription_status,
        solve_daily_limit,
        debug_daily_limit,
        requests_per_hour_limit,
        created_at,
        updated_at,
        last_login_at,
        subscription_started_at,
        subscription_renews_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13, $14, $15
      )
      RETURNING *
    `,
    [
      input.id,
      input.name,
      input.email,
      input.passwordHash,
      input.role,
      input.subscriptionPlan,
      input.subscriptionStatus,
      input.rateLimits.solveDaily,
      input.rateLimits.debugDaily,
      input.rateLimits.requestsPerHour,
      input.createdAt,
      input.updatedAt,
      input.lastLoginAt,
      input.subscriptionStartedAt,
      input.subscriptionRenewsAt,
    ]
  );

  return mapUserRow(result.rows[0]);
}

async function updateUserLogin(userId) {
  const result = await query(
    `
      UPDATE app_users
      SET
        last_login_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [userId]
  );

  return result.rows[0] ? mapUserRow(result.rows[0]) : null;
}

async function updateUserSubscription(userId, input) {
  const result = await query(
    `
      UPDATE app_users
      SET
        subscription_plan = $2,
        subscription_status = $3,
        solve_daily_limit = $4,
        debug_daily_limit = $5,
        requests_per_hour_limit = $6,
        subscription_started_at = $7,
        subscription_renews_at = $8,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [
      userId,
      input.subscriptionPlan,
      input.subscriptionStatus,
      input.rateLimits.solveDaily,
      input.rateLimits.debugDaily,
      input.rateLimits.requestsPerHour,
      input.subscriptionStartedAt,
      input.subscriptionRenewsAt,
    ]
  );

  return mapUserRow(result.rows[0]);
}

async function updateUserBillingState(userId, input) {
  const existing = await getUserById(userId);
  if (!existing) {
    return null;
  }

  const hasField = (key) =>
    Object.prototype.hasOwnProperty.call(input || {}, key);

  const result = await query(
    `
      UPDATE app_users
      SET
        subscription_plan = $2,
        subscription_status = $3,
        solve_daily_limit = $4,
        debug_daily_limit = $5,
        requests_per_hour_limit = $6,
        subscription_started_at = $7,
        subscription_renews_at = $8,
        subscription_source = $9,
        stripe_customer_id = $10,
        stripe_subscription_id = $11,
        stripe_price_id = $12,
        cancel_at_period_end = $13,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [
      userId,
      hasField("subscriptionPlan")
        ? input.subscriptionPlan
        : existing.subscriptionPlan,
      hasField("subscriptionStatus")
        ? input.subscriptionStatus
        : existing.subscriptionStatus,
      hasField("rateLimits") && input.rateLimits?.solveDaily != null
        ? input.rateLimits.solveDaily
        : existing.rateLimits.solveDaily,
      hasField("rateLimits") && input.rateLimits?.debugDaily != null
        ? input.rateLimits.debugDaily
        : existing.rateLimits.debugDaily,
      hasField("rateLimits") && input.rateLimits?.requestsPerHour != null
        ? input.rateLimits.requestsPerHour
        : existing.rateLimits.requestsPerHour,
      hasField("subscriptionStartedAt")
        ? input.subscriptionStartedAt
        : existing.subscriptionStartedAt,
      hasField("subscriptionRenewsAt")
        ? input.subscriptionRenewsAt
        : existing.subscriptionRenewsAt,
      hasField("subscriptionSource")
        ? input.subscriptionSource
        : existing.subscriptionSource,
      hasField("stripeCustomerId")
        ? input.stripeCustomerId
        : existing.stripeCustomerId,
      hasField("stripeSubscriptionId")
        ? input.stripeSubscriptionId
        : existing.stripeSubscriptionId,
      hasField("stripePriceId") ? input.stripePriceId : existing.stripePriceId,
      hasField("cancelAtPeriodEnd")
        ? Boolean(input.cancelAtPeriodEnd)
        : existing.cancelAtPeriodEnd,
    ]
  );

  return result.rows[0] ? mapUserRow(result.rows[0]) : null;
}

async function createUserSession(user) {
  return {
    token: signToken({
      sub: user.id,
      role: "user",
      email: user.email,
    }),
    user: sanitizeUser(user),
    usage: await buildUsageSnapshot(user),
  };
}

async function buildUserDashboard(user) {
  return {
    user: sanitizeUser(user),
    usage: await buildUsageSnapshot(user),
    billing: buildBillingSummary(user),
    recentEvents: await getRecentEvents(user.id, 20),
    dailyActivity: await getDailyActivity(user.id, 7),
  };
}

function sanitizeUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: "user",
    subscriptionPlan: user.subscriptionPlan,
    subscriptionStatus: user.subscriptionStatus,
    subscriptionSource: user.subscriptionSource,
    cancelAtPeriodEnd: Boolean(user.cancelAtPeriodEnd),
    rateLimits: user.rateLimits,
    createdAt: toIso(user.createdAt),
    updatedAt: toIso(user.updatedAt),
    lastLoginAt: toIso(user.lastLoginAt),
    subscriptionStartedAt: toIso(user.subscriptionStartedAt),
    subscriptionRenewsAt: toIso(user.subscriptionRenewsAt),
  };
}

function mapUserRow(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    passwordHash: row.password_hash,
    role: row.role,
    subscriptionPlan: row.subscription_plan,
    subscriptionStatus: row.subscription_status,
    subscriptionSource: row.subscription_source || "manual",
    stripeCustomerId: row.stripe_customer_id || null,
    stripeSubscriptionId: row.stripe_subscription_id || null,
    stripePriceId: row.stripe_price_id || null,
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    rateLimits: {
      solveDaily: asNumber(row.solve_daily_limit),
      debugDaily: asNumber(row.debug_daily_limit),
      requestsPerHour: asNumber(row.requests_per_hour_limit),
    },
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    lastLoginAt: row.last_login_at ? toDate(row.last_login_at) : null,
    subscriptionStartedAt: row.subscription_started_at
      ? toDate(row.subscription_started_at)
      : null,
    subscriptionRenewsAt: row.subscription_renews_at
      ? toDate(row.subscription_renews_at)
      : null,
  };
}

function buildBillingSummary(user) {
  return {
    provider: stripe ? "stripe" : "manual",
    pricePerMonthUsd: STRIPE_MONTHLY_PRICE_USD,
    unlimited: isUnlimitedSubscriber(user),
    checkoutEnabled: Boolean(stripe),
    canManageBilling: Boolean(stripe && user.stripeCustomerId),
    cancelAtPeriodEnd: Boolean(user.cancelAtPeriodEnd),
    statusMessage: getStripeBillingStatusMessage(user),
  };
}

function getStripeBillingStatusMessage(user) {
  if (!stripe) {
    return "Stripe is off until a secret key is set in backend/builtInBillingConfig.js or STRIPE_SECRET_KEY in .env.";
  }

  if (isUnlimitedSubscriber(user)) {
    return "Unlimited solve/debug access is active through Stripe.";
  }

  if (!stripeWebhookConfigured) {
    return `$${STRIPE_MONTHLY_PRICE_USD}/month checkout is live. Add STRIPE_WEBHOOK_SECRET for automatic subscription sync.`;
  }

  return `$${STRIPE_MONTHLY_PRICE_USD}/month unlocks unlimited use.`;
}

function resolveConfiguredString(...values) {
  for (const value of values) {
    const normalized = normalizeConfiguredString(value);
    if (normalized) {
      return normalized;
    }
  }

  return "";
}

function normalizeConfiguredString(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }

  const lower = normalized.toLowerCase();
  if (
    lower.includes("replace_me") ||
    lower.includes("your_") ||
    lower.includes("paste_") ||
    lower === "sk_test_replace_me" ||
    lower === "whsec_replace_me"
  ) {
    return "";
  }

  return normalized;
}

async function buildUsageSnapshot(user) {
  const result = await query(
    `
      SELECT
        COALESCE(COUNT(*) FILTER (
          WHERE allowed AND action = 'solve' AND created_at::date = CURRENT_DATE
        ), 0)::int AS solves_today,
        COALESCE(COUNT(*) FILTER (
          WHERE allowed AND action = 'debug' AND created_at::date = CURRENT_DATE
        ), 0)::int AS debug_today,
        COALESCE(COUNT(*) FILTER (
          WHERE allowed AND action = 'screenshot' AND created_at::date = CURRENT_DATE
        ), 0)::int AS screenshots_today,
        COALESCE(COUNT(*) FILTER (
          WHERE NOT allowed AND created_at::date = CURRENT_DATE
        ), 0)::int AS blocked_attempts_today,
        COALESCE(COUNT(*) FILTER (
          WHERE allowed
            AND action IN ('solve', 'debug')
            AND created_at >= NOW() - INTERVAL '1 hour'
        ), 0)::int AS requests_this_hour,
        COALESCE(COUNT(*) FILTER (WHERE allowed AND action = 'solve'), 0)::int AS total_solve_count,
        COALESCE(COUNT(*) FILTER (WHERE allowed AND action = 'debug'), 0)::int AS total_debug_count,
        COALESCE(COUNT(*) FILTER (
          WHERE allowed AND action = 'screenshot'
        ), 0)::int AS total_screenshot_count,
        MAX(created_at) FILTER (WHERE allowed) AS last_usage_at
      FROM usage_events
      WHERE user_id = $1
    `,
    [user.id]
  );

  const row = result.rows[0];
  const solvesToday = asNumber(row.solves_today);
  const debugToday = asNumber(row.debug_today);
  const requestsThisHour = asNumber(row.requests_this_hour);

  return {
    solvesToday,
    debugToday,
    screenshotsToday: asNumber(row.screenshots_today),
    requestsThisHour,
    remainingSolveDaily: Math.max(0, user.rateLimits.solveDaily - solvesToday),
    remainingDebugDaily: Math.max(0, user.rateLimits.debugDaily - debugToday),
    remainingRequestsThisHour: Math.max(
      0,
      user.rateLimits.requestsPerHour - requestsThisHour
    ),
    totalSolveCount: asNumber(row.total_solve_count),
    totalDebugCount: asNumber(row.total_debug_count),
    totalScreenshotCount: asNumber(row.total_screenshot_count),
    blockedAttemptsToday: asNumber(row.blocked_attempts_today),
    lastUsageAt: toIso(row.last_usage_at),
  };
}

async function getRecentEvents(userId, limit) {
  const result = await query(
    `
      SELECT id, action, allowed, reason, created_at
      FROM usage_events
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [userId, limit]
  );

  return result.rows.map((row) => ({
    id: row.id,
    action: row.action,
    allowed: row.allowed,
    reason: row.reason || null,
    createdAt: toIso(row.created_at),
  }));
}

async function getDailyActivity(userId, days) {
  const result = await query(
    `
      WITH days AS (
        SELECT generate_series(
          CURRENT_DATE - ($2::int - 1) * INTERVAL '1 day',
          CURRENT_DATE,
          INTERVAL '1 day'
        )::date AS day
      )
      SELECT
        TO_CHAR(days.day, 'YYYY-MM-DD') AS day,
        COALESCE(COUNT(ue.id) FILTER (
          WHERE ue.allowed AND ue.action = 'solve'
        ), 0)::int AS solves,
        COALESCE(COUNT(ue.id) FILTER (
          WHERE ue.allowed AND ue.action = 'debug'
        ), 0)::int AS debug,
        COALESCE(COUNT(ue.id) FILTER (
          WHERE ue.allowed AND ue.action = 'screenshot'
        ), 0)::int AS screenshots,
        COALESCE(COUNT(ue.id) FILTER (
          WHERE NOT ue.allowed
        ), 0)::int AS blocked
      FROM days
      LEFT JOIN usage_events ue
        ON ue.user_id = $1
       AND ue.created_at::date = days.day
      GROUP BY days.day
      ORDER BY days.day
    `,
    [userId, days]
  );

  return result.rows.map((row) => ({
    day: row.day,
    solves: asNumber(row.solves),
    debug: asNumber(row.debug),
    screenshots: asNumber(row.screenshots),
    blocked: asNumber(row.blocked),
  }));
}

async function recordUsageEvent(userId, action, allowed, reason) {
  await query(
    `
      INSERT INTO usage_events (id, user_id, action, allowed, reason)
      VALUES ($1, $2, $3, $4, $5)
    `,
    [createId("evt"), userId, action, allowed, reason]
  );
}

async function evaluateUsage(user, action) {
  if (action === "screenshot") {
    return { allowed: true };
  }

  if (user.subscriptionStatus === "cancelled") {
    return {
      allowed: false,
      statusCode: 403,
      error: "Your subscription is cancelled. Reactivate the account to continue.",
    };
  }

  if (user.subscriptionStatus === "past_due") {
    return {
      allowed: false,
      statusCode: 403,
      error: "Your subscription is past due. Update billing before continuing.",
    };
  }

  if (user.subscriptionStatus === "suspended") {
    return {
      allowed: false,
      statusCode: 403,
      error: "Your account has been suspended. Contact support or an administrator.",
    };
  }

  if (isUnlimitedSubscriber(user)) {
    return { allowed: true };
  }

  const usage = await buildUsageSnapshot(user);

  if (usage.requestsThisHour >= user.rateLimits.requestsPerHour) {
    return {
      allowed: false,
      statusCode: 429,
      error: "Hourly request limit reached for this account.",
    };
  }

  if (action === "solve" && usage.solvesToday >= user.rateLimits.solveDaily) {
    return {
      allowed: false,
      statusCode: 429,
      error: "Daily solve limit reached for this account.",
    };
  }

  if (action === "debug" && usage.debugToday >= user.rateLimits.debugDaily) {
    return {
      allowed: false,
      statusCode: 429,
      error: "Daily debug limit reached for this account.",
    };
  }

  return { allowed: true };
}

async function buildAdminStats() {
  const userCountsResult = await query(
    `
      SELECT
        COUNT(*)::int AS users_total,
        COUNT(*) FILTER (
          WHERE subscription_status IN ('trial', 'active')
        )::int AS active_subscriptions,
        COUNT(*) FILTER (
          WHERE subscription_status = 'trial'
        )::int AS trial_subscriptions,
        COUNT(*) FILTER (
          WHERE subscription_plan = 'free'
        )::int AS free_count,
        COUNT(*) FILTER (
          WHERE subscription_plan = 'pro'
        )::int AS pro_count,
        COUNT(*) FILTER (
          WHERE subscription_plan = 'enterprise'
        )::int AS enterprise_count,
        COUNT(*) FILTER (
          WHERE subscription_status = 'trial'
        )::int AS status_trial,
        COUNT(*) FILTER (
          WHERE subscription_status = 'active'
        )::int AS status_active,
        COUNT(*) FILTER (
          WHERE subscription_status = 'past_due'
        )::int AS status_past_due,
        COUNT(*) FILTER (
          WHERE subscription_status = 'cancelled'
        )::int AS status_cancelled,
        COUNT(*) FILTER (
          WHERE subscription_status = 'suspended'
        )::int AS status_suspended,
        COALESCE(SUM(
          CASE
            WHEN subscription_status = 'active' AND subscription_plan = 'pro' THEN $1
            WHEN subscription_status = 'active' AND subscription_plan = 'enterprise' THEN 199
            ELSE 0
          END
        ), 0)::int AS monthly_recurring_revenue_estimate
      FROM app_users
    `,
    [Math.round(STRIPE_MONTHLY_PRICE_USD)]
  );

  const usageCountsResult = await query(
    `
      SELECT
        COUNT(*) FILTER (
          WHERE allowed AND action = 'solve' AND created_at::date = CURRENT_DATE
        )::int AS solves_today,
        COUNT(*) FILTER (
          WHERE allowed AND action = 'debug' AND created_at::date = CURRENT_DATE
        )::int AS debug_today,
        COUNT(*) FILTER (
          WHERE allowed AND action = 'screenshot' AND created_at::date = CURRENT_DATE
        )::int AS screenshots_today,
        COUNT(*) FILTER (
          WHERE NOT allowed AND created_at::date = CURRENT_DATE
        )::int AS rate_limit_hits_today
      FROM usage_events
    `
  );

  const users = userCountsResult.rows[0];
  const usage = usageCountsResult.rows[0];

  return {
    usersTotal: asNumber(users.users_total),
    activeSubscriptions: asNumber(users.active_subscriptions),
    trialSubscriptions: asNumber(users.trial_subscriptions),
    solvesToday: asNumber(usage.solves_today),
    debugToday: asNumber(usage.debug_today),
    screenshotsToday: asNumber(usage.screenshots_today),
    rateLimitHitsToday: asNumber(usage.rate_limit_hits_today),
    monthlyRecurringRevenueEstimate: asNumber(
      users.monthly_recurring_revenue_estimate
    ),
    plans: {
      free: asNumber(users.free_count),
      pro: asNumber(users.pro_count),
      enterprise: asNumber(users.enterprise_count),
    },
    statuses: {
      trial: asNumber(users.status_trial),
      active: asNumber(users.status_active),
      past_due: asNumber(users.status_past_due),
      cancelled: asNumber(users.status_cancelled),
      suspended: asNumber(users.status_suspended),
    },
  };
}

async function getAllUsersWithUsage() {
  const result = await query(
    `
      SELECT *
      FROM app_users
      ORDER BY created_at DESC
    `
  );

  const users = result.rows.map(mapUserRow);
  return Promise.all(
    users.map(async (user) => ({
      ...sanitizeUser(user),
      usage: await buildUsageSnapshot(user),
    }))
  );
}

async function getAdminEvents(limit) {
  const result = await query(
    `
      SELECT
        ue.id,
        ue.user_id,
        ue.action,
        ue.allowed,
        ue.reason,
        ue.created_at,
        u.name AS user_name,
        u.email AS user_email,
        u.subscription_plan,
        u.subscription_status
      FROM usage_events ue
      LEFT JOIN app_users u
        ON u.id = ue.user_id
      ORDER BY ue.created_at DESC
      LIMIT $1
    `,
    [limit]
  );

  return result.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    action: row.action,
    allowed: row.allowed,
    reason: row.reason || null,
    createdAt: toIso(row.created_at),
    user: row.user_email
      ? {
          id: row.user_id,
          email: row.user_email,
          name: row.user_name,
          subscriptionPlan: row.subscription_plan,
          subscriptionStatus: row.subscription_status,
        }
      : null,
  }));
}

async function requireUser(req) {
  const token = readBearerToken(req);
  const payload = verifyToken(token);

  if (!payload || payload.role !== "user") {
    return { ok: false, status: 401, error: "Authentication required." };
  }

  const user = await getUserById(payload.sub);
  if (!user) {
    return { ok: false, status: 401, error: "User session is no longer valid." };
  }

  return { ok: true, user };
}

async function requireAdmin(req) {
  const token = readBearerToken(req);
  const payload = verifyToken(token);

  if (!payload || payload.role !== "admin") {
    return { ok: false, status: 401, error: "Admin authentication required." };
  }

  const admin = await getAdminByEmail(payload.email);
  if (!admin || admin.id !== payload.sub) {
    return { ok: false, status: 401, error: "Admin session is no longer valid." };
  }

  return { ok: true, admin };
}

function readBearerToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeName(value) {
  return String(value || "").trim().slice(0, 80);
}

function createId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, encoded) {
  const [salt, storedHash] = String(encoded || "").split(":");
  if (!salt || !storedHash) {
    return false;
  }
  const computed = crypto.scryptSync(password, salt, 64);
  const stored = Buffer.from(storedHash, "hex");
  return (
    stored.length === computed.length && crypto.timingSafeEqual(stored, computed)
  );
}

function signToken(payload, ttlSeconds = 60 * 60 * 24 * 30) {
  const header = { alg: "HS256", typ: "JWT" };
  const body = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encodedBody = Buffer.from(JSON.stringify(body)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", TOKEN_SECRET)
    .update(`${encodedHeader}.${encodedBody}`)
    .digest("base64url");

  return `${encodedHeader}.${encodedBody}.${signature}`;
}

function verifyToken(token) {
  if (!token) {
    return null;
  }

  const parts = String(token).split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [encodedHeader, encodedBody, signature] = parts;
  const expectedSignature = crypto
    .createHmac("sha256", TOKEN_SECRET)
    .update(`${encodedHeader}.${encodedBody}`)
    .digest("base64url");

  const received = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (
    received.length !== expected.length ||
    !crypto.timingSafeEqual(received, expected)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encodedBody, "base64url").toString("utf8")
    );
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch (error) {
    return null;
  }
}

function clampLimit(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.max(1, Math.floor(number));
}

function isPlan(value) {
  return value === "free" || value === "pro" || value === "enterprise";
}

function isStatus(value) {
  return (
    value === "trial" ||
    value === "active" ||
    value === "past_due" ||
    value === "cancelled" ||
    value === "suspended"
  );
}

function isAction(value) {
  return value === "solve" || value === "debug" || value === "screenshot";
}

function isUnlimitedSubscriber(user) {
  return (
    (user.subscriptionPlan === "pro" || user.subscriptionPlan === "enterprise") &&
    (user.subscriptionStatus === "active" || user.subscriptionStatus === "trial")
  );
}

function normalizeBillingReturnStatus(value) {
  if (value === "cancelled" || value === "portal") {
    return value;
  }

  return "success";
}

function normalizePositiveNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function normalizePort(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toDate(value) {
  if (!value) {
    return null;
  }

  return value instanceof Date ? value : new Date(value);
}

function toIso(value) {
  const date = toDate(value);
  return date ? date.toISOString() : null;
}

module.exports = {
  prepareWorkerRuntime,
  server,
  startNodeServer,
};
