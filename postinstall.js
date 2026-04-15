#!/usr/bin/env node

/**
 * Postinstall script for opencode-telegram-agent.
 *
 * Finds the project's opencode.json (walking up from the install location)
 * and ensures the telegram-agent MCP server is configured.
 *
 * - If opencode.json doesn't exist, creates one with the MCP config.
 * - If the MCP entry already exists, validates the command path.
 * - If the MCP entry is missing, adds it.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { dirname, resolve, relative, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const mcpScript = resolve(__dirname, "mcp.js")

const MCP_KEY = "opencode-telegram-agent"

// Walk up from the package directory to find the project root.
// Looks for opencode.json, then falls back to .git or a root package.json
// that isn't inside node_modules.
function findProjectRoot() {
  let dir = __dirname
  for (let i = 0; i < 20; i++) {
    // Prefer a directory that already has opencode.json
    if (existsSync(join(dir, "opencode.json"))) return dir

    // Accept .git as a project root marker (but only if we've left node_modules)
    if (!dir.includes("node_modules") && existsSync(join(dir, ".git"))) return dir

    const parent = dirname(dir)
    if (parent === dir) break // filesystem root
    dir = parent
  }
  return null
}

function buildCommand(projectRoot) {
  const rel = relative(projectRoot, mcpScript).replace(/\\/g, "/")
  return ["node", rel]
}

function buildMcpEntry(projectRoot) {
  return {
    type: "local",
    command: buildCommand(projectRoot),
  }
}

function run() {
  const projectRoot = findProjectRoot()
  if (!projectRoot) {
    console.log("[opencode-telegram-agent] Could not find project root. Skipping opencode.json configuration.")
    console.log("[opencode-telegram-agent] Add the MCP config manually — see README.md for details.")
    return
  }

  const configPath = resolve(projectRoot, "opencode.json")
  let config = {}
  let existed = false

  // Read existing config if present
  if (existsSync(configPath)) {
    existed = true
    try {
      config = JSON.parse(readFileSync(configPath, "utf8"))
    } catch (e) {
      console.error(`[opencode-telegram-agent] Failed to parse ${configPath}: ${e.message}`)
      console.error("[opencode-telegram-agent] Skipping opencode.json configuration.")
      return
    }
  }

  // Ensure mcp block exists
  if (!config.mcp || typeof config.mcp !== "object") {
    config.mcp = {}
  }

  const expectedCommand = buildCommand(projectRoot)
  const entry = config.mcp[MCP_KEY]

  if (entry) {
    // Validate existing entry
    const currentCmd = entry.command
    const cmdMatch =
      Array.isArray(currentCmd) &&
      currentCmd.length === expectedCommand.length &&
      currentCmd.every((v, i) => v === expectedCommand[i])

    if (cmdMatch && entry.type === "local") {
      console.log(`[opencode-telegram-agent] opencode.json already configured correctly.`)
      return
    }

    // Update the command path if it changed (e.g., package moved)
    const prev = Array.isArray(currentCmd) ? currentCmd.join(" ") : JSON.stringify(currentCmd)
    entry.type = "local"
    entry.command = expectedCommand
    console.log(`[opencode-telegram-agent] Updated command path in opencode.json:`)
    console.log(`  was:  ${prev}`)
    console.log(`  now:  ${expectedCommand.join(" ")}`)
  } else {
    // Add new entry
    config.mcp[MCP_KEY] = buildMcpEntry(projectRoot)
    console.log(`[opencode-telegram-agent] Added MCP config to ${existed ? "existing" : "new"} opencode.json`)
  }

  // Write config — preserve formatting with 2-space indent
  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8")
    console.log(`[opencode-telegram-agent] Wrote ${configPath}`)
  } catch (e) {
    console.error(`[opencode-telegram-agent] Failed to write ${configPath}: ${e.message}`)
    console.error("[opencode-telegram-agent] Add the MCP config manually — see README.md for details.")
    return
  }

  // Remind about env vars
  console.log()
  console.log("[opencode-telegram-agent] Configuration complete. Set these env vars before starting opencode:")
  console.log("  TELEGRAM_BOT_TOKEN       — from @BotFather on Telegram")
  console.log("  TELEGRAM_ALLOWED_USERS   — your numeric Telegram user ID")
  console.log()
  console.log("  Or create a .env file in the project root.")
}

run()
