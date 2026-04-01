const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");
const dotenv = require("dotenv");
const { Client } = require("pg");
const Stripe = require("stripe");
const { getBuiltInStripeConfig } = require("./builtInBillingConfig");
const schemaSql = require("./schemaText");

const CURRENT_DIR =
  typeof __dirname === "string" ? __dirname : process.cwd();

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
const IS_RENDER = process.env.RENDER === "true";
const PLATFORM_PORT = normalizePort(process.env.PORT);

const HOST =
  PLATFORM_PORT != null || IS_RENDER
    ? "0.0.0.0"
    : process.env.BACKEND_HOST || process.env.HOST || "127.0.0.1";
const PORT =
  PLATFORM_PORT ||
  normalizePort(process.env.BACKEND_PORT) ||
  (IS_RENDER ? 10000 : 8787);
const PUBLIC_DIR = path.join(CURRENT_DIR, "public");
const MARKETING_PUBLIC_DIR = path.join(CURRENT_DIR, "..", "landing-static");
const MARKETING_PAGE_ROUTE_MAP = new Map([
  ["/", "index.html"],
  ["/blog", "blog/index.html"],
  ["/blogs", "blogs/index.html"],
  ["/changelog", "changelog/index.html"],
  ["/privacy", "privacy/index.html"],
  ["/research", "research/index.html"],
  ["/researches", "research/index.html"],
  ["/security", "security/index.html"],
  ["/terms", "terms/index.html"],
  ["/tos", "terms/index.html"],
  ["/terms-of-service", "terms/index.html"],
  ["/privacy-policy", "privacy/index.html"],
]);
const MIGRATE_ONLY = process.argv.includes("--migrate-only");
const TOKEN_SECRET =
  process.env.BACKEND_TOKEN_SECRET || "cheatbit-dev-secret";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me-now";
const DATABASE_URL =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  "postgresql://postgres:postgres@127.0.0.1:5432/cheatbit";
const USE_SSL =
  process.env.DATABASE_SSL === "true" || process.env.PGSSLMODE === "require";
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const DODO_PAYMENTS_API_KEY = resolveConfiguredString(
  process.env.DODO_PAYMENTS_API_KEY,
  process.env.DODO_API_KEY
);
const DODO_WEBHOOK_SECRET = resolveConfiguredString(
  process.env.DODO_PAYMENTS_WEBHOOK_SECRET,
  process.env.DODO_WEBHOOK_SECRET
);
const DODO_PRODUCT_ID = resolveConfiguredString(process.env.DODO_PRODUCT_ID);
const DODO_PRODUCT_NAME =
  resolveConfiguredString(process.env.DODO_PRODUCT_NAME) ||
  "Sylica AI Unlimited";
const DODO_MONTHLY_PRICE_USD = normalizePositiveNumber(
  process.env.DODO_MONTHLY_PRICE_USD,
  20
);
const DODO_ENVIRONMENT = normalizeDodoEnvironment(
  process.env.DODO_PAYMENTS_ENVIRONMENT || process.env.DODO_ENVIRONMENT
);
const DODO_API_BASE_URL =
  DODO_ENVIRONMENT === "test_mode"
    ? "https://test.dodopayments.com"
    : "https://live.dodopayments.com";
const TOGETHER_API_KEY = resolveConfiguredString(process.env.TOGETHER_API_KEY);
const MOBILE_CHAT_MODEL =
  resolveConfiguredString(process.env.MOBILE_CHAT_MODEL) ||
  "moonshotai/Kimi-K2.5";
const PHONE_PAIRING_TTL_MS = 10 * 60 * 1000;
const PHONE_RELAY_QR_VERSION = 1;
const PHONE_RELAY_EVENT_TYPES = new Set(["clipboard", "otp", "link", "note"]);
const PHONE_RELAY_SOURCES = new Set(["mobile", "desktop"]);
const STRIPE_SECRET_KEY = resolveConfiguredString(
  process.env.STRIPE_SECRET_KEY,
  builtInStripeConfig.secretKey
);
const STRIPE_WEBHOOK_SECRETS = resolveConfiguredString(
  process.env.STRIPE_WEBHOOK_SECRET,
  builtInStripeConfig.webhookSecret
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const STRIPE_PRICE_ID = resolveConfiguredString(
  process.env.STRIPE_PRICE_ID,
  builtInStripeConfig.priceId
);
const STRIPE_PRODUCT_NAME =
  resolveConfiguredString(
    process.env.STRIPE_PRODUCT_NAME,
    builtInStripeConfig.productName
  ) ||
  "Sylica AI Unlimited";
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
const GOOGLE_OAUTH_CLIENT_ID = resolveConfiguredString(
  process.env.GOOGLE_OAUTH_CLIENT_ID
);
const GOOGLE_OAUTH_CLIENT_SECRET = resolveConfiguredString(
  process.env.GOOGLE_OAUTH_CLIENT_SECRET
);
const NOTION_CLIENT_ID = resolveConfiguredString(process.env.NOTION_CLIENT_ID);
const NOTION_CLIENT_SECRET = resolveConfiguredString(
  process.env.NOTION_CLIENT_SECRET
);
const GOOGLE_OAUTH_REDIRECT_URI = `${BACKEND_PUBLIC_URL}/api/integrations/google/callback`;
const NOTION_OAUTH_REDIRECT_URI = `${BACKEND_PUBLIC_URL}/api/integrations/notion/callback`;
const INTEGRATION_ENCRYPTION_SECRET = resolveConfiguredString(
  process.env.INTEGRATION_ENCRYPTION_SECRET,
  TOKEN_SECRET
);
const GOOGLE_OAUTH_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events",
];
const NOTION_API_VERSION = "2025-09-03";

const PLAN_LIMITS = {
  free: { solveDaily: 20, debugDaily: 20, requestsPerHour: 20 },
  pro: { solveDaily: 1_000_000, debugDaily: 1_000_000, requestsPerHour: 1_000_000 },
  enterprise: { solveDaily: 2000, debugDaily: 800, requestsPerHour: 1200 },
};
const dodoBillingEnabled = Boolean(DODO_PAYMENTS_API_KEY);
const stripe = STRIPE_SECRET_KEY ? Stripe(STRIPE_SECRET_KEY) : null;
const stripeWebhookConfigured = Boolean(stripe && STRIPE_WEBHOOK_SECRETS.length > 0);
const activeBillingProvider = dodoBillingEnabled
  ? "dodo"
  : stripe
    ? "stripe"
    : "manual";
const BILLING_PRODUCT_NAME =
  activeBillingProvider === "dodo" ? DODO_PRODUCT_NAME : STRIPE_PRODUCT_NAME;
const BILLING_MONTHLY_PRICE_USD =
  activeBillingProvider === "dodo"
    ? DODO_MONTHLY_PRICE_USD
    : STRIPE_MONTHLY_PRICE_USD;
