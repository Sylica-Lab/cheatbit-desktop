import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const mobileRoot = path.join(projectRoot, "mobile");
const expoConfigPath = path.join(mobileRoot, "app.json");
const expoConfig = JSON.parse(readFileSync(expoConfigPath, "utf8"));
const mobileVersion = String(expoConfig?.expo?.version || "").trim();
const stableApkPath = path.resolve(
  projectRoot,
  process.argv[2] || process.env.ANDROID_APK_PATH?.trim() || path.join("mobile", "dist", "Sylica-AI-Android.apk")
);
const versionedApkPath = path.resolve(
  projectRoot,
  process.env.ANDROID_VERSIONED_APK_PATH?.trim() ||
    path.join("mobile", "dist", `Sylica-AI-Android-${mobileVersion}.apk`)
);
const bucketName = process.env.CLOUDFLARE_R2_BUCKET || "sylica-ai-downloads";
const stableAlias = process.env.ANDROID_APK_ALIAS || "Sylica-AI-Android.apk";
const versionedPrefix = process.env.ANDROID_APK_PREFIX || "mobile-downloads";
const wranglerConfig =
  process.env.WRANGLER_CONFIG || path.join(projectRoot, "backend", "wrangler.jsonc");

function requireFile(filePath, label) {
  if (!existsSync(filePath)) {
    throw new Error(`${label} not found at ${filePath}`);
  }
}

function getWranglerCommand() {
  const localWrangler = path.join(
    projectRoot,
    "backend",
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler"
  );
  const localWranglerJs = path.join(projectRoot, "backend", "node_modules", "wrangler", "bin", "wrangler.js");

  if (existsSync(localWranglerJs)) {
    return {
      command: process.execPath,
      argsPrefix: [localWranglerJs],
    };
  }

  if (existsSync(localWrangler)) {
    return {
      command: localWrangler,
      argsPrefix: [],
    };
  }

  return {
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    argsPrefix: ["--prefix", "backend", "wrangler"],
  };
}

function shouldUseShell(command) {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

function putObject(key, filePath) {
  const { command, argsPrefix } = getWranglerCommand();
  const args = [
    ...argsPrefix,
    "r2",
    "object",
    "put",
    `${bucketName}/${key}`,
    "--file",
    filePath,
    "--remote",
    "--config",
    wranglerConfig,
  ];

  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    shell: shouldUseShell(command),
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`Failed to upload ${key} (exit code ${result.status ?? -1})`);
  }
}

function main() {
  requireFile(stableApkPath, "Stable Android APK");

  console.log(`Publishing Android APK from ${stableApkPath}`);
  putObject(stableAlias, stableApkPath);

  if (mobileVersion && existsSync(versionedApkPath)) {
    const versionedKey = `${versionedPrefix}/${path.basename(versionedApkPath)}`;
    putObject(versionedKey, versionedApkPath);
    console.log(`Published ${stableAlias} and ${versionedKey}`);
    return;
  }

  console.log(`Published ${stableAlias}`);
}

main();
