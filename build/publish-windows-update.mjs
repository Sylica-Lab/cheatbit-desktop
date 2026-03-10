import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, "..")
const releaseDir = path.resolve(
  projectRoot,
  process.argv[2] || process.env.RELEASE_DIR?.trim() || "release"
)
const latestYmlPath = path.join(releaseDir, "latest.yml")
const bucketName = process.env.CLOUDFLARE_R2_BUCKET || "sylica-ai-downloads"
const updatePrefix = "desktop-updates/win"
const installerAlias = process.env.WINDOWS_INSTALLER_ALIAS || "Sylica-AI-Setup.exe"
const wranglerConfig =
  process.env.WRANGLER_CONFIG || path.join(projectRoot, "backend", "wrangler.jsonc")

function requireFile(filePath, label) {
  if (!existsSync(filePath)) {
    throw new Error(`${label} not found at ${filePath}`)
  }
}

function parseLatestYml(content) {
  const normalized = content.replace(/\r\n/g, "\n")
  const version = normalized.match(/^version:\s*(.+)$/m)?.[1]?.trim() || null
  const artifactName =
    normalized.match(/^path:\s*(.+)$/m)?.[1]?.trim() ||
    normalized.match(/^\s*-\s+url:\s*(.+)$/m)?.[1]?.trim() ||
    null

  if (!version || !artifactName) {
    throw new Error("Failed to parse versioned artifact information from latest.yml")
  }

  return {
    version: version.replace(/^['"]|['"]$/g, ""),
    artifactName: artifactName.replace(/^['"]|['"]$/g, ""),
  }
}

function getWranglerCommand() {
  const localWrangler = path.join(
    projectRoot,
    "backend",
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler"
  )

  if (existsSync(localWrangler)) {
    return {
      command: localWrangler,
      argsPrefix: [],
    }
  }

  return {
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    argsPrefix: ["--prefix", "backend", "wrangler"],
  }
}

function putObject(key, filePath) {
  const { command, argsPrefix } = getWranglerCommand()
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
  ]

  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    throw new Error(`Failed to upload ${key} (exit code ${result.status ?? -1})`)
  }
}

function main() {
  requireFile(latestYmlPath, "latest.yml")
  const latestYml = readFileSync(latestYmlPath, "utf8")
  const { version, artifactName } = parseLatestYml(latestYml)

  const installerPath = path.join(releaseDir, artifactName)
  const blockmapPath = path.join(releaseDir, `${artifactName}.blockmap`)

  requireFile(installerPath, "Windows installer")
  requireFile(blockmapPath, "Windows blockmap")

  console.log(`Publishing Windows update ${version} from ${releaseDir}`)
  putObject(`${updatePrefix}/${artifactName}`, installerPath)
  putObject(`${updatePrefix}/${artifactName}.blockmap`, blockmapPath)
  putObject(installerAlias, installerPath)
  putObject(`${updatePrefix}/latest.yml`, latestYmlPath)
  console.log(`Published ${artifactName}, blockmap, installer alias, and latest.yml`)
}

main()
