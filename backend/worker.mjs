import process from "node:process";
import { httpServerHandler } from "cloudflare:node";

let serverModule = null;
let nodeHandler = null;
const WINDOWS_INSTALLER_PATH = "/Sylica-AI-Setup.exe";
const WINDOWS_INSTALLER_KEY = "Sylica-AI-Setup.exe";
const WINDOWS_UPDATE_FEED_PREFIX = "/desktop-updates/win/";
const ANDROID_APK_PATH = "/Sylica-AI-Android.apk";
const ANDROID_APK_KEY = "Sylica-AI-Android.apk";
const ANDROID_VERSIONED_DOWNLOAD_PREFIX = "/mobile-downloads/";
const STATIC_PAGE_ROUTE_MAP = new Map([
  ["/tos", "/terms/index.html"],
  ["/terms", "/terms/index.html"],
  ["/terms-of-service", "/terms/index.html"],
  ["/privacy", "/privacy/index.html"],
  ["/privacy-policy", "/privacy/index.html"],
  ["/security", "/security/index.html"],
  ["/changelog", "/changelog/index.html"],
  ["/blog", "/blog/index.html"],
  ["/blogs", "/blogs/index.html"],
  ["/research", "/research/index.html"],
  ["/researches", "/research/index.html"],
]);
const WORKER_STRING_ENV_KEYS = [
  "ADMIN_EMAIL",
  "ADMIN_PASSWORD",
  "BACKEND_PUBLIC_URL",
  "BACKEND_TOKEN_SECRET",
  "BILLING_RETURN_URL",
  "DATABASE_SSL",
  "DATABASE_URL",
  "RUN_DB_MIGRATIONS_ON_START",
  "STRIPE_MONTHLY_PRICE_USD",
  "STRIPE_PRICE_ID",
  "STRIPE_PRODUCT_NAME",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
];

function applyStringBinding(key, value) {
  if (typeof value === "string" && !process.env[key]) {
    process.env[key] = value;
  }
}

function applyWorkerEnv(env, request) {
  process.env.CLOUDFLARE_WORKER = "true";
  process.env.ALLOW_BUILT_IN_STRIPE_CONFIG = "false";
  process.env.BACKEND_HOST = process.env.BACKEND_HOST || "0.0.0.0";
  process.env.BACKEND_PORT =
    process.env.BACKEND_PORT || process.env.PORT || "8787";

  for (const key of WORKER_STRING_ENV_KEYS) {
    applyStringBinding(key, env?.[key]);
  }

  for (const [key, value] of Object.entries(env || {})) {
    applyStringBinding(key, value);
  }

  if (!process.env.DATABASE_URL && env?.HYPERDRIVE?.connectionString) {
    process.env.DATABASE_URL = env.HYPERDRIVE.connectionString;
    process.env.DATABASE_SSL = process.env.DATABASE_SSL || "true";
  }

  const origin = new URL(request.url).origin;
  process.env.BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL || origin;
  process.env.BILLING_RETURN_URL =
    process.env.BILLING_RETURN_URL || `${origin}/billing/return`;
}

function shouldRouteToNode(url) {
  return (
    url.pathname === "/health" ||
    url.pathname === "/billing/return" ||
    url.pathname.startsWith("/api/")
  );
}

function buildAssetRequest(request) {
  const url = new URL(request.url);
  const normalizedPath =
    url.pathname.length > 1 && url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1)
      : url.pathname;

  if (url.pathname === "/admin") {
    url.pathname = "/dashboard.html";
    return new Request(url.toString(), request);
  }

  const mappedPath = STATIC_PAGE_ROUTE_MAP.get(normalizedPath);
  if (mappedPath) {
    url.pathname = mappedPath;
    return new Request(url.toString(), request);
  }

  return request;
}

function resolveDownloadAsset(url) {
  if (url.pathname === WINDOWS_INSTALLER_PATH) {
    return {
      key: WINDOWS_INSTALLER_KEY,
      contentType: "application/octet-stream",
      cacheControl: "no-store, no-cache, must-revalidate, max-age=0",
      contentDisposition: `attachment; filename="${WINDOWS_INSTALLER_KEY}"`,
    };
  }

  if (url.pathname === ANDROID_APK_PATH) {
    return {
      key: ANDROID_APK_KEY,
      contentType: "application/vnd.android.package-archive",
      cacheControl: "no-store, no-cache, must-revalidate, max-age=0",
      contentDisposition: `attachment; filename="${ANDROID_APK_KEY}"`,
    };
  }

  if (
    url.pathname.startsWith(ANDROID_VERSIONED_DOWNLOAD_PREFIX) &&
    url.pathname.endsWith(".apk")
  ) {
    const filename = url.pathname.split("/").pop() || "Sylica-AI-Android.apk";
    return {
      key: url.pathname.slice(1),
      contentType: "application/vnd.android.package-archive",
      cacheControl: "public, max-age=31536000, immutable",
      contentDisposition: `attachment; filename="${filename}"`,
    };
  }

  if (!url.pathname.startsWith(WINDOWS_UPDATE_FEED_PREFIX)) {
    return null;
  }

  return {
    key: url.pathname.slice(1),
    contentType: url.pathname.endsWith(".yml")
      ? "text/yaml; charset=utf-8"
      : "application/octet-stream",
    cacheControl: url.pathname.endsWith("/latest.yml")
      ? "no-store, no-cache, must-revalidate, max-age=0"
      : "public, max-age=31536000, immutable",
    contentDisposition: null,
  };
}

async function maybeServeDownloadAsset(request, env, url) {
  const asset = resolveDownloadAsset(url);
  if (!asset) {
    return null;
  }

  const object = await env?.DOWNLOADS_BUCKET?.get(asset.key);
  if (!object) {
    return new Response("Download not found.", {
      status: 404,
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
    });
  }

  const headers = new Headers();
  headers.set("content-type", asset.contentType);
  headers.set("cache-control", asset.cacheControl);
  if (asset.contentDisposition) {
    headers.set("content-disposition", asset.contentDisposition);
  }
  if (asset.cacheControl.includes("no-store")) {
    headers.set("pragma", "no-cache");
    headers.set("expires", "0");
  }
  headers.set("etag", object.httpEtag);
  headers.set("content-length", String(object.size));

  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  return new Response(object.body, {
    status: 200,
    headers,
  });
}

function normalizeServerModule(imported) {
  const candidates = [imported, imported?.default];
  for (const candidate of candidates) {
    if (
      candidate &&
      candidate.server &&
      typeof candidate.prepareWorkerRuntime === "function"
    ) {
      return candidate;
    }
  }

  return imported?.default || imported;
}

async function getNodeHandler(env, request) {
  applyWorkerEnv(env, request);

  if (!serverModule) {
    const imported = await import("./server.js");
    serverModule = normalizeServerModule(imported);
    if (!serverModule.server.listening) {
      serverModule.server.listen(
        Number(process.env.BACKEND_PORT || "8787"),
        process.env.BACKEND_HOST || "0.0.0.0"
      );
    }
    nodeHandler = httpServerHandler(serverModule.server);
  }

  await serverModule.prepareWorkerRuntime();
  return nodeHandler;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const installerResponse = await maybeServeDownloadAsset(request, env, url);
    if (installerResponse) {
      return installerResponse;
    }

    if (!shouldRouteToNode(url)) {
      if (env?.ASSETS?.fetch) {
        return env.ASSETS.fetch(buildAssetRequest(request));
      }

      return new Response("Sylica AI backend is deployed.", {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
      });
    }

    const handler = await getNodeHandler(env, request);
    return handler.fetch(request, env);
  },
};