let databaseInitialized = false;
let workerInitializationPromise = null;
let nodeStartupPromise = null;
let dodoProductIdPromise = null;
let standardWebhooksModulePromise = null;

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
    const normalizedPath =
      pathname.length > 1 && pathname.endsWith("/")
        ? pathname.slice(0, -1)
        : pathname;

    if (req.method === "GET" && pathname === "/health") {
      const nowResult = await query(
        "SELECT NOW() AS now, current_database() AS database_name"
      );
      const row = nowResult.rows[0];
      sendJson(res, 200, {
        ok: true,
        service: "sylica-ai-backend",
        now: toIso(row.now),
        database: row.database_name,
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/researches") {
      const researches = await listPublishedResearchPosts(50);
      sendJson(res, 200, { researches });
      return;
    }

    if (
      (req.method === "GET" || req.method === "HEAD") &&
      (pathname === "/admin" ||
        pathname === "/dashboard" ||
        pathname === "/dashboard.html")
    ) {
      serveStatic(res, "dashboard.html", undefined, req.method === "HEAD");
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      const marketingPageFile = MARKETING_PAGE_ROUTE_MAP.get(normalizedPath);
      if (marketingPageFile) {
        serveMarketingStatic(
          res,
          marketingPageFile,
          undefined,
          req.method === "HEAD"
        );
        return;
      }

      const marketingAssetPath = resolveStaticFilePath(
        MARKETING_PUBLIC_DIR,
        pathname.slice(1)
      );
      if (
        marketingAssetPath &&
        fs.existsSync(marketingAssetPath) &&
        fs.statSync(marketingAssetPath).isFile()
      ) {
        serveStaticFile(
          res,
          marketingAssetPath,
          pathname,
          undefined,
          req.method === "HEAD"
        );
        return;
      }
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
      try {
        if (activeBillingProvider === "dodo") {
          const subscriptionId = String(
            url.searchParams.get("subscription_id") || ""
          ).trim();
          const paymentId = String(
            url.searchParams.get("payment_id") || ""
          ).trim();

          if (subscriptionId) {
            await syncDodoSubscriptionById(subscriptionId);
          } else if (paymentId) {
            await syncDodoPaymentById(paymentId);
          }
        } else if (url.searchParams.get("status") === "success") {
          const checkoutSessionId = String(
            url.searchParams.get("session_id") || ""
          ).trim();

          if (checkoutSessionId && stripe) {
            await syncCheckoutSessionById(checkoutSessionId);
          }
        }
      } catch (error) {
        console.error(
          `Failed to sync ${activeBillingProvider} checkout session on billing return:`,
          error
        );
      }

      serveBillingReturnPage(res, {
        status: String(url.searchParams.get("status") || "success"),
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/billing/webhook") {
      const rawBody = await parseRawBody(req);

      if (activeBillingProvider === "dodo") {
        if (!DODO_WEBHOOK_SECRET) {
          sendJson(res, 503, {
            error: "Dodo Payments webhooks are not configured on this backend.",
          });
          return;
        }

        let event;
        try {
          event = await verifyDodoWebhook(rawBody, req.headers);
        } catch (error) {
          console.error("Failed to verify Dodo webhook signature:", {
            message:
              error instanceof Error
                ? error.message
                : "Invalid Dodo Payments webhook signature.",
            hasWebhookId: Boolean(req.headers["webhook-id"]),
            hasWebhookSignature: Boolean(req.headers["webhook-signature"]),
            hasWebhookTimestamp: Boolean(req.headers["webhook-timestamp"]),
          });
          sendJson(res, 400, {
            error:
              error instanceof Error
                ? error.message
                : "Invalid Dodo Payments webhook signature.",
          });
          return;
        }

        try {
          await handleDodoWebhookEvent(event);
        } catch (error) {
          console.error("Failed to process Dodo webhook event:", {
            type: String(event?.type || ""),
            message:
              error instanceof Error
                ? error.message
                : "Unknown Dodo webhook processing error.",
          });
          sendJson(res, 500, {
            error:
              error instanceof Error
                ? error.message
                : "Failed to process Dodo Payments webhook.",
          });
          return;
        }

        sendJson(res, 200, { received: true });
        return;
      }

      if (!stripe || STRIPE_WEBHOOK_SECRETS.length === 0) {
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

      let event;
      for (const webhookSecret of STRIPE_WEBHOOK_SECRETS) {
        try {
          event = stripe.webhooks.constructEvent(
            rawBody,
            signature,
            webhookSecret
          );
          break;
        } catch (_error) {
          // Keep trying until one of the configured webhook secrets validates.
        }
      }

      if (!event) {
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

    if (req.method === "GET" && pathname === "/api/integrations/google/callback") {
      const code = String(url.searchParams.get("code") || "").trim();
      const state = String(url.searchParams.get("state") || "").trim();
      const errorCode = String(url.searchParams.get("error") || "").trim();

      if (errorCode) {
        serveIntegrationCallbackPage(res, {
          ok: false,
          title: "Google connection cancelled",
          description:
            "Google did not finish the connection. Return to Sylica AI and try again.",
        });
        return;
      }

      if (!code || !state) {
        serveIntegrationCallbackPage(res, {
          ok: false,
          title: "Google connection failed",
          description: "Missing OAuth code or state.",
        });
        return;
      }

      try {
        const statePayload = verifyIntegrationStateToken(state, "google");
        if (!statePayload) {
          throw new Error("This Google connection link is no longer valid.");
        }

        const tokenPayload = await exchangeGoogleAuthorizationCode(code);
        const profile = await fetchGoogleProfile(tokenPayload.access_token);
        await upsertUserIntegration({
          userId: statePayload.sub,
          provider: "google",
          accessToken: tokenPayload.access_token,
          refreshToken: tokenPayload.refresh_token || null,
          tokenType: tokenPayload.token_type || "Bearer",
          scopes: normalizeScopes(
            tokenPayload.scope
              ? tokenPayload.scope.split(/\s+/g)
              : GOOGLE_OAUTH_SCOPES
          ),
          accessTokenExpiresAt:
            typeof tokenPayload.expires_in === "number"
              ? new Date(Date.now() + tokenPayload.expires_in * 1000)
              : null,
          externalAccountId: profile.id || null,
          externalAccountEmail: profile.email || null,
          externalAccountName:
            profile.name || profile.given_name || profile.email || null,
          metadata: {
            picture: profile.picture || null,
          },
        });

        serveIntegrationCallbackPage(res, {
          ok: true,
          title: "Google connected",
          description:
            "Gmail and Google Calendar are now connected. Return to Sylica AI and refresh the account dashboard.",
        });
      } catch (error) {
        console.error("Google OAuth callback failed:", error);
        serveIntegrationCallbackPage(res, {
          ok: false,
          title: "Google connection failed",
          description:
            error instanceof Error
              ? error.message
              : "Failed to connect Google.",
        });
      }
      return;
    }

    if (req.method === "GET" && pathname === "/api/integrations/notion/callback") {
      const code = String(url.searchParams.get("code") || "").trim();
      const state = String(url.searchParams.get("state") || "").trim();
      const errorCode = String(url.searchParams.get("error") || "").trim();

      if (errorCode) {
        serveIntegrationCallbackPage(res, {
          ok: false,
          title: "Notion connection cancelled",
          description:
            "Notion did not finish the connection. Return to Sylica AI and try again.",
        });
        return;
      }

      if (!code || !state) {
        serveIntegrationCallbackPage(res, {
          ok: false,
          title: "Notion connection failed",
          description: "Missing OAuth code or state.",
        });
        return;
      }

      try {
        const statePayload = verifyIntegrationStateToken(state, "notion");
        if (!statePayload) {
          throw new Error("This Notion connection link is no longer valid.");
        }

        const tokenPayload = await exchangeNotionAuthorizationCode(code);
        await upsertUserIntegration({
          userId: statePayload.sub,
          provider: "notion",
          accessToken: tokenPayload.access_token,
          refreshToken: tokenPayload.refresh_token || null,
          tokenType: tokenPayload.token_type || "Bearer",
          scopes: [],
          accessTokenExpiresAt:
            typeof tokenPayload.expires_in === "number"
              ? new Date(Date.now() + tokenPayload.expires_in * 1000)
              : null,
          externalAccountId: tokenPayload.workspace_id || tokenPayload.bot_id || null,
          externalAccountEmail: null,
          externalAccountName: tokenPayload.workspace_name || null,
          metadata: {
            workspaceId: tokenPayload.workspace_id || null,
            workspaceName: tokenPayload.workspace_name || null,
            workspaceIcon: tokenPayload.workspace_icon || null,
            ownerType: tokenPayload.owner?.type || null,
            botId: tokenPayload.bot_id || null,
          },
        });

        serveIntegrationCallbackPage(res, {
          ok: true,
          title: "Notion connected",
          description:
            "Notion is now connected. Return to Sylica AI and refresh the account dashboard.",
        });
      } catch (error) {
        console.error("Notion OAuth callback failed:", error);
        serveIntegrationCallbackPage(res, {
          ok: false,
          title: "Notion connection failed",
          description:
            error instanceof Error
              ? error.message
              : "Failed to connect Notion.",
        });
      }
      return;
    }

    if (req.method === "GET" && pathname === "/api/integrations") {
      const auth = await requireUser(req);
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error });
        return;
      }

      const integrations = await listAppIntegrations(auth.user.id);
      sendJson(res, 200, { integrations });
      return;
    }

    if (req.method === "POST" && pathname === "/api/integrations/assistant-action") {
      const auth = await requireUser(req);
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error });
        return;
      }

      const body = await parseJsonBody(req);
      const message = normalizeChatContent(body.message);
      const chatHistory = Array.isArray(body.chatHistory)
        ? body.chatHistory
            .filter(
              (entry) =>
                entry &&
                (entry.role === "user" || entry.role === "assistant") &&
                typeof entry.content === "string"
            )
            .map((entry) => ({
              role: entry.role,
              content: normalizeChatContent(entry.content),
            }))
            .filter((entry) => entry.content)
            .slice(-10)
        : [];

      if (!message) {
        sendJson(res, 400, { error: "A message is required." });
        return;
      }

      const response = await handleIntegrationAssistantAction(auth.user, {
        message,
        chatHistory,
      });
      sendJson(res, 200, response);
      return;
    }

    const integrationConnectMatch = pathname.match(/^\/api\/integrations\/([^/]+)\/connect$/);
    if (req.method === "POST" && integrationConnectMatch) {
      const auth = await requireUser(req);
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error });
        return;
      }

      const provider = normalizeIntegrationProvider(integrationConnectMatch[1]);
      if (!provider) {
        sendJson(res, 400, { error: "A valid integration provider is required." });
        return;
      }

      const urlValue = createIntegrationConnectUrl(auth.user.id, provider);
      sendJson(res, 200, { provider, url: urlValue });
      return;
    }

    const integrationDeleteMatch = pathname.match(/^\/api\/integrations\/([^/]+)$/);
    if (req.method === "DELETE" && integrationDeleteMatch) {
      const auth = await requireUser(req);
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error });
        return;
      }

      const provider = normalizeIntegrationProvider(integrationDeleteMatch[1]);
      if (!provider) {
        sendJson(res, 400, { error: "A valid integration provider is required." });
        return;
      }

      await deleteUserIntegration(auth.user.id, provider);
      sendJson(res, 200, { success: true });
      return;
    }

    if (req.method === "POST" && pathname === "/api/phone/pairing-sessions") {
      const auth = await requireUser(req);
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error });
        return;
      }

      const body = await parseJsonBody(req);
      await expirePhonePairingSessions(auth.user.id);

      const pairingToken = createPhonePairingToken();
      const pairing = await createPhonePairingSession({
        id: createId("pair"),
        userId: auth.user.id,
        pairingTokenHash: hashPhonePairingToken(pairingToken),
        desktopDeviceName: normalizePhoneDeviceName(
          body.desktopDeviceName,
          "Sylica Desktop"
        ),
        expiresAt: new Date(Date.now() + PHONE_PAIRING_TTL_MS),
      });

      sendJson(res, 201, {
        pairing,
        manualCode: `${pairing.id}:${pairingToken}`,
        qrPayload: {
          type: "sylica-phone-pair",
          version: PHONE_RELAY_QR_VERSION,
          apiBaseUrl: BACKEND_PUBLIC_URL,
          pairingId: pairing.id,
          pairingToken,
        },
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/phone/pairing-sessions/complete") {
      const auth = await requireUser(req);
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error });
        return;
      }

      const body = await parseJsonBody(req);
      const pairingId = normalizeIdentifier(body.pairingId, 120);
      const pairingToken = normalizeIdentifier(
        body.pairingToken || body.token,
        256
      );

      if (!pairingId || !pairingToken) {
        sendJson(res, 400, {
          error: "Pairing id and pairing token are required.",
        });
        return;
      }

      await expirePhonePairingSessions(auth.user.id);
      const pairingRecord = await getPhonePairingSessionRecord(pairingId);

      if (!pairingRecord || pairingRecord.user_id !== auth.user.id) {
        sendJson(res, 404, { error: "Pairing session not found." });
        return;
      }

      if (pairingRecord.status === "paired") {
        sendJson(res, 200, {
          pairing: mapPhonePairingRow(pairingRecord),
        });
        return;
      }

      if (pairingRecord.status !== "pending") {
        sendJson(res, 409, {
          error: "This pairing session is no longer available.",
        });
        return;
      }

      const expiresAt = toDate(pairingRecord.expires_at);
      if (!expiresAt || expiresAt.getTime() <= Date.now()) {
        await markPhonePairingSessionExpired(pairingId);
        sendJson(res, 410, { error: "This pairing session has expired." });
        return;
      }

      if (
        pairingRecord.pairing_token_hash !==
        hashPhonePairingToken(pairingToken)
      ) {
        sendJson(res, 401, { error: "Invalid pairing token." });
        return;
      }

      const pairing = await markPhonePairingSessionPaired({
        pairingId,
        mobileDeviceName: normalizePhoneDeviceName(
          body.mobileDeviceName,
          "Sylica Mobile"
        ),
      });

      sendJson(res, 200, { pairing });
      return;
    }

    if (req.method === "GET" && pathname === "/api/phone/devices") {
      const auth = await requireUser(req);
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error });
        return;
      }

      await expirePhonePairingSessions(auth.user.id);
      const devices = await listPhonePairingDevices(auth.user.id);
      sendJson(res, 200, { devices });
      return;
    }

    if (pathname === "/api/phone/events") {
      const auth = await requireUser(req);
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error });
        return;
      }

      await expirePhonePairingSessions(auth.user.id);

      if (req.method === "GET") {
        const pairingId = normalizeIdentifier(url.searchParams.get("pairingId"), 120);
        const after = parseOptionalIsoDate(url.searchParams.get("after"));
        const events = await listPhoneRelayEvents(auth.user.id, {
          pairingId,
          after,
          limit: 40,
        });
        sendJson(res, 200, { events });
        return;
      }

      if (req.method === "POST") {
        const body = await parseJsonBody(req);
        const pairingId = normalizeIdentifier(body.pairingId, 120);
        const eventType = isPhoneRelayEventType(body.eventType)
          ? body.eventType
          : null;
        const source = isPhoneRelaySource(body.source) ? body.source : "mobile";

        if (!pairingId || !eventType) {
          sendJson(res, 400, {
            error: "A valid pairing id and relay event type are required.",
          });
          return;
        }

        const pairing = await getPhonePairingSessionForUser(pairingId, auth.user.id);
        if (!pairing) {
          sendJson(res, 404, { error: "Paired desktop not found." });
          return;
        }

        if (pairing.status !== "paired") {
          sendJson(res, 409, {
            error: "This paired desktop is not ready for relay events yet.",
          });
          return;
        }

        const payload = normalizePhoneRelayPayload(eventType, body.payload);
        if (!payload) {
          sendJson(res, 400, {
            error: "Relay event payload is missing required fields.",
          });
          return;
        }

        const event = await createPhoneRelayEvent({
          id: createId("pev"),
          userId: auth.user.id,
          pairingId,
          source,
          eventType,
          payload,
        });

        await touchPhonePairingSession(pairingId);
        sendJson(res, 201, { event });
        return;
      }
    }

    const phonePairingMatch = pathname.match(/^\/api\/phone\/pairing-sessions\/([^/]+)$/);
    if (req.method === "GET" && phonePairingMatch) {
      const auth = await requireUser(req);
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error });
        return;
      }

      await expirePhonePairingSessions(auth.user.id);
      const pairingId = decodeURIComponent(phonePairingMatch[1]);
      const pairing = await getPhonePairingSessionForUser(pairingId, auth.user.id);

      if (!pairing) {
        sendJson(res, 404, { error: "Pairing session not found." });
        return;
      }

      sendJson(res, 200, { pairing });
      return;
    }

    if (req.method === "GET" && pathname === "/api/chat/threads") {
      const auth = await requireUser(req);
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error });
        return;
      }

      const requestedMode = String(url.searchParams.get("mode") || "general");
      if (!isChatMode(requestedMode)) {
        sendJson(res, 400, { error: "A valid chat mode is required." });
        return;
      }

      const threads = await listChatThreads(auth.user.id, requestedMode);
      sendJson(res, 200, { threads });
      return;
    }

    if (req.method === "POST" && pathname === "/api/chat/threads") {
      const auth = await requireUser(req);
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error });
        return;
      }

      const body = await parseJsonBody(req);
      const mode = isChatMode(body.mode) ? body.mode : "general";
      const thread = await createChatThread({
        id: createId("thr"),
        userId: auth.user.id,
        mode,
        title: summarizeChatTitle(body.title),
      });

      sendJson(res, 201, { thread });
      return;
    }

    if (req.method === "POST" && pathname === "/api/mobile/chat/respond") {
      const auth = await requireUser(req);
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error });
        return;
      }

      const body = await parseJsonBody(req);
      const message = normalizeChatContent(body.message);
      const requestedThreadId = normalizeChatContent(body.threadId);

      if (!message) {
        sendJson(res, 400, { error: "A non-empty message is required." });
        return;
      }

      const decision = await evaluateUsage(auth.user, "solve");
      if (!decision.allowed) {
        await recordUsageEvent(auth.user.id, "solve", false, decision.error);
        sendJson(res, decision.statusCode || 429, {
          error: decision.error || "This account cannot send chat messages right now.",
          usage: await buildUsageSnapshot(auth.user),
        });
        return;
      }

      let thread = requestedThreadId
        ? await getChatThreadForUser(requestedThreadId, auth.user.id)
        : null;

      if (thread && thread.mode !== "general") {
        sendJson(res, 400, {
          error: "Mobile chat can only continue standard chat threads.",
        });
        return;
      }

      if (!thread) {
        thread = await createChatThread({
          id: createId("thr"),
          userId: auth.user.id,
          mode: "general",
          title: summarizeChatTitle(message),
        });
      }

      const userMessage = await appendChatMessage({
        id: createId("msg"),
        threadId: thread.id,
        userId: auth.user.id,
        role: "user",
        content: message,
      });

      let assistantReply;
      try {
        const recentMessages = await listChatMessages(thread.id, auth.user.id);
        assistantReply = await generateMobileAssistantReply({
          user: auth.user,
          latestMessage: message,
          recentMessages: recentMessages.slice(-12),
        });
      } catch (error) {
        console.error("Mobile chat reply generation failed:", error);
        sendJson(res, 503, {
          error:
            error instanceof Error
              ? error.message
              : "Mobile chat is not available right now.",
        });
        return;
      }

      const assistantMessage = await appendChatMessage({
        id: createId("msg"),
        threadId: thread.id,
        userId: auth.user.id,
        role: "assistant",
        content: assistantReply,
      });

      await recordUsageEvent(auth.user.id, "solve", true, null);
      const usage = await buildUsageSnapshot(auth.user);
      const refreshedThread = await getChatThreadForUser(thread.id, auth.user.id);

      sendJson(res, 200, {
        thread: refreshedThread || thread,
        userMessage,
        assistantMessage,
        usage,
      });
      return;
    }

    const chatMessagesMatch = pathname.match(/^\/api\/chat\/threads\/([^/]+)\/messages$/);
    if (chatMessagesMatch) {
      const auth = await requireUser(req);
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error });
        return;
      }

      const threadId = decodeURIComponent(chatMessagesMatch[1]);
      const thread = await getChatThreadForUser(threadId, auth.user.id);

      if (!thread) {
        sendJson(res, 404, { error: "Chat thread not found." });
        return;
      }

      if (req.method === "GET") {
        const messages = await listChatMessages(threadId, auth.user.id);
        sendJson(res, 200, { thread, messages });
        return;
      }

      if (req.method === "POST") {
        const body = await parseJsonBody(req);
        const role = isChatRole(body.role) ? body.role : null;
        const content = normalizeChatContent(body.content);

        if (!role || !content) {
          sendJson(res, 400, {
            error: "A valid role and non-empty message content are required.",
          });
          return;
        }

        const message = await appendChatMessage({
          id: createId("msg"),
          threadId,
          userId: auth.user.id,
          role,
          content,
        });
        const updatedThread = await getChatThreadForUser(threadId, auth.user.id);

        sendJson(res, 201, {
          thread: updatedThread,
          message,
        });
        return;
      }
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

      if (activeBillingProvider === "manual") {
        sendJson(res, 503, {
          error: "Billing is not configured on this backend.",
        });
        return;
      }

      const checkoutSession =
        activeBillingProvider === "dodo"
          ? await createDodoCheckoutSession(auth.user)
          : await createStripeCheckoutSession(auth.user);
      sendJson(res, 200, { url: checkoutSession.url });
      return;
    }

    if (req.method === "POST" && pathname === "/api/billing/portal-session") {
      const auth = await requireUser(req);
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error });
        return;
      }

      if (activeBillingProvider === "manual") {
        sendJson(res, 503, {
          error: "Billing is not configured on this backend.",
        });
        return;
      }

      const portalSession =
        activeBillingProvider === "dodo"
          ? await createDodoPortalSession(auth.user)
          : await createStripePortalSession(auth.user);
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

      if (req.method === "GET" && pathname === "/api/admin/researches") {
        const researches = await listAdminResearchPosts(100);
        sendJson(res, 200, { researches });
        return;
      }

      if (req.method === "POST" && pathname === "/api/admin/researches") {
        const body = await parseJsonBody(req);
        const title = normalizeResearchTitle(body.title);
        const content = normalizeResearchContent(body.content);
        const summary = normalizeResearchSummary(body.summary, content);
        const authorName =
          normalizeResearchAuthorName(body.authorName) || "Sylica AI Research";

        if (!title || !content || !summary) {
          sendJson(res, 400, {
            error: "Title and content are required to publish research.",
          });
          return;
        }

        const research = await createResearchPost({
          id: createId("res"),
          slug: await buildUniqueResearchSlug(title),
          title,
          summary,
          content,
          authorName,
          createdByAdminId: auth.admin.id,
        });

        sendJson(res, 201, { research });
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
        `Sylica AI PostgreSQL migration complete: ${describeDatabaseTarget()}`
      );
      return;
    }

    if (!server.listening) {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(PORT, HOST, () => {
          server.removeListener("error", reject);
          console.log(
            `Sylica AI backend listening on http://${HOST}:${PORT} (dashboard at /admin)`
          );
          console.log(`PostgreSQL: ${describeDatabaseTarget()}`);
          console.log(`Admin login: ${ADMIN_EMAIL}`);
          if (activeBillingProvider === "dodo") {
            console.log(
              `Dodo Payments billing: checkout enabled${DODO_WEBHOOK_SECRET ? " with webhook sync" : " without webhook sync"}`
            );
          } else if (stripe) {
            console.log(
              `Stripe billing: checkout enabled${stripeWebhookConfigured ? " with webhook sync" : " without webhook sync"}`
            );
          } else {
            console.warn(
              "Billing disabled. Set DODO_PAYMENTS_API_KEY or STRIPE_SECRET_KEY in .env."
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
    path.join(CURRENT_DIR, ".env"),
    path.join(CURRENT_DIR, "..", ".env"),
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

  if (
    process.env.DODO_PAYMENTS_API_KEY ||
    process.env.DODO_API_KEY ||
    process.env.DISABLE_STRIPE_BILLING === "true"
  ) {
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
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PATCH, DELETE, OPTIONS, HEAD"
  );
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
  serveStaticFromDir(res, PUBLIC_DIR, fileName, contentType, headOnly);
}

function serveMarketingStatic(res, fileName, contentType, headOnly = false) {
  serveStaticFromDir(res, MARKETING_PUBLIC_DIR, fileName, contentType, headOnly);
}

function serveStaticFromDir(res, rootDir, fileName, contentType, headOnly = false) {
  const filePath = resolveStaticFilePath(rootDir, fileName);
  if (!filePath) {
    sendJson(res, 404, { error: "Static asset not found." });
    return;
  }

  serveStaticFile(res, filePath, fileName, contentType, headOnly);
}

function resolveStaticFilePath(rootDir, fileName) {
  const normalized = path.posix
    .normalize(`/${String(fileName || "").replace(/^\/+/, "")}`)
    .replace(/^\/+/, "");

  if (!normalized || normalized.startsWith("..")) {
    return null;
  }

  const resolvedPath = path.join(rootDir, normalized);
  const relativePath = path.relative(rootDir, resolvedPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return null;
  }

  return resolvedPath;
}

function serveStaticFile(
  res,
  filePath,
  fileName,
  contentType,
  headOnly = false
) {
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
      ? "Your Sylica AI subscription has been updated. Return to the app and refresh the dashboard."
      : status === "cancelled"
      ? "The checkout was cancelled. You can return to the app and try again at any time."
      : "You can return to Sylica AI now.";
  const appUrl = `sylica-ai://billing/return?status=${encodeURIComponent(
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
      <a href="${escapeHtml(appUrl)}">Return to Sylica AI</a>
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

function serveIntegrationCallbackPage(res, options) {
  const title = options.ok ? options.title || "Connected" : options.title || "Connection failed";
  const description = options.description || "Return to Sylica AI and refresh the dashboard.";
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
        margin: 0;
        line-height: 1.6;
        color: rgba(255, 255, 255, 0.72);
      }
      .badge {
        display: inline-flex;
        margin-bottom: 14px;
        padding: 8px 12px;
        border-radius: 999px;
        background: ${options.ok ? "rgba(125, 249, 199, 0.16)" : "rgba(248, 113, 113, 0.16)"};
        color: ${options.ok ? "#7df9c7" : "#fca5a5"};
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="badge">${options.ok ? "Connected" : "Action needed"}</div>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(description)}</p>
    </main>
  </body>
</html>`;

  res.writeHead(options.ok ? 200 : 400, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
  });
  res.end(html);
}

function encryptSensitiveValue(value) {
  const text = String(value || "");
  if (!text) {
    return "";
  }

  const key = crypto
    .createHash("sha256")
    .update(INTEGRATION_ENCRYPTION_SECRET)
    .digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64url");
}

function decryptSensitiveValue(value) {
  const encoded = String(value || "").trim();
  if (!encoded) {
    return "";
  }

  const raw = Buffer.from(encoded, "base64url");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const key = crypto
    .createHash("sha256")
    .update(INTEGRATION_ENCRYPTION_SECRET)
    .digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString("utf8");
}

async function createDodoCheckoutSession(user) {
  if (!dodoBillingEnabled) {
    throw new Error("Dodo Payments is not configured on this backend.");
  }

  const productId = await resolveDodoProductId();
  const session = await dodoApiRequest("POST", "/checkouts", {
    product_cart: [
      {
        product_id: productId,
        quantity: 1,
      },
    ],
    customer: {
      email: user.email,
      name: user.name,
    },
    return_url: BILLING_RETURN_URL,
    metadata: {
      appUserId: user.id,
      appUserEmail: user.email,
    },
  });

  const checkoutUrl = String(
    session.checkout_url || session.payment_link || session.url || ""
  ).trim();
  if (!checkoutUrl) {
    throw new Error("Dodo Payments did not return a checkout URL.");
  }

  return { url: checkoutUrl };
}

async function createDodoPortalSession(user) {
  if (!dodoBillingEnabled) {
    throw new Error("Dodo Payments is not configured on this backend.");
  }

  const customerId = String(user.dodoCustomerId || "").trim();
  if (!customerId) {
    throw new Error(
      "No Dodo customer was found for this account yet. Complete checkout once before opening billing."
    );
  }

  const session = await dodoApiRequest(
    "POST",
    `/customers/${encodeURIComponent(customerId)}/customer-portal/session`
  );
  const portalUrl = String(
    session.link || session.url || session.customer_portal_url || ""
  ).trim();

  if (!portalUrl) {
    throw new Error("Dodo Payments did not return a billing portal URL.");
  }

  return { url: portalUrl };
}

async function verifyDodoWebhook(rawBody, headers) {
  if (!DODO_WEBHOOK_SECRET) {
    throw new Error("Dodo Payments webhook secret is missing.");
  }

  const webhookHeaders = {
    "webhook-id": String(headers["webhook-id"] || ""),
    "webhook-signature": String(headers["webhook-signature"] || ""),
    "webhook-timestamp": String(headers["webhook-timestamp"] || ""),
  };

  if (
    !webhookHeaders["webhook-id"] ||
    !webhookHeaders["webhook-signature"] ||
    !webhookHeaders["webhook-timestamp"]
  ) {
    throw new Error("Missing Dodo Payments webhook verification headers.");
  }

  if (!standardWebhooksModulePromise) {
    standardWebhooksModulePromise = import("standardwebhooks");
  }

  const { Webhook } = await standardWebhooksModulePromise;
  const verifier = new Webhook(DODO_WEBHOOK_SECRET);
  const payload = verifier.verify(rawBody.toString("utf8"), webhookHeaders);
  return typeof payload === "string" ? JSON.parse(payload) : payload;
}

async function handleDodoWebhookEvent(event) {
  const eventType = String(event?.type || "");
  const payload = event?.data || {};

  if (eventType.startsWith("subscription.")) {
    await syncDodoSubscriptionObject(payload);
    return;
  }

  if (eventType.startsWith("payment.")) {
    const subscriptionId = extractDodoId(
      payload.subscription_id,
      payload.subscription?.subscription_id,
      payload.subscription?.id
    );

    if (subscriptionId) {
      await syncDodoSubscriptionById(subscriptionId);
      return;
    }

    const paymentId = extractDodoId(payload.payment_id, payload.id);
    if (paymentId) {
      await syncDodoPaymentById(paymentId);
    }
  }
}

async function syncDodoPaymentById(paymentId, hintedUserId = null) {
  if (!dodoBillingEnabled || !paymentId) {
    return null;
  }

  const payment = await dodoApiRequest(
    "GET",
    `/payments/${encodeURIComponent(paymentId)}`
  );
  const subscriptionId = extractDodoId(
    payment.subscription_id,
    payment.subscription?.subscription_id,
    payment.subscription?.id
  );
  const customerId = extractDodoId(
    payment.customer_id,
    payment.customer?.customer_id,
    payment.customer?.id
  );
  const metadataUserId =
    payment.metadata?.appUserId || payment.metadata?.app_user_id || hintedUserId;

  if (subscriptionId) {
    return syncDodoSubscriptionById(subscriptionId, metadataUserId, customerId);
  }

  if (customerId && metadataUserId) {
    return updateUserBillingState(metadataUserId, {
      dodoCustomerId: customerId,
      subscriptionSource: "dodo",
    });
  }

  return null;
}

async function syncDodoSubscriptionById(
  subscriptionId,
  hintedUserId = null,
  hintedCustomerId = null
) {
  if (!dodoBillingEnabled || !subscriptionId) {
    return null;
  }

  const subscription = await dodoApiRequest(
    "GET",
    `/subscriptions/${encodeURIComponent(subscriptionId)}`
  );
  return syncDodoSubscriptionObject(subscription, hintedUserId, hintedCustomerId);
}

async function syncDodoSubscriptionObject(
  subscription,
  hintedUserId = null,
  hintedCustomerId = null
) {
  const subscriptionId = extractDodoId(
    subscription.subscription_id,
    subscription.id
  );
  const customerId = extractDodoId(
    hintedCustomerId,
    subscription.customer_id,
    subscription.customer?.customer_id,
    subscription.customer?.id
  );
  const customerEmail = normalizeEmail(
    subscription.customer?.email || subscription.customer_email || ""
  );
  let user = hintedUserId ? await getUserById(hintedUserId) : null;

  if (!user && subscription.metadata?.appUserId) {
    user = await getUserById(subscription.metadata.appUserId);
  }
  if (!user && customerId) {
    user = await getUserByDodoCustomerId(customerId);
  }
  if (!user && subscriptionId) {
    user = await getUserByDodoSubscriptionId(subscriptionId);
  }
  if (!user && customerEmail) {
    user = await getUserByEmail(customerEmail);
  }

  if (!user) {
    console.warn(
      `Dodo subscription ${subscriptionId || "(unknown)"} could not be matched to an app user.`
    );
    return null;
  }

  const mappedStatus = mapDodoSubscriptionStatus(subscription.status);
  const activePlan =
    mappedStatus === "active" || mappedStatus === "trial" || mappedStatus === "past_due"
      ? "pro"
      : "free";

  return updateUserBillingState(user.id, {
    subscriptionPlan: activePlan,
    subscriptionStatus: mappedStatus,
    subscriptionSource: activePlan === "pro" ? "dodo" : "manual",
    rateLimits: activePlan === "pro" ? PLAN_LIMITS.pro : PLAN_LIMITS.free,
    subscriptionStartedAt:
      parseDodoDate(
        subscription.current_period_start,
        subscription.billing_cycle_anchor,
        subscription.created_at
      ) ||
      user.subscriptionStartedAt ||
      new Date(),
    subscriptionRenewsAt: parseDodoDate(
      subscription.current_period_end,
      subscription.next_billing_date,
      subscription.renews_at
    ),
    dodoCustomerId: customerId,
    dodoSubscriptionId: subscriptionId,
    dodoProductId: extractDodoId(
      subscription.product_id,
      subscription.product?.product_id,
      subscription.product?.id
    ),
    cancelAtPeriodEnd: Boolean(
      subscription.cancel_at_period_end ||
        subscription.cancel_at_next_billing_date ||
        subscription.cancelled_at
    ),
  });
}

function mapDodoSubscriptionStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();

  if (normalized === "active") {
    return "active";
  }

  if (
    normalized === "trialing" ||
    normalized === "trial" ||
    normalized === "pending"
  ) {
    return "trial";
  }

  if (normalized === "past_due" || normalized === "on_hold") {
    return "past_due";
  }

  if (normalized === "failed" || normalized === "suspended") {
    return "suspended";
  }

  return "cancelled";
}

async function resolveDodoProductId() {
  if (DODO_PRODUCT_ID) {
    return DODO_PRODUCT_ID;
  }

  if (!dodoProductIdPromise) {
    dodoProductIdPromise = (async () => {
      const response = await dodoApiRequest(
        "GET",
        "/products?page_size=100&recurring=true"
      );
      const products = Array.isArray(response.items)
        ? response.items
        : Array.isArray(response.data)
          ? response.data
          : [];

      if (products.length === 1) {
        const onlyProductId = extractDodoId(
          products[0].product_id,
          products[0].id
        );
        if (onlyProductId) {
          return onlyProductId;
        }
      }

      throw new Error(
        "Set DODO_PRODUCT_ID in backend env, or keep exactly one recurring product in Dodo Payments."
      );
    })().catch((error) => {
      dodoProductIdPromise = null;
      throw error;
    });
  }

  return dodoProductIdPromise;
}

async function dodoApiRequest(method, requestPath, body) {
  if (!DODO_PAYMENTS_API_KEY) {
    throw new Error("Dodo Payments API key is missing.");
  }

  const response = await fetch(`${DODO_API_BASE_URL}${requestPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${DODO_PAYMENTS_API_KEY}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const responseText = await response.text();
  const data = responseText ? safeParseJson(responseText) : null;

  if (!response.ok) {
    const apiMessage =
      data?.message ||
      data?.error?.message ||
      data?.detail ||
      data?.error ||
      `Dodo Payments request failed with status ${response.status}.`;
    throw new Error(String(apiMessage));
  }

  return data || {};
}

function parseDodoDate(...values) {
  for (const value of values) {
    if (!value) {
      continue;
    }

    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  return null;
}

function extractDodoId(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }

    if (value && typeof value === "object") {
      const nested =
        value.id ||
        value.subscription_id ||
        value.customer_id ||
        value.product_id ||
        "";
      if (typeof nested === "string" && nested.trim()) {
        return nested.trim();
      }
    }
  }

  return "";
}

function safeParseJson(value) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
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

async function getUserByDodoCustomerId(customerId) {
  const result = await query(
    `
      SELECT *
      FROM app_users
      WHERE dodo_customer_id = $1
      LIMIT 1
    `,
    [customerId]
  );

  return result.rows[0] ? mapUserRow(result.rows[0]) : null;
}

async function getUserByDodoSubscriptionId(subscriptionId) {
  const result = await query(
    `
      SELECT *
      FROM app_users
      WHERE dodo_subscription_id = $1
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
        dodo_customer_id = $14,
        dodo_subscription_id = $15,
        dodo_product_id = $16,
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
      hasField("dodoCustomerId")
        ? input.dodoCustomerId
        : existing.dodoCustomerId,
      hasField("dodoSubscriptionId")
        ? input.dodoSubscriptionId
        : existing.dodoSubscriptionId,
      hasField("dodoProductId") ? input.dodoProductId : existing.dodoProductId,
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
    integrations: await listAppIntegrations(user.id),
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
    dodoCustomerId: row.dodo_customer_id || null,
    dodoSubscriptionId: row.dodo_subscription_id || null,
    dodoProductId: row.dodo_product_id || null,
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

function mapResearchRow(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    content: row.content,
    authorName: row.author_name || "Sylica AI Research",
    createdByAdminId: row.created_by_admin_id || null,
    publishedAt: toIso(row.published_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

async function listPublishedResearchPosts(limit = 50) {
  const result = await query(
    `
      SELECT *
      FROM research_posts
      WHERE published_at IS NOT NULL
      ORDER BY published_at DESC, created_at DESC
      LIMIT $1
    `,
    [limit]
  );

  return result.rows.map(mapResearchRow);
}

async function listAdminResearchPosts(limit = 100) {
  const result = await query(
    `
      SELECT *
      FROM research_posts
      ORDER BY published_at DESC, created_at DESC
      LIMIT $1
    `,
    [limit]
  );

  return result.rows.map(mapResearchRow);
}

async function createResearchPost(input) {
  const result = await query(
    `
      INSERT INTO research_posts (
        id,
        slug,
        title,
        summary,
        content,
        author_name,
        created_by_admin_id,
        published_at,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW(), NOW())
      RETURNING *
    `,
    [
      input.id,
      input.slug,
      input.title,
      input.summary,
      input.content,
      input.authorName || null,
      input.createdByAdminId || null,
    ]
  );

  return mapResearchRow(result.rows[0]);
}

function mapUserIntegrationRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    status: row.status,
    accessTokenEncrypted: row.access_token_encrypted,
    refreshTokenEncrypted: row.refresh_token_encrypted || null,
    tokenType: row.token_type || null,
    scopes: String(row.scopes || "")
      .split(/\s+/g)
      .map((value) => value.trim())
      .filter(Boolean),
    accessTokenExpiresAt: row.access_token_expires_at
      ? toDate(row.access_token_expires_at)
      : null,
    externalAccountId: row.external_account_id || null,
    externalAccountEmail: row.external_account_email || null,
    externalAccountName: row.external_account_name || null,
    metadata:
      row.metadata_json && typeof row.metadata_json === "object"
        ? row.metadata_json
        : {},
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    lastUsedAt: row.last_used_at ? toDate(row.last_used_at) : null,
  };
}

async function listUserIntegrationRows(userId) {
  const result = await query(
    `
      SELECT *
      FROM user_integrations
      WHERE user_id = $1
      ORDER BY updated_at DESC, created_at DESC
    `,
    [userId]
  );

  return result.rows.map(mapUserIntegrationRow);
}

async function getUserIntegration(userId, provider) {
  const result = await query(
    `
      SELECT *
      FROM user_integrations
      WHERE user_id = $1
        AND provider = $2
      LIMIT 1
    `,
    [userId, provider]
  );

  return result.rows[0] ? mapUserIntegrationRow(result.rows[0]) : null;
}

async function upsertUserIntegration(input) {
  const result = await query(
    `
      INSERT INTO user_integrations (
        id,
        user_id,
        provider,
        status,
        access_token_encrypted,
        refresh_token_encrypted,
        token_type,
        scopes,
        access_token_expires_at,
        external_account_id,
        external_account_email,
        external_account_name,
        metadata_json,
        created_at,
        updated_at,
        last_used_at
      )
      VALUES (
        $1, $2, $3, 'connected', $4, $5, $6, $7, $8,
        $9, $10, $11, $12::jsonb, NOW(), NOW(), NOW()
      )
      ON CONFLICT (user_id, provider)
      DO UPDATE SET
        status = 'connected',
        access_token_encrypted = EXCLUDED.access_token_encrypted,
        refresh_token_encrypted = COALESCE(
          EXCLUDED.refresh_token_encrypted,
          user_integrations.refresh_token_encrypted
        ),
        token_type = COALESCE(EXCLUDED.token_type, user_integrations.token_type),
        scopes = EXCLUDED.scopes,
        access_token_expires_at = EXCLUDED.access_token_expires_at,
        external_account_id = COALESCE(
          EXCLUDED.external_account_id,
          user_integrations.external_account_id
        ),
        external_account_email = COALESCE(
          EXCLUDED.external_account_email,
          user_integrations.external_account_email
        ),
        external_account_name = COALESCE(
          EXCLUDED.external_account_name,
          user_integrations.external_account_name
        ),
        metadata_json = EXCLUDED.metadata_json,
        updated_at = NOW(),
        last_used_at = NOW()
      RETURNING *
    `,
    [
      createId("int"),
      input.userId,
      input.provider,
      encryptSensitiveValue(input.accessToken),
      input.refreshToken ? encryptSensitiveValue(input.refreshToken) : null,
      input.tokenType || null,
      normalizeScopes(input.scopes || []),
      input.accessTokenExpiresAt || null,
      input.externalAccountId || null,
      input.externalAccountEmail || null,
      input.externalAccountName || null,
      JSON.stringify(input.metadata || {}),
    ]
  );

  return mapUserIntegrationRow(result.rows[0]);
}

async function updateUserIntegrationTokens(id, input) {
  const result = await query(
    `
      UPDATE user_integrations
      SET
        status = 'connected',
        access_token_encrypted = $2,
        refresh_token_encrypted = COALESCE($3, refresh_token_encrypted),
        token_type = COALESCE($4, token_type),
        scopes = CASE
          WHEN $5::text = '' THEN scopes
          ELSE $5::text
        END,
        access_token_expires_at = $6,
        updated_at = NOW(),
        last_used_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [
      id,
      encryptSensitiveValue(input.accessToken),
      input.refreshToken ? encryptSensitiveValue(input.refreshToken) : null,
      input.tokenType || null,
      normalizeScopes(input.scopes || []),
      input.accessTokenExpiresAt || null,
    ]
  );

  return result.rows[0] ? mapUserIntegrationRow(result.rows[0]) : null;
}

async function deleteUserIntegration(userId, provider) {
  await query(
    `
      DELETE FROM user_integrations
      WHERE user_id = $1
        AND provider = $2
    `,
    [userId, provider]
  );
}

async function markUserIntegrationUsed(id) {
  await query(
    `
      UPDATE user_integrations
      SET
        last_used_at = NOW(),
        updated_at = updated_at
      WHERE id = $1
    `,
    [id]
  );
}

function isGoogleIntegrationConfigured() {
  return Boolean(GOOGLE_OAUTH_CLIENT_ID && GOOGLE_OAUTH_CLIENT_SECRET);
}

function isNotionIntegrationConfigured() {
  return Boolean(NOTION_CLIENT_ID && NOTION_CLIENT_SECRET);
}

function normalizeIntegrationProvider(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (
    normalized === "google" ||
    normalized === "gmail" ||
    normalized === "google_calendar" ||
    normalized === "calendar"
  ) {
    return "google";
  }

  if (normalized === "notion") {
    return "notion";
  }

  return null;
}

function buildConnectedAppIntegration(options) {
  return {
    app: options.app,
    provider: options.provider,
    label: options.label,
    connected: Boolean(options.connected),
    configured: Boolean(options.configured),
    statusText: options.statusText,
    accountEmail: options.accountEmail || null,
    accountName: options.accountName || null,
    workspaceName: options.workspaceName || null,
    connectedAt: toIso(options.connectedAt || null),
    lastSyncedAt: toIso(options.lastSyncedAt || null),
    supports: Array.isArray(options.supports) ? options.supports : [],
    sharedConnectionLabel: options.sharedConnectionLabel || null,
  };
}

async function listAppIntegrations(userId) {
  const rows = await listUserIntegrationRows(userId);
  const google = rows.find((row) => row.provider === "google") || null;
  const notion = rows.find((row) => row.provider === "notion") || null;

  return [
    buildConnectedAppIntegration({
      app: "gmail",
      provider: "google",
      label: "Gmail",
      connected: Boolean(google),
      configured: isGoogleIntegrationConfigured(),
      statusText: google
        ? `Connected as ${google.externalAccountEmail || google.externalAccountName || "your Google account"}.`
        : isGoogleIntegrationConfigured()
        ? "Connect Google once to search Gmail and draft or send email."
        : "Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in the backend env.",
      accountEmail: google?.externalAccountEmail || null,
      accountName: google?.externalAccountName || null,
      connectedAt: google?.createdAt || null,
      lastSyncedAt: google?.updatedAt || null,
      supports: ["Search recent email", "Draft email", "Send email"],
      sharedConnectionLabel: "Shared Google connection",
    }),
    buildConnectedAppIntegration({
      app: "google_calendar",
      provider: "google",
      label: "Google Calendar",
      connected: Boolean(google),
      configured: isGoogleIntegrationConfigured(),
      statusText: google
        ? `Connected as ${google.externalAccountEmail || google.externalAccountName || "your Google account"}.`
        : isGoogleIntegrationConfigured()
        ? "Connect Google once to list upcoming events and create calendar events."
        : "Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in the backend env.",
      accountEmail: google?.externalAccountEmail || null,
      accountName: google?.externalAccountName || null,
      connectedAt: google?.createdAt || null,
      lastSyncedAt: google?.updatedAt || null,
      supports: ["Show upcoming events", "Create calendar events"],
      sharedConnectionLabel: "Shared Google connection",
    }),
    buildConnectedAppIntegration({
      app: "notion",
      provider: "notion",
      label: "Notion",
      connected: Boolean(notion),
      configured: isNotionIntegrationConfigured(),
      statusText: notion
        ? `Connected to ${notion.metadata?.workspaceName || notion.externalAccountName || "your Notion workspace"}.`
        : isNotionIntegrationConfigured()
        ? "Connect Notion to search pages and create workspace pages."
        : "Set NOTION_CLIENT_ID and NOTION_CLIENT_SECRET in the backend env.",
      accountEmail: notion?.externalAccountEmail || null,
      accountName: notion?.externalAccountName || null,
      workspaceName: notion?.metadata?.workspaceName || notion?.externalAccountName || null,
      connectedAt: notion?.createdAt || null,
      lastSyncedAt: notion?.updatedAt || null,
      supports: ["Search pages", "Create pages"],
    }),
  ];
}

function createIntegrationConnectUrl(userId, provider) {
  if (provider === "google") {
    if (!isGoogleIntegrationConfigured()) {
      throw new Error(
        "Google OAuth is not configured on the backend. Add GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET."
      );
    }

    const params = new URLSearchParams({
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
      response_type: "code",
      access_type: "offline",
      include_granted_scopes: "true",
      prompt: "consent",
      scope: GOOGLE_OAUTH_SCOPES.join(" "),
      state: signIntegrationStateToken(userId, "google"),
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  if (provider === "notion") {
    if (!isNotionIntegrationConfigured()) {
      throw new Error(
        "Notion OAuth is not configured on the backend. Add NOTION_CLIENT_ID and NOTION_CLIENT_SECRET."
      );
    }

    const params = new URLSearchParams({
      client_id: NOTION_CLIENT_ID,
      redirect_uri: NOTION_OAUTH_REDIRECT_URI,
      response_type: "code",
      owner: "user",
      state: signIntegrationStateToken(userId, "notion"),
    });

    return `https://api.notion.com/v1/oauth/authorize?${params.toString()}`;
  }

  throw new Error("Unsupported integration provider.");
}

function signIntegrationStateToken(userId, provider) {
  return signToken(
    {
      sub: userId,
      role: "integration_oauth",
      provider,
    },
    60 * 15
  );
}

function verifyIntegrationStateToken(token, provider) {
  const payload = verifyToken(token);
  if (!payload || payload.role !== "integration_oauth") {
    return null;
  }

  if (payload.provider !== provider) {
    return null;
  }

  return payload;
}

function normalizeScopes(scopes) {
  return Array.from(
    new Set(
      (Array.isArray(scopes) ? scopes : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  ).join(" ");
}

async function exchangeGoogleAuthorizationCode(code) {
  return requestExternalJson(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_OAUTH_CLIENT_ID,
        client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
        redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
        grant_type: "authorization_code",
      }).toString(),
    },
    "Failed to exchange the Google authorization code."
  );
}

async function refreshGoogleAccessToken(refreshToken) {
  return requestExternalJson(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: GOOGLE_OAUTH_CLIENT_ID,
        client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    },
    "Failed to refresh the Google connection."
  );
}

async function exchangeNotionAuthorizationCode(code) {
  return requestExternalJson(
    "https://api.notion.com/v1/oauth/token",
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${NOTION_CLIENT_ID}:${NOTION_CLIENT_SECRET}`
        ).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: NOTION_OAUTH_REDIRECT_URI,
      }),
    },
    "Failed to exchange the Notion authorization code."
  );
}

async function requestExternalJson(urlValue, options, fallbackMessage) {
  const response = await fetch(urlValue, options);
  const text = await response.text();
  let payload = {};

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_error) {
      payload = { raw: text };
    }
  }

  if (!response.ok) {
    const message =
      payload?.error?.message ||
      payload?.error_description ||
      payload?.message ||
      payload?.error ||
      payload?.raw ||
      fallbackMessage;
    throw new Error(String(message));
  }

  return payload;
}

async function fetchGoogleProfile(accessToken) {
  return requestExternalJson(
    "https://www.googleapis.com/oauth2/v2/userinfo",
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
    "Failed to load the Google account profile."
  );
}

async function getAuthorizedProviderAccess(userId, provider) {
  let integration = await getUserIntegration(userId, provider);
  if (!integration) {
    throw new Error(
      provider === "google"
        ? "Connect Google first in the account dashboard."
        : "Connect Notion first in the account dashboard."
    );
  }

  if (
    integration.provider === "google" &&
    integration.accessTokenExpiresAt &&
    integration.accessTokenExpiresAt.getTime() <= Date.now() + 60 * 1000
  ) {
    const refreshToken = integration.refreshTokenEncrypted
      ? decryptSensitiveValue(integration.refreshTokenEncrypted)
      : "";

    if (!refreshToken) {
      throw new Error("The Google connection expired. Reconnect Google in the dashboard.");
    }

    const refreshed = await refreshGoogleAccessToken(refreshToken);
    integration =
      (await updateUserIntegrationTokens(integration.id, {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token || null,
        tokenType: refreshed.token_type || integration.tokenType,
        scopes: refreshed.scope
          ? refreshed.scope.split(/\s+/g)
          : integration.scopes,
        accessTokenExpiresAt:
          typeof refreshed.expires_in === "number"
            ? new Date(Date.now() + refreshed.expires_in * 1000)
            : integration.accessTokenExpiresAt,
      })) || integration;
  }

  const accessToken = decryptSensitiveValue(integration.accessTokenEncrypted);
  if (!accessToken) {
    throw new Error(
      provider === "google"
        ? "The Google connection is incomplete. Reconnect Google in the dashboard."
        : "The Notion connection is incomplete. Reconnect Notion in the dashboard."
    );
  }

  await markUserIntegrationUsed(integration.id);
  return {
    integration,
    accessToken,
  };
}

async function handleIntegrationAssistantAction(user, input) {
  const command = parseIntegrationAssistantCommand(input.message);
  if (!command) {
    return {
      handled: false,
      reply: "",
      provider: null,
      app: null,
    };
  }

  if (command.provider === "google" && !isGoogleIntegrationConfigured()) {
    return {
      handled: true,
      reply:
        "Google is not configured on the backend yet. Add GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET, then reconnect from the account dashboard.",
      provider: "google",
      app: command.app,
    };
  }

  if (command.provider === "notion" && !isNotionIntegrationConfigured()) {
    return {
      handled: true,
      reply:
        "Notion is not configured on the backend yet. Add NOTION_CLIENT_ID and NOTION_CLIENT_SECRET, then reconnect from the account dashboard.",
      provider: "notion",
      app: command.app,
    };
  }

  if (
    command.kind !== "gmail_help" &&
    command.kind !== "calendar_help" &&
    command.kind !== "notion_help"
  ) {
    const providerIntegration = await getUserIntegration(user.id, command.provider);
    if (!providerIntegration) {
      return {
        handled: true,
        reply:
          command.provider === "google"
            ? "Google is not connected yet. Open Account Dashboard, connect Google, then try the Gmail or Calendar command again."
            : "Notion is not connected yet. Open Account Dashboard, connect Notion, then try again.",
        provider: command.provider,
        app: command.app,
      };
    }
  }

  if (command.kind === "gmail_help") {
    return {
      handled: true,
      reply:
        'Supported Gmail commands:\n- `Show my latest Gmail messages`\n- `Search Gmail for "invoice"`\n- `Draft Gmail email to alice@example.com subject "Interview follow-up" body "Thanks for your time."`\n- `Send Gmail email to bob@example.com subject "Schedule" body "Can we meet tomorrow?"`',
      provider: "google",
      app: "gmail",
    };
  }

  if (command.kind === "calendar_help") {
    return {
      handled: true,
      reply:
        'Supported Calendar commands:\n- `Show my upcoming calendar events`\n- `Show my calendar for tomorrow`\n- `Create calendar event "Team sync" on 2026-03-20 at 3pm for 45 minutes`',
      provider: "google",
      app: "google_calendar",
    };
  }

  if (command.kind === "notion_help") {
    return {
      handled: true,
      reply:
        'Supported Notion commands:\n- `Search Notion for onboarding checklist`\n- `Create Notion page "Interview Notes" content "Candidate strengths and risks"`',
      provider: "notion",
      app: "notion",
    };
  }

  if (command.kind === "gmail_list") {
    const { accessToken } = await getAuthorizedProviderAccess(user.id, "google");
    const messages = await listGmailMessages(accessToken, {
      query: command.query,
      maxResults: command.maxResults || 5,
    });
    return {
      handled: true,
      reply: formatGmailMessagesReply(messages, command.query),
      provider: "google",
      app: "gmail",
    };
  }

  if (command.kind === "gmail_draft" || command.kind === "gmail_send") {
    const { accessToken } = await getAuthorizedProviderAccess(user.id, "google");
    const result =
      command.kind === "gmail_send"
        ? await sendGmailMessage(accessToken, command)
        : await createGmailDraft(accessToken, command);
    return {
      handled: true,
      reply:
        command.kind === "gmail_send"
          ? `Email sent to ${command.to} with subject "${command.subject}".`
          : `Draft created for ${command.to} with subject "${command.subject}".${result.id ? ` Draft id: ${result.id}.` : ""}`,
      provider: "google",
      app: "gmail",
    };
  }

  if (command.kind === "calendar_list") {
    const { accessToken } = await getAuthorizedProviderAccess(user.id, "google");
    const events = await listGoogleCalendarEvents(accessToken, command.window);
    return {
      handled: true,
      reply: formatGoogleCalendarReply(events, command.window.label),
      provider: "google",
      app: "google_calendar",
    };
  }

  if (command.kind === "calendar_create") {
    const { accessToken } = await getAuthorizedProviderAccess(user.id, "google");
    const event = await createGoogleCalendarEvent(accessToken, {
      title: command.title,
      startDate: command.startDate,
      endDate: command.endDate,
    });
    return {
      handled: true,
      reply: `Calendar event "${event.summary || command.title}" created for ${formatCalendarEventTime(
        event.start
      )}.${event.htmlLink ? ` Open: ${event.htmlLink}` : ""}`,
      provider: "google",
      app: "google_calendar",
    };
  }

  if (command.kind === "notion_search") {
    const { accessToken } = await getAuthorizedProviderAccess(user.id, "notion");
    const results = await searchNotionPages(accessToken, command.query);
    return {
      handled: true,
      reply: formatNotionSearchReply(results, command.query),
      provider: "notion",
      app: "notion",
    };
  }

  if (command.kind === "notion_create") {
    const { accessToken } = await getAuthorizedProviderAccess(user.id, "notion");
    const page = await createNotionPage(accessToken, {
      title: command.title,
      content: command.content,
    });
    return {
      handled: true,
      reply: `Notion page "${extractNotionPageTitle(page)}" created.${page.url ? ` Open: ${page.url}` : ""}`,
      provider: "notion",
      app: "notion",
    };
  }

  return {
    handled: false,
    reply: "",
    provider: null,
    app: null,
  };
}

function parseIntegrationAssistantCommand(message) {
  const emailCommand = parseEmailComposeCommand(message);
  if (emailCommand) {
    return emailCommand;
  }

  const calendarCreate = parseCalendarCreateCommand(message);
  if (calendarCreate) {
    return calendarCreate;
  }

  const notionCreate = parseNotionCreateCommand(message);
  if (notionCreate) {
    return notionCreate;
  }

  if (looksLikeGmailQuery(message)) {
    return {
      kind: "gmail_list",
      provider: "google",
      app: "gmail",
      query: extractMailQuery(message),
      maxResults: 5,
    };
  }

  if (looksLikeCalendarList(message)) {
    return {
      kind: "calendar_list",
      provider: "google",
      app: "google_calendar",
      window: parseCalendarWindow(message),
    };
  }

  if (looksLikeNotionSearch(message)) {
    return {
      kind: "notion_search",
      provider: "notion",
      app: "notion",
      query: extractNotionQuery(message),
    };
  }

  if (/\b(gmail|inbox)\b/i.test(message)) {
    return {
      kind: "gmail_help",
      provider: "google",
      app: "gmail",
    };
  }

  if (/\bcalendar\b/i.test(message)) {
    return {
      kind: "calendar_help",
      provider: "google",
      app: "google_calendar",
    };
  }

  if (/\bnotion\b/i.test(message)) {
    return {
      kind: "notion_help",
      provider: "notion",
      app: "notion",
    };
  }

  return null;
}

function parseEmailComposeCommand(message) {
  const action = /\bsend\b/i.test(message)
    ? "gmail_send"
    : /\b(draft|compose|write)\b/i.test(message)
    ? "gmail_draft"
    : null;
  if (!action || !/\b(gmail|inbox)\b/i.test(message)) {
    return null;
  }

  const to = extractCommandValue(message, "to", ["subject", "body"]);
  const subject = extractCommandValue(message, "subject", ["body"]);
  const body = extractCommandValue(message, "body", []);

  if (!to || !subject || !body) {
    return {
      kind: "gmail_help",
      provider: "google",
      app: "gmail",
    };
  }

  return {
    kind: action,
    provider: "google",
    app: "gmail",
    to,
    subject,
    body,
  };
}

function parseCalendarCreateCommand(message) {
  const isIntent =
    /\b(create|add|schedule)\b/i.test(message) &&
    /\bcalendar\b/i.test(message) &&
    /\b(event|meeting)\b/i.test(message);
  if (!isIntent) {
    return null;
  }

  const title =
    extractFirstQuotedText(message) ||
    extractCommandValue(message, "event", ["on", "at", "for"]) ||
    extractCommandValue(message, "meeting", ["on", "at", "for"]);
  const dateText =
    extractCommandValue(message, "on", ["at", "for"]) ||
    (/\btomorrow\b/i.test(message)
      ? "tomorrow"
      : /\btoday\b/i.test(message)
      ? "today"
      : "");
  const timeText = extractCommandValue(message, "at", ["for"]);
  const durationText = extractCommandValue(message, "for", []);
  const durationMinutes = parseDurationMinutes(durationText) || 60;
  const startDate = parseNaturalDateTime(dateText, timeText);

  if (!title || !startDate) {
    return {
      kind: "calendar_help",
      provider: "google",
      app: "google_calendar",
    };
  }

  return {
    kind: "calendar_create",
    provider: "google",
    app: "google_calendar",
    title,
    startDate,
    endDate: new Date(startDate.getTime() + durationMinutes * 60 * 1000),
  };
}

function parseNotionCreateCommand(message) {
  const isIntent =
    /\b(create|add|make)\b/i.test(message) &&
    /\bnotion\b/i.test(message) &&
    /\b(page|doc|note)\b/i.test(message);
  if (!isIntent) {
    return null;
  }

  const title =
    extractFirstQuotedText(message) ||
    extractCommandValue(message, "page", ["content"]) ||
    extractCommandValue(message, "title", ["content"]);
  const content = extractCommandValue(message, "content", []);

  if (!title) {
    return {
      kind: "notion_help",
      provider: "notion",
      app: "notion",
    };
  }

  return {
    kind: "notion_create",
    provider: "notion",
    app: "notion",
    title,
    content,
  };
}

function looksLikeGmailQuery(message) {
  return (
    /\b(gmail|inbox)\b/i.test(message) &&
    /\b(show|list|check|recent|latest|search|find|unread|inbox)\b/i.test(message)
  );
}

function looksLikeCalendarList(message) {
  return (
    /\bcalendar\b/i.test(message) &&
    /\b(show|list|check|upcoming|next|today|tomorrow|what)\b/i.test(message)
  );
}

function looksLikeNotionSearch(message) {
  return (
    /\bnotion\b/i.test(message) &&
    /\b(search|find|look\s+for|open|show)\b/i.test(message)
  );
}

function extractMailQuery(message) {
  if (/\bunread\b/i.test(message)) {
    return "is:unread";
  }

  const extracted =
    extractCommandValue(message, "for", []) ||
    extractCommandValue(message, "from", []) ||
    extractCommandValue(message, "about", []) ||
    extractCommandValue(message, "matching", []);
  return extracted || "";
}

function extractNotionQuery(message) {
  return (
    extractCommandValue(message, "for", []) ||
    extractCommandValue(message, "notion", []) ||
    extractFirstQuotedText(message) ||
    "recent pages"
  );
}

function parseCalendarWindow(message) {
  const now = new Date();
  if (/\btomorrow\b/i.test(message)) {
    const start = new Date(now);
    start.setDate(start.getDate() + 1);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return {
      label: "tomorrow",
      timeMin: start,
      timeMax: end,
      maxResults: 8,
    };
  }

  if (/\btoday\b/i.test(message)) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return {
      label: "today",
      timeMin: start,
      timeMax: end,
      maxResults: 8,
    };
  }

  if (/\bnext\s+week\b/i.test(message)) {
    return {
      label: "the next 7 days",
      timeMin: now,
      timeMax: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      maxResults: 10,
    };
  }

  return {
    label: "upcoming",
    timeMin: now,
    timeMax: null,
    maxResults: 5,
  };
}

function extractCommandValue(message, label, nextLabels) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nextBoundary =
    Array.isArray(nextLabels) && nextLabels.length > 0
      ? `(?=\\s+(?:${nextLabels
          .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("|")})\\b|$)`
      : `(?=$)`;
  const pattern = new RegExp(`\\b${escapedLabel}\\b\\s+([\\s\\S]+?)${nextBoundary}`, "i");
  const match = message.match(pattern);
  return sanitizeCommandValue(match?.[1] || "");
}

function sanitizeCommandValue(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function extractFirstQuotedText(value) {
  const match = String(value || "").match(/"([^"]+)"/);
  return match ? match[1].trim() : "";
}

function parseDurationMinutes(value) {
  const match = String(value || "").match(
    /(\d+)\s*(minutes|minute|mins|min|hours|hour|hrs|hr)?/i
  );
  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  const unit = String(match[2] || "minutes").toLowerCase();
  if (unit.startsWith("hour") || unit === "hr" || unit === "hrs") {
    return amount * 60;
  }

  return amount;
}

function parseNaturalDateTime(dateText, timeText) {
  const normalizedTime = String(timeText || "").trim();
  if (!normalizedTime) {
    return null;
  }

  const normalizedDate = String(dateText || "").trim().toLowerCase();
  const baseDate = new Date();

  if (normalizedDate === "today") {
    return parseDateWithTime(baseDate, normalizedTime);
  }

  if (normalizedDate === "tomorrow") {
    const tomorrow = new Date(baseDate);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return parseDateWithTime(tomorrow, normalizedTime);
  }

  const parsedDate = new Date(normalizedDate || Date.now());
  if (Number.isNaN(parsedDate.getTime())) {
    return null;
  }

  return parseDateWithTime(parsedDate, normalizedTime);
}

function parseDateWithTime(dateValue, timeText) {
  const timeMatch = String(timeText || "")
    .trim()
    .match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!timeMatch) {
    return null;
  }

  let hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2] || "0");
  const meridiem = String(timeMatch[3] || "").toLowerCase();

  if (meridiem === "pm" && hours < 12) {
    hours += 12;
  } else if (meridiem === "am" && hours === 12) {
    hours = 0;
  }

  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return null;
  }

  const date = new Date(dateValue);
  date.setHours(hours, minutes, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function listGmailMessages(accessToken, options = {}) {
  const params = new URLSearchParams({
    maxResults: String(options.maxResults || 5),
  });
  if (options.query) {
    params.set("q", options.query);
  }

  const listResponse = await requestExternalJson(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
    "Failed to load Gmail messages."
  );

  const messageRefs = Array.isArray(listResponse.messages) ? listResponse.messages : [];
  const messages = await Promise.all(
    messageRefs.map((item) =>
      requestExternalJson(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(
          item.id
        )}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
        "Failed to load a Gmail message."
      )
    )
  );

  return messages.map((message) => ({
    id: message.id,
    snippet: message.snippet || "",
    subject: readGmailHeader(message.payload, "Subject") || "(No subject)",
    from: readGmailHeader(message.payload, "From") || "Unknown sender",
    date: readGmailHeader(message.payload, "Date") || "",
  }));
}

function readGmailHeader(payload, name) {
  const headers = Array.isArray(payload?.headers) ? payload.headers : [];
  const match = headers.find(
    (header) => String(header?.name || "").toLowerCase() === String(name).toLowerCase()
  );
  return match?.value || "";
}

function buildRawEmailMessage(input) {
  const mime = [
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "MIME-Version: 1.0",
    "",
    input.body,
  ].join("\r\n");

  return Buffer.from(mime, "utf8").toString("base64url");
}

async function createGmailDraft(accessToken, input) {
  return requestExternalJson(
    "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          raw: buildRawEmailMessage(input),
        },
      }),
    },
    "Failed to create the Gmail draft."
  );
}

async function sendGmailMessage(accessToken, input) {
  return requestExternalJson(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        raw: buildRawEmailMessage(input),
      }),
    },
    "Failed to send the Gmail message."
  );
}

async function listGoogleCalendarEvents(accessToken, window) {
  const params = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(window.maxResults || 5),
    timeMin: window.timeMin.toISOString(),
  });
  if (window.timeMax) {
    params.set("timeMax", window.timeMax.toISOString());
  }

  const response = await requestExternalJson(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
    "Failed to load Google Calendar events."
  );

  return Array.isArray(response.items) ? response.items : [];
}

async function createGoogleCalendarEvent(accessToken, input) {
  const timeZone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  return requestExternalJson(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        summary: input.title,
        start: {
          dateTime: input.startDate.toISOString(),
          timeZone,
        },
        end: {
          dateTime: input.endDate.toISOString(),
          timeZone,
        },
      }),
    },
    "Failed to create the Google Calendar event."
  );
}

async function searchNotionPages(accessToken, queryText) {
  const response = await requestExternalJson(
    "https://api.notion.com/v1/search",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Notion-Version": NOTION_API_VERSION,
      },
      body: JSON.stringify({
        query: queryText,
        filter: {
          property: "object",
          value: "page",
        },
        page_size: 5,
      }),
    },
    "Failed to search Notion."
  );

  return Array.isArray(response.results) ? response.results : [];
}

async function createNotionPage(accessToken, input) {
  const children = input.content
    ? [
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              {
                type: "text",
                text: {
                  content: String(input.content).slice(0, 1800),
                },
              },
            ],
          },
        },
      ]
    : [];

  return requestExternalJson(
    "https://api.notion.com/v1/pages",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Notion-Version": NOTION_API_VERSION,
      },
      body: JSON.stringify({
        parent: {
          type: "workspace",
          workspace: true,
        },
        properties: {
          title: {
            title: [
              {
                type: "text",
                text: {
                  content: input.title,
                },
              },
            ],
          },
        },
        children,
      }),
    },
    "Failed to create the Notion page."
  );
}

function extractNotionPageTitle(page) {
  const properties = page?.properties && typeof page.properties === "object"
    ? page.properties
    : {};

  for (const value of Object.values(properties)) {
    if (value?.type === "title" && Array.isArray(value.title)) {
      const title = value.title
        .map((entry) => entry?.plain_text || entry?.text?.content || "")
        .join("")
        .trim();
      if (title) {
        return title;
      }
    }
  }

  return "Untitled";
}

function formatGmailMessagesReply(messages, queryText) {
  if (!messages.length) {
    return queryText
      ? `No Gmail messages matched "${queryText}".`
      : "No recent Gmail messages were found.";
  }

  const heading = queryText
    ? `Here are the Gmail results for "${queryText}":`
    : "Here are your latest Gmail messages:";
  return [
    heading,
    ...messages.map((message) =>
      `- **${message.subject}** from ${message.from}${message.date ? ` (${message.date})` : ""}${message.snippet ? ` - ${message.snippet}` : ""}`
    ),
  ].join("\n");
}

function formatGoogleCalendarReply(events, label) {
  if (!events.length) {
    return `No Google Calendar events were found for ${label}.`;
  }

  return [
    `Here are your Google Calendar events for ${label}:`,
    ...events.map((event) =>
      `- **${event.summary || "Untitled event"}** at ${formatCalendarEventTime(
        event.start
      )}${event.htmlLink ? ` - ${event.htmlLink}` : ""}`
    ),
  ].join("\n");
}

function formatCalendarEventTime(start) {
  if (start?.dateTime) {
    const date = new Date(start.dateTime);
    return Number.isNaN(date.getTime())
      ? String(start.dateTime)
      : date.toLocaleString();
  }

  if (start?.date) {
    return String(start.date);
  }

  return "an unknown time";
}

function formatNotionSearchReply(results, queryText) {
  if (!results.length) {
    return `No Notion pages matched "${queryText}".`;
  }

  return [
    `Here are the Notion pages matching "${queryText}":`,
    ...results.map((page) =>
      `- **${extractNotionPageTitle(page)}**${page.url ? ` - ${page.url}` : ""}`
    ),
  ].join("\n");
}

async function buildUniqueResearchSlug(title) {
  const baseSlug = createResearchSlug(title);
  let slug = baseSlug;

  for (let suffix = 1; suffix <= 50; suffix += 1) {
    const existing = await query(
      `
        SELECT 1
        FROM research_posts
        WHERE slug = $1
        LIMIT 1
      `,
      [slug]
    );

    if (!existing.rows[0]) {
      return slug;
    }

    const suffixText = String(suffix + 1);
    const maxBaseLength = Math.max(24, 96 - suffixText.length - 1);
    slug = `${baseSlug.slice(0, maxBaseLength).replace(/-+$/g, "")}-${suffixText}`;
  }

  return `${baseSlug.slice(0, 72).replace(/-+$/g, "")}-${createId("res")
    .slice(-8)
    .toLowerCase()}`;
}

function mapChatThreadRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    mode: row.mode,
    title: row.title,
    preview: row.preview || "",
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    lastMessageAt: toIso(row.last_message_at),
  };
}

function mapChatMessageRow(row) {
  return {
    id: row.id,
    threadId: row.thread_id,
    userId: row.user_id,
    role: row.role,
    content: row.content,
    createdAt: toIso(row.created_at),
  };
}

async function listChatThreads(userId, mode) {
  const requestedModes =
    mode === "general"
      ? ["general", "live_interview", "computer_use"]
      : [mode];
  const result = await query(
    `
      SELECT
        t.id,
        t.user_id,
        t.mode,
        t.title,
        t.created_at,
        t.updated_at,
        t.last_message_at,
        COALESCE(last_message.content, '') AS preview
      FROM chat_threads t
      LEFT JOIN LATERAL (
        SELECT content
        FROM chat_messages
        WHERE thread_id = t.id
        ORDER BY created_at DESC
        LIMIT 1
      ) AS last_message
        ON TRUE
      WHERE t.user_id = $1
        AND t.mode = ANY($2::text[])
      ORDER BY t.last_message_at DESC, t.created_at DESC
      LIMIT 40
    `,
    [userId, requestedModes]
  );

  return result.rows.map(mapChatThreadRow);
}

async function getChatThreadForUser(threadId, userId) {
  const result = await query(
    `
      SELECT
        t.id,
        t.user_id,
        t.mode,
        t.title,
        t.created_at,
        t.updated_at,
        t.last_message_at,
        COALESCE(last_message.content, '') AS preview
      FROM chat_threads t
      LEFT JOIN LATERAL (
        SELECT content
        FROM chat_messages
        WHERE thread_id = t.id
        ORDER BY created_at DESC
        LIMIT 1
      ) AS last_message
        ON TRUE
      WHERE t.id = $1
        AND t.user_id = $2
      LIMIT 1
    `,
    [threadId, userId]
  );

  return result.rows[0] ? mapChatThreadRow(result.rows[0]) : null;
}

async function createChatThread(input) {
  const title = summarizeChatTitle(input.title);
  const result = await query(
    `
      INSERT INTO chat_threads (
        id,
        user_id,
        mode,
        title,
        created_at,
        updated_at,
        last_message_at
      )
      VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW())
      RETURNING
        id,
        user_id,
        mode,
        title,
        created_at,
        updated_at,
        last_message_at,
        ''::text AS preview
    `,
    [input.id, input.userId, input.mode, title]
  );

  return mapChatThreadRow(result.rows[0]);
}

async function listChatMessages(threadId, userId) {
  const result = await query(
    `
      SELECT id, thread_id, user_id, role, content, created_at
      FROM chat_messages
      WHERE thread_id = $1
        AND user_id = $2
      ORDER BY created_at ASC
      LIMIT 300
    `,
    [threadId, userId]
  );

  return result.rows.map(mapChatMessageRow);
}

async function appendChatMessage(input) {
  const content = normalizeChatContent(input.content);
  if (!content) {
    throw new Error("Chat message content cannot be empty.");
  }

  const createdAt = new Date();
  const result = await query(
    `
      INSERT INTO chat_messages (id, thread_id, user_id, role, content, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, thread_id, user_id, role, content, created_at
    `,
    [input.id, input.threadId, input.userId, input.role, content, createdAt]
  );

  const nextTitle =
    input.role === "user" ? summarizeChatTitle(content) : null;

  await query(
    `
      UPDATE chat_threads
      SET
        title = CASE
          WHEN $3::text IS NOT NULL
            AND (title = 'New chat' OR title = '')
          THEN $3::text
          ELSE title
        END,
        updated_at = NOW(),
        last_message_at = $4
      WHERE id = $1
        AND user_id = $2
    `,
    [input.threadId, input.userId, nextTitle, createdAt]
  );

  return mapChatMessageRow(result.rows[0]);
}

function mapPhonePairingRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    desktopDeviceName: row.desktop_device_name,
    mobileDeviceName: row.mobile_device_name || null,
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    expiresAt: toIso(row.expires_at),
    pairedAt: toIso(row.paired_at),
    lastSeenAt: toIso(row.last_seen_at),
  };
}

function mapPhoneRelayEventRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    pairingId: row.pairing_id,
    source: row.source,
    eventType: row.event_type,
    payload:
      row.payload_json && typeof row.payload_json === "object"
        ? row.payload_json
        : {},
    createdAt: toIso(row.created_at),
    pairing: {
      desktopDeviceName: row.desktop_device_name,
      mobileDeviceName: row.mobile_device_name || null,
    },
  };
}

async function expirePhonePairingSessions(userId) {
  if (userId) {
    await query(
      `
        UPDATE phone_pairing_sessions
        SET
          status = 'expired',
          updated_at = NOW()
        WHERE user_id = $1
          AND status = 'pending'
          AND expires_at <= NOW()
      `,
      [userId]
    );
    return;
  }

  await query(
    `
      UPDATE phone_pairing_sessions
      SET
        status = 'expired',
        updated_at = NOW()
      WHERE status = 'pending'
        AND expires_at <= NOW()
    `
  );
}

async function createPhonePairingSession(input) {
  const result = await query(
    `
      INSERT INTO phone_pairing_sessions (
        id,
        user_id,
        pairing_token_hash,
        desktop_device_name,
        status,
        created_at,
        updated_at,
        expires_at
      )
      VALUES ($1, $2, $3, $4, 'pending', NOW(), NOW(), $5)
      RETURNING *
    `,
    [
      input.id,
      input.userId,
      input.pairingTokenHash,
      input.desktopDeviceName,
      input.expiresAt,
    ]
  );

  return mapPhonePairingRow(result.rows[0]);
}

async function getPhonePairingSessionRecord(pairingId) {
  const result = await query(
    `
      SELECT *
      FROM phone_pairing_sessions
      WHERE id = $1
      LIMIT 1
    `,
    [pairingId]
  );

  return result.rows[0] || null;
}

async function getPhonePairingSessionForUser(pairingId, userId) {
  const result = await query(
    `
      SELECT *
      FROM phone_pairing_sessions
      WHERE id = $1
        AND user_id = $2
      LIMIT 1
    `,
    [pairingId, userId]
  );

  return result.rows[0] ? mapPhonePairingRow(result.rows[0]) : null;
}

async function markPhonePairingSessionExpired(pairingId) {
  await query(
    `
      UPDATE phone_pairing_sessions
      SET
        status = 'expired',
        updated_at = NOW()
      WHERE id = $1
        AND status = 'pending'
    `,
    [pairingId]
  );
}

async function markPhonePairingSessionPaired(input) {
  const result = await query(
    `
      UPDATE phone_pairing_sessions
      SET
        mobile_device_name = $2,
        status = 'paired',
        paired_at = COALESCE(paired_at, NOW()),
        last_seen_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [input.pairingId, input.mobileDeviceName]
  );

  return mapPhonePairingRow(result.rows[0]);
}

async function touchPhonePairingSession(pairingId) {
  await query(
    `
      UPDATE phone_pairing_sessions
      SET
        last_seen_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
    `,
    [pairingId]
  );
}

async function listPhonePairingDevices(userId) {
  const result = await query(
    `
      SELECT *
      FROM phone_pairing_sessions
      WHERE user_id = $1
        AND status = 'paired'
      ORDER BY last_seen_at DESC NULLS LAST, paired_at DESC NULLS LAST, created_at DESC
      LIMIT 20
    `,
    [userId]
  );

  return result.rows.map(mapPhonePairingRow);
}

async function createPhoneRelayEvent(input) {
  const result = await query(
    `
      INSERT INTO phone_relay_events (
        id,
        user_id,
        pairing_id,
        source,
        event_type,
        payload_json,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
      RETURNING
        phone_relay_events.*,
        (SELECT desktop_device_name FROM phone_pairing_sessions WHERE id = phone_relay_events.pairing_id) AS desktop_device_name,
        (SELECT mobile_device_name FROM phone_pairing_sessions WHERE id = phone_relay_events.pairing_id) AS mobile_device_name
    `,
    [
      input.id,
      input.userId,
      input.pairingId,
      input.source,
      input.eventType,
      JSON.stringify(input.payload),
    ]
  );

  return mapPhoneRelayEventRow(result.rows[0]);
}

async function listPhoneRelayEvents(userId, options = {}) {
  const params = [userId];
  const conditions = ["events.user_id = $1"];

  if (options.pairingId) {
    params.push(options.pairingId);
    conditions.push(`events.pairing_id = $${params.length}`);
  }

  if (options.after) {
    params.push(options.after);
    conditions.push(`events.created_at > $${params.length}`);
  }

  params.push(options.limit || 40);

  const result = await query(
    `
      SELECT
        events.*,
        pairing.desktop_device_name,
        pairing.mobile_device_name
      FROM phone_relay_events AS events
      INNER JOIN phone_pairing_sessions AS pairing
        ON pairing.id = events.pairing_id
      WHERE ${conditions.join("\n        AND ")}
      ORDER BY events.created_at DESC, events.id DESC
      LIMIT $${params.length}
    `,
    params
  );

  return result.rows.map(mapPhoneRelayEventRow);
}

async function generateMobileAssistantReply(input) {
  if (!TOGETHER_API_KEY) {
    throw new Error(
      "Mobile chat is not configured. Set TOGETHER_API_KEY in the backend environment."
    );
  }

  const messages = [
    {
      role: "system",
      content:
        "You are Sylica AI on mobile. Be concise, practical, and helpful. Default to short direct answers unless the user clearly asks for depth.",
    },
    ...input.recentMessages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({
        role: message.role,
        content: message.content,
      })),
  ];

  const response = await fetch("https://api.together.xyz/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOGETHER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MOBILE_CHAT_MODEL,
      messages,
      temperature: 0.3,
      max_tokens: 900,
    }),
  });

  if (!response.ok) {
    let message = "Failed to generate a mobile chat response."
    try {
      const errorBody = await response.json()
      message = errorBody?.error?.message || errorBody?.error || message
    } catch (_error) {
      // Ignore invalid error body parsing.
    }

    throw new Error(message)
  }

  const payload = await response.json()
  const reply = String(payload?.choices?.[0]?.message?.content || "").trim()
  if (!reply) {
    throw new Error("The mobile chat model returned an empty response.")
  }

  return reply
}

