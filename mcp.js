#!/usr/bin/env node

/**
 * MCP server for the Telegram agent.
 *
 * Does two things:
 *  1. Starts the bot listener (index.js) as a child process so inbound
 *     Telegram messages are proxied to an OpenCode agent.
 *  2. Exposes send_message / reply_to_message tools so the agent can
 *     send outbound messages to the user.
 *
 * opencode.json usage:
 *   "mcp": {
 *     "opencode-telegram-agent": {
 *       "type": "local",
 *       "command": ["node", "tools/opencode-telegram-agent/mcp.js"],
 *       "environment": {
 *         "TELEGRAM_BOT_TOKEN": "${TELEGRAM_BOT_TOKEN}",
 *         "TELEGRAM_ALLOWED_USERS": "${TELEGRAM_ALLOWED_USERS}"
 *       }
 *     }
 *   }
 */

import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createWriteStream, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { spawn } from "node:child_process"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { Telegraf } from "telegraf"

const __dirname = dirname(fileURLToPath(import.meta.url))

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const ALLOWED_USERS = (process.env.TELEGRAM_ALLOWED_USERS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)

// --- Telegram API (for outbound tools) ---

let telegram = null
if (BOT_TOKEN) {
  telegram = new Telegraf(BOT_TOKEN).telegram
}

// --- OpenCode SDK client (for session discovery) ---
// Created after server discovery so the MCP can find the busy session
// when send_message/reply_to_message is called.

let opclient = null

function splitMessage(text, maxLen = 4096) {
  if (text.length <= maxLen) return [text]
  const chunks = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining)
      break
    }
    let breakAt = remaining.lastIndexOf("\n", maxLen)
    if (breakAt < maxLen / 2) breakAt = maxLen
    chunks.push(remaining.slice(0, breakAt))
    remaining = remaining.slice(breakAt).trimStart()
  }
  return chunks
}

// --- Bot listener child process ---

let listenerProc = null
const mcpLogFile = resolve(tmpdir(), "opencode-telegram-agent.log")
const listenerLogFile = resolve(tmpdir(), "opencode-telegram-agent-listener.log")

// Log to both stderr (for MCP host) and a dedicated MCP log file
function log(text) {
  const line = `[mcp] ${text}\n`
  process.stderr.write(line)
  try { appendFileSync(mcpLogFile, line) } catch {}
}

async function discoverServer() {
  const pid = process.env.OPENCODE_PID
  if (!pid) return null

  const { execSync } = await import("node:child_process")
  try {
    const output = execSync(`lsof -p ${pid} -i -P -n 2>/dev/null`, { encoding: "utf8" })
    // Filter to only the line belonging to our PID (lsof can return other processes)
    for (const line of output.split("\n")) {
      if (line.includes(pid) && line.includes("LISTEN")) {
        const match = line.match(/(127\.0\.0\.1|localhost):(\d+)\s/)
        if (match) {
          return {
            url: `http://127.0.0.1:${match[2]}`,
            username: process.env.OPENCODE_SERVER_USERNAME || "",
            password: process.env.OPENCODE_SERVER_PASSWORD || "",
          }
        }
      }
    }
  } catch {
    // lsof failed — fall through
  }
  return null
}

