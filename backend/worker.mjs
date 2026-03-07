import process from "node:process";
import { createRequire } from "node:module";
import { httpServerHandler } from "cloudflare:node";

const require = createRequire(import.meta.url);

let serverModule = null;
let nodeHandler = null;

function applyWorkerEnv(env, request) {
  process.env.CLOUDFLARE_WORKER = "true";
  process.env.ALLOW_BUILT_IN_STRIPE_CONFIG = "false";
  process.env.BACKEND_HOST = process.env.BACKEND_HOST || "0.0.0.0";
  process.env.BACKEND_PORT =
    process.env.BACKEND_PORT || process.env.PORT || "8787";

  for (const [key, value] of Object.entries(env || {})) {
    if (typeof value === "string" && !process.env[key]) {
      process.env[key] = value;
    }
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
  if (url.pathname === "/" || url.pathname === "/admin") {
    url.pathname = "/dashboard.html";
    return new Request(url.toString(), request);
  }

  return request;
}

async function getNodeHandler(env, request) {
  applyWorkerEnv(env, request);

  if (!serverModule) {
    serverModule = require("./server.js");
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

    if (!shouldRouteToNode(url)) {
      if (env?.ASSETS?.fetch) {
        return env.ASSETS.fetch(buildAssetRequest(request));
      }

      return new Response("CheatBit backend is deployed.", {
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