function summarizeChatTitle(value) {
  const normalized = normalizeChatContent(value)
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return "New chat";
  }

  if (normalized.length <= 56) {
    return normalized;
  }

  return `${normalized.slice(0, 53).trimEnd()}...`;
}

function normalizeChatContent(value) {
  return String(value || "").trim().slice(0, 16_000);
}

function normalizeResearchTitle(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

function normalizeResearchSummary(value, fallback = "") {
  const normalized = String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 420);
  if (normalized) {
    return normalized;
  }

  const fallbackText = String(fallback || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!fallbackText) {
    return "";
  }

  return fallbackText.length > 280
    ? `${fallbackText.slice(0, 277).trimEnd()}...`
    : fallbackText;
}

function normalizeResearchContent(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, 80_000);
}

function normalizeResearchAuthorName(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 100);
  return normalized || null;
}

function createResearchSlug(value) {
  const ascii = String(value || "")
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "");
  const slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);

  return slug || `research-${Date.now().toString(36)}`;
}

function createPhonePairingToken() {
  return crypto.randomBytes(18).toString("base64url");
}

function hashPhonePairingToken(token) {
  return crypto
    .createHash("sha256")
    .update(String(token || ""))
    .digest("hex");
}

function normalizeIdentifier(value, maxLength = 120) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizePhoneDeviceName(value, fallback) {
  const normalized = String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 80);
  return normalized || fallback;
}