async function startListener() {
  const listenerPath = resolve(__dirname, "index.js")

  // Discover the parent opencode server so the listener attaches
  // to it instead of starting its own.
  const server = await discoverServer()
  if (server) {
    log(`Discovered parent server: ${server.url}`)
  } else {
    log("No parent server found — listener will start its own.")
  }

  // Initialize OpenCode SDK client for session discovery
  if (server) {
    try {
      const { createOpencodeClient } = await import("@opencode-ai/sdk")
      const clientOpts = { baseUrl: server.url }
      if (server.username && server.password) {
        const token = Buffer.from(`${server.username}:${server.password}`).toString("base64")
        clientOpts.headers = { Authorization: `Basic ${token}` }
      }
      opclient = createOpencodeClient(clientOpts)
      log(`OpenCode SDK client connected to ${server.url}`)
    } catch (e) {
      log(`Warning: could not create OpenCode SDK client: ${e.message}`)
    }
  }

  listenerProc = spawn("node", [listenerPath], {
    env: {
      ...process.env,
      ...(server ? {
        OPENCODE_SERVER_URL: server.url,
        OPENCODE_SERVER_USERNAME: server.username,
        OPENCODE_SERVER_PASSWORD: server.password,
      } : {
        // Standalone: clear auth so nested server starts unsecured
        OPENCODE_SERVER_PASSWORD: "",
        OPENCODE_SERVER_USERNAME: "",
      }),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    detached: false,
  })

  const logStream = createWriteStream(listenerLogFile, { flags: "w" })

  listenerProc.stdout.on("data", (d) => logStream.write(d))
  listenerProc.stderr.on("data", (d) => logStream.write(d))
  listenerProc.on("exit", (code, signal) => {
    logStream.write(`\n[exited code=${code} signal=${signal}]\n`)
    logStream.end()
    log(`Listener exited (code=${code}, signal=${signal}). Log: ${listenerLogFile}`)
    listenerProc = null
  })

  log(`Listener started (pid=${listenerProc.pid}). Log: ${listenerLogFile}`)
}

// --- Session Discovery ---

async function findBusySession() {
  if (!opclient) return null
  try {
    const result = await opclient.session.status()
    for (const [id, s] of Object.entries(result.data || {})) {
      if (s?.status && s.status !== "idle") return id
    }
  } catch (e) {
    log(`findBusySession error: ${e.message}`)
  }
  return null
}

// Tell the listener to route the next inbound reply to this session
function notifyListenerSession(sessionId) {
  if (!sessionId || !listenerProc?.connected) return
  try {
    listenerProc.send({ type: "set-session", sessionId })
    log(`Notified listener: set-session ${sessionId}`)
  } catch (e) {
    log(`IPC send failed: ${e.message}`)
  }
}

// --- Helpers ---

function ok(msg) {
  return { content: [{ type: "text", text: msg }] }
}

function error(msg) {
  return { content: [{ type: "text", text: msg }], isError: true }
}

function preflight() {
  if (!telegram) return error("TELEGRAM_BOT_TOKEN not configured.")
  if (!ALLOWED_USERS.length) return error("TELEGRAM_ALLOWED_USERS not configured.")
  return null
}

// Simple sliding-window rate limiter: max 10 messages per 60 seconds
const RATE_LIMIT = 10
const RATE_WINDOW = 60_000
const sendTimestamps = []

function rateLimit() {
  const now = Date.now()
  // Evict timestamps outside the window
  while (sendTimestamps.length && sendTimestamps[0] <= now - RATE_WINDOW) {
    sendTimestamps.shift()
  }
  if (sendTimestamps.length >= RATE_LIMIT) return false
  sendTimestamps.push(now)
  return true
}

function telegramError(e) {
  const code = e?.response?.error_code || e?.code
  const desc = e?.response?.description || e?.message || "Unknown error"

  if (code === 403) return `Telegram 403: Bot was blocked by the user. They must unblock it.`
  if (code === 400 && desc.includes("chat not found")) return `Telegram 400: Chat not found. The user must /start the bot first.`
  if (code === 429) {
    const retry = e?.response?.parameters?.retry_after || 30
    return `Telegram 429: Rate limited by Telegram. Retry after ${retry} seconds.`
  }
  return `Telegram error (${code || "unknown"}): ${desc}`
}

// --- MCP Server ---

const server = new McpServer({
  name: "opencode-telegram-agent",
  version: "1.0.0",
})

server.tool(
  "send_message",
  "Send a Telegram direct message to the user. Use this to notify the user of completed work, status updates, alerts, or any other information.",
  { text: z.string().min(1, "Message text cannot be empty.").max(50000, "Message too long (50k char max).").describe("The message text to send.") },
  async ({ text }) => {
    const check = preflight()
    if (check) return check
    if (!rateLimit()) return error("Rate limit: max 10 messages per minute. Wait and try again.")

    // Notify the listener which session this message came from,
    // so inbound replies route back to the same session.
    log(`send_message: opclient=${!!opclient}, listenerConnected=${listenerProc?.connected}`)
    const busyId = await findBusySession()
    log(`send_message: busySession=${busyId}`)
    notifyListenerSession(busyId)

    try {
      const chunks = splitMessage(text)
      for (const chatId of ALLOWED_USERS) {
        for (const chunk of chunks) {
          await telegram.sendMessage(chatId, chunk)
        }
      }
      return ok("Message sent.")
    } catch (e) {
      return error(telegramError(e))
    }
  },
)

server.tool(
  "reply_to_message",
  "Reply to a specific Telegram message by its message ID. Only use this if you have a message ID to reply to. Otherwise use send_message.",
  {
    message_id: z.number().int().positive().describe("The Telegram message ID to reply to."),
    text: z.string().min(1, "Reply text cannot be empty.").max(50000, "Message too long (50k char max).").describe("The reply text."),
  },
  async ({ message_id, text }) => {
    const check = preflight()
    if (check) return check
    if (!rateLimit()) return error("Rate limit: max 10 messages per minute. Wait and try again.")

    // Notify the listener which session this reply came from
    const busyId = await findBusySession()
    notifyListenerSession(busyId)

    try {
      const chunks = splitMessage(text)
      for (let i = 0; i < chunks.length; i++) {
        await telegram.sendMessage(ALLOWED_USERS[0], chunks[i], {
          reply_parameters: i === 0 ? { message_id: Number(message_id) } : undefined,
        })
      }
      return ok("Reply sent.")
    } catch (e) {
      return error(telegramError(e))
    }
  },
)

// --- Start ---

const transport = new StdioServerTransport()
await server.connect(transport)

log("MCP server connected, starting listener...")
await startListener()

// Clean up listener on exit
process.on("exit", () => {
  if (listenerProc) listenerProc.kill()
})
process.on("SIGINT", () => process.exit(0))
process.on("SIGTERM", () => process.exit(0))
