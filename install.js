#!/usr/bin/env node

/**
 * Installer for opencode-telegram-agent.
 *
 * Usage:
 *   npx opencode-telegram-agent
 *
 * Clones the repo into ./tools/opencode-telegram-agent and runs npm install.
 * The postinstall script configures opencode.json automatically.
 */

import { execSync } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"

const REPO = "https://github.com/slack-space/opencode-telegram-agent.git"
const TOOLS_DIR = resolve(process.cwd(), "tools")
const TARGET = resolve(TOOLS_DIR, "opencode-telegram-agent")

function run() {
  if (existsSync(TARGET)) {
    console.log(`[opencode-telegram-agent] Already installed at ${TARGET}`)
    console.log(`  To update: cd ${TARGET} && git pull && npm install`)
    return
  }

  // Ensure tools/ directory exists
  if (!existsSync(TOOLS_DIR)) {
    mkdirSync(TOOLS_DIR, { recursive: true })
  }

  console.log(`[opencode-telegram-agent] Cloning into ${TARGET}...`)
  try {
    execSync(`git clone ${REPO} "${TARGET}"`, { stdio: "inherit" })
  } catch {
    console.error("[opencode-telegram-agent] git clone failed.")
    process.exit(1)
  }

  console.log(`[opencode-telegram-agent] Installing dependencies...`)
  try {
    execSync("npm install", { cwd: TARGET, stdio: "inherit" })
  } catch {
    console.error("[opencode-telegram-agent] npm install failed.")
    process.exit(1)
  }

  // postinstall.js runs automatically via npm install and configures opencode.json
  console.log()
  console.log("[opencode-telegram-agent] Installed successfully.")
}

run()