function isPhoneRelayEventType(value) {
  return PHONE_RELAY_EVENT_TYPES.has(String(value || ""));
}

function isPhoneRelaySource(value) {
  return PHONE_RELAY_SOURCES.has(String(value || ""));
}

function normalizeOptionalShortText(value, maxLength = 120) {
  const normalized = String(value || "").trim().slice(0, maxLength);
  return normalized || null;
}

function normalizeRelayUrl(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue) {
    return "";
  }

  try {
    const parsed = new URL(rawValue);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }

    return parsed.toString().slice(0, 2000);
  } catch (_error) {
    return "";
  }
}

function normalizePhoneRelayPayload(eventType, payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if (eventType === "clipboard") {
    const text = normalizeChatContent(payload.text).slice(0, 4000);
    if (!text) {
      return null;
    }

    return { text };
  }

  if (eventType === "otp") {
    const code = normalizeIdentifier(payload.code, 64);
    if (!code) {
      return null;
    }

    return {
      code,
      label: normalizeOptionalShortText(payload.label, 120),
    };
  }

  if (eventType === "link") {
    const url = normalizeRelayUrl(payload.url);
    if (!url) {
      return null;
    }

    return {
      url,
      title: normalizeOptionalShortText(payload.title, 120),
    };
  }

  if (eventType === "note") {
    const text = normalizeChatContent(payload.text).slice(0, 4000);
    if (!text) {
      return null;
    }

    return {
      text,
      title: normalizeOptionalShortText(payload.title, 120),
    };
  }

  return null;
}

function parseOptionalIsoDate(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return null;
  }

  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

function buildBillingSummary(user) {
  return {
    provider: activeBillingProvider,
    pricePerMonthUsd: BILLING_MONTHLY_PRICE_USD,
    unlimited: isUnlimitedSubscriber(user),
    checkoutEnabled: activeBillingProvider !== "manual",
    canManageBilling:
      (activeBillingProvider === "stripe" && Boolean(stripe && user.stripeCustomerId)) ||
      (activeBillingProvider === "dodo" && Boolean(user.dodoCustomerId)),
    cancelAtPeriodEnd: Boolean(user.cancelAtPeriodEnd),
    statusMessage: getBillingStatusMessage(user),
  };
}

function getBillingStatusMessage(user) {
  if (activeBillingProvider === "dodo") {
    if (isUnlimitedSubscriber(user)) {
      return "Unlimited access is active through Dodo Payments.";
    }

    if (!DODO_WEBHOOK_SECRET) {
      return `$${BILLING_MONTHLY_PRICE_USD}/month checkout is live. Add DODO_PAYMENTS_WEBHOOK_SECRET for automatic subscription sync.`;
    }

    return `$${BILLING_MONTHLY_PRICE_USD}/month unlocks unlimited use through Dodo Payments.`;
  }

  if (activeBillingProvider === "stripe") {
    if (isUnlimitedSubscriber(user)) {
      return "Unlimited access is active through Stripe.";
    }

    if (!stripeWebhookConfigured) {
      return `$${BILLING_MONTHLY_PRICE_USD}/month checkout is live. Add STRIPE_WEBHOOK_SECRET for automatic subscription sync.`;
    }

    return `$${BILLING_MONTHLY_PRICE_USD}/month unlocks unlimited use.`;
  }

  return "Billing is off until Dodo Payments or Stripe is configured in backend env.";
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
    lower.includes("dodo_api_key_here") ||
    lower.includes("dodo_webhook_secret_here") ||
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
  const requestsToday = solvesToday + debugToday;
  const requestsThisHour = asNumber(row.requests_this_hour);
  const solveDailyLimit = getSolveDailyLimit(user);
  const debugDailyLimit = getDebugDailyLimit(user);
  const requestsDailyLimit = getDailyRequestLimit(user);
  const requestsHourlyLimit = getHourlyRequestLimit(user);

  return {
    solvesToday,
    debugToday,
    screenshotsToday: asNumber(row.screenshots_today),
    requestsToday,
    requestsThisHour,
    remainingRequestsToday: Math.max(0, requestsDailyLimit - requestsToday),
    remainingSolveDaily: Math.max(0, solveDailyLimit - solvesToday),
    remainingDebugDaily: Math.max(0, debugDailyLimit - debugToday),
    remainingRequestsThisHour: Math.max(
      0,
      requestsHourlyLimit - requestsThisHour
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

  if (action === "live_interview") {
    if (isUnlimitedSubscriber(user)) {
      return { allowed: true };
    }

    return {
      allowed: false,
      statusCode: 403,
      error: "Live Interview is available on the Pro plan.",
    };
  }

  if (action === "computer_use") {
    if (isUnlimitedSubscriber(user)) {
      return { allowed: true };
    }

    return {
      allowed: false,
      statusCode: 403,
      error: "Computer Use is available on the Pro plan.",
    };
  }

  if (isUnlimitedSubscriber(user)) {
    return { allowed: true };
  }

  const usage = await buildUsageSnapshot(user);
  const requestsDailyLimit = getDailyRequestLimit(user);
  const requestsHourlyLimit = getHourlyRequestLimit(user);
  const solveDailyLimit = getSolveDailyLimit(user);
  const debugDailyLimit = getDebugDailyLimit(user);

  if (usage.requestsThisHour >= requestsHourlyLimit) {
    return {
      allowed: false,
      statusCode: 429,
      error: "Hourly request limit reached for this account.",
    };
  }

  if (usage.requestsToday >= requestsDailyLimit) {
    return {
      allowed: false,
      statusCode: 429,
      error: "Daily request limit reached for this account.",
    };
  }

  if (action === "solve" && usage.solvesToday >= solveDailyLimit) {
    return {
      allowed: false,
      statusCode: 429,
      error: "Daily solve limit reached for this account.",
    };
  }

  if (action === "debug" && usage.debugToday >= debugDailyLimit) {
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
  return (
    value === "solve" ||
    value === "debug" ||
    value === "screenshot" ||
    value === "live_interview" ||
    value === "computer_use"
  );
}

function isChatMode(value) {
  return (
    value === "general" ||
    value === "follow_up" ||
    value === "live_interview" ||
    value === "computer_use"
  );
}

function isChatRole(value) {
  return value === "user" || value === "assistant";
}

function isUnlimitedSubscriber(user) {
  return (
    (user.subscriptionPlan === "pro" || user.subscriptionPlan === "enterprise") &&
    (user.subscriptionStatus === "active" || user.subscriptionStatus === "trial")
  );
}

function getSolveDailyLimit(user) {
  if (user.subscriptionPlan === "free") {
    return PLAN_LIMITS.free.solveDaily;
  }

  return Math.max(1, asNumber(user.rateLimits.solveDaily));
}

function getDebugDailyLimit(user) {
  if (user.subscriptionPlan === "free") {
    return PLAN_LIMITS.free.debugDaily;
  }

  return Math.max(1, asNumber(user.rateLimits.debugDaily));
}

function getDailyRequestLimit(user) {
  if (user.subscriptionPlan === "free") {
    return 20;
  }

  return Math.max(getSolveDailyLimit(user), getDebugDailyLimit(user));
}

function getHourlyRequestLimit(user) {
  if (user.subscriptionPlan === "free") {
    return PLAN_LIMITS.free.requestsPerHour;
  }

  return Math.max(1, asNumber(user.rateLimits.requestsPerHour));
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

function normalizeDodoEnvironment(value) {
  return String(value || "").trim().toLowerCase() === "test_mode"
    ? "test_mode"
    : "live_mode";
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
