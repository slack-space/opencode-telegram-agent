#!/usr/bin/env node

import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync } from "node:fs"
import { Telegraf } from "telegraf"
import { createOpencode } from "@opencode-ai/sdk"

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load .env if dotenv is available and a .env file exists nearby.
// When installed as a package, env vars come from the MCP config instead.
const envPath = process.env.DOTENV_PATH || resolve(__dirname, "..", ".env")
if (existsSync(envPath)) {
  const { config } = await import("dotenv")
  config({ path: envPath })
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const ALLOWED_USERS = (process.env.TELEGRAM_ALLOWED_USERS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)

if (!BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN")
  process.exit(1)
}
if (!ALLOWED_USERS.length) {
  console.error("Missing TELEGRAM_ALLOWED_USERS")
  process.exit(1)
}

// --- OpenCode SDK ---
// Work in the project directory or cwd
const workDir = process.env.OPENCODE_PROJECT_DIR || process.cwd()
process.chdir(workDir)

let client
let server = null

const isAttached = !!process.env.OPENCODE_SERVER_URL

if (isAttached) {
  // Attach to the parent opencode server (discovered by mcp.js)
  const { createOpencodeClient } = await import("@opencode-ai/sdk")
  const clientOpts = { baseUrl: process.env.OPENCODE_SERVER_URL }

  // Pass credentials as Basic auth header if provided
  const user = process.env.OPENCODE_SERVER_USERNAME
  const pass = process.env.OPENCODE_SERVER_PASSWORD
  if (user && pass) {
    const token = Buffer.from(`${user}:${pass}`).toString("base64")
    clientOpts.headers = { Authorization: `Basic ${token}` }
  }

  client = createOpencodeClient(clientOpts)
  console.log(`Attached to OpenCode server at ${process.env.OPENCODE_SERVER_URL}`)
} else {
  // Standalone mode — start our own opencode server.
  // Use port 14096 to avoid conflicts with a parent opencode instance.
  // Disable MCP in the nested server to prevent recursive startup.
  console.log("Starting opencode server on port 14096...")
  try {
    const result = await createOpencode({
      port: 14096,
      timeout: 30_000,
      config: { mcp: {} },
    })
    client = result.client
    server = result.server
    console.log(`OpenCode server running at ${server.url}`)
  } catch (e) {
    console.error("Failed to start opencode server:", e.message)
    process.exit(1)
  }
}

// --- Session Management ---

// MCP override: set via IPC when the agent sends a Telegram message.
// Tells the listener to route the next reply to the calling session.
let mcpSessionOverride = null // { sessionId, renewedAt }

// Listen for IPC messages from mcp.js (only available when spawned with IPC channel)
const hasIPC = typeof process.send === "function"
console.log(`IPC channel: ${hasIPC ? "available" : "not available"}`)
if (hasIPC) {
  process.on("message", (msg) => {
    console.log(`IPC message received: ${JSON.stringify(msg)}`)
    if (msg?.type === "set-session") {
      mcpSessionOverride = { sessionId: msg.sessionId, renewedAt: Date.now() }
      console.log(`MCP set session override: ${msg.sessionId}`)
    }
  })
}

// Per-user session state
const userSessions = new Map()
// Each entry: userId -> { sessionId, mode }
// mode: "most-recent" | "telegram-chat"

function getUserState(userId) {
  if (!userSessions.has(userId)) {
    userSessions.set(userId, { sessionId: null, mode: "most-recent" })
  }
  return userSessions.get(userId)
}

// Check if the MCP override has expired using smart expiry logic:
// - 6 hours if a newer session (by update time) exists on the server
// - 24 hours otherwise
async function isOverrideExpired(override) {
  const age = Date.now() - override.renewedAt
  try {
    const sessions = (await client.session.list()).data || []
    const newerExists = sessions.some(s =>
      s.id !== override.sessionId && (s.time.updated * 1000) > override.renewedAt
    )
    const maxAge = newerExists ? 6 * 3600_000 : 24 * 3600_000
    return age > maxAge
  } catch {
    // If we can't check, use the shorter timeout
    return age > 6 * 3600_000
  }
}

async function findActiveSession() {
  // Look for the most recently updated non-idle session, or the most recent session overall.
  try {
    const statusResult = await client.session.status()
    if (statusResult.error) {
      console.error("session.status error:", JSON.stringify(statusResult.error))
    }
    const statuses = statusResult.data || {}

    // Find a session that's currently busy (the desktop agent is working)
    for (const [id, status] of Object.entries(statuses)) {
      if (status?.status && status.status !== "idle") {
        return id
      }
    }

    // Otherwise find the most recently updated session
    const listResult = await client.session.list()
    if (listResult.error) {
      console.error("session.list error:", JSON.stringify(listResult.error))
    }
    const sessions = listResult.data || []
    if (sessions.length > 0) {
      // Sessions come sorted by recency from the API
      return sessions[0].id
    }
  } catch (e) {
    console.error("findActiveSession failed:", e.message)
  }

  return null
}

// Telegram-chat fallback: find or create a "Telegram-{Username}" session
let telegramChatSessionId = null

async function findOrCreateTelegramChat(displayName) {
  const title = `Telegram-${displayName}`

  // Check cache
  if (telegramChatSessionId) {
    try {
      const result = await client.session.get({ path: { id: telegramChatSessionId } })
      if (result.data?.id) return telegramChatSessionId
    } catch { telegramChatSessionId = null }
  }

  // Search existing sessions
  const sessions = (await client.session.list()).data || []
  const existing = sessions.find(s => s.title === title)
  if (existing) {
    telegramChatSessionId = existing.id
    return existing.id
  }

  // Create new
  const result = await client.session.create({ body: { title } })
  if (!result.data?.id) {
    throw new Error(`session.create failed: ${JSON.stringify(result.error ?? "no data returned")}`)
  }
  telegramChatSessionId = result.data.id
  console.log(`Created telegram-chat session: ${telegramChatSessionId} ("${title}")`)
  return telegramChatSessionId
}

// Find a session by title substring match
async function findSessionByTitle(query) {
  const sessions = (await client.session.list()).data || []
  const lower = query.toLowerCase()
  return sessions.find(s => s.title?.toLowerCase().includes(lower)) || null
}

// Get session title by ID
async function getSessionTitle(sessionId) {
  if (!sessionId) return null
  try {
    const result = await client.session.get({ path: { id: sessionId } })
    return result.data?.title || null
  } catch { return null }
}

async function resolveSessionId(userId, displayName) {
  const state = getUserState(userId)

  // Priority 1: MCP override (agent sent a message, user is replying)
  if (mcpSessionOverride) {
    const expired = await isOverrideExpired(mcpSessionOverride)
    if (!expired) {
      const sid = mcpSessionOverride.sessionId
      mcpSessionOverride.renewedAt = Date.now() // auto-renew on use
      if (state.sessionId !== sid) {
        console.log(`Using MCP override session: ${sid}`)
      }
      state.sessionId = sid
      return sid
    }
    console.log(`MCP override expired, clearing`)
    mcpSessionOverride = null
  }

  // Priority 2: telegram-chat mode
  if (state.mode === "telegram-chat") {
    const sid = await findOrCreateTelegramChat(displayName)
    state.sessionId = sid
    return sid
  }

  // Priority 3: most-recent (default) — smart resolution
  if (isAttached) {
    const activeId = await findActiveSession()
    if (activeId) {
      if (state.sessionId !== activeId) {
        console.log(`${state.sessionId ? "Switching" : "Using"} active session: ${activeId}`)
      }
      state.sessionId = activeId
      return activeId
    }
  }

  // Standalone mode: reuse cached session if we have one
  if (state.sessionId) {
    return state.sessionId
  }

  // Fallback: create new Telegram-{Username} session
  const sid = await findOrCreateTelegramChat(displayName)
  state.sessionId = sid
  return sid
}

// Send prompt and wait for completion via event stream
async function promptAndWait(sessionId, text) {
  // Subscribe to events before sending prompt
  const events = await client.event.subscribe()

  console.log(`Sending prompt to session ${sessionId}: "${text.slice(0, 80)}"`)

  await client.session.promptAsync({
    path: { id: sessionId },
    body: {
      parts: [{ type: "text", text }],
    },
  })

  // Track the user message we just created so we can find the assistant
  // response that is a direct reply to it (parentID match).
  let userMessageId = null
  let assistantMessageId = null
  let error = null

  try {
    for await (const event of events.stream) {
      const payload = event.payload || event
      const type = payload.type || event.type

      // Session error
      if (type === "session.error") {
        const props = payload.properties
        if (props?.id === sessionId || !props?.id) {
          error = props?.error?.data?.message || "Agent error"
          break
        }
      }

      // Capture our user message ID
      if (type === "message.updated") {
        const msg = payload.properties?.info
        if (!msg || msg.sessionID !== sessionId) continue

        if (msg.role === "user" && !userMessageId) {
          userMessageId = msg.id
          console.log(`User message created: ${userMessageId}`)
        }

        // Match assistant response to OUR user message via parentID
        if (msg.role === "assistant") {
          const isOurs = !userMessageId || msg.parentID === userMessageId
          if (isOurs) {
            assistantMessageId = msg.id
            if (msg.time?.completed) {
              console.log(`Assistant response completed: ${assistantMessageId}`)
              break
            }
          }
        }
      }
    }
  } catch (e) {
    error = e.message
  }

  if (error) {
    throw new Error(error)
  }

  if (!assistantMessageId) {
    console.log("No assistant message ID captured")
    return null
  }

  // Fetch the specific assistant message
  const msgResult = await client.session.message({
    path: { id: sessionId, messageID: assistantMessageId },
  })

  const parts = msgResult.data?.parts || []
  const texts = parts
    .filter(p => p.type === "text")
    .map(p => p.text)
    .filter(Boolean)

  console.log(`Response: ${texts.length} text parts, ${texts.join("").length} chars`)
  return texts.join("\n") || null
}

// Telegram has a 4096 char limit per message
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

// --- Telegram Bot ---
const bot = new Telegraf(BOT_TOKEN)

function isAllowed(ctx) {
  return ALLOWED_USERS.includes(String(ctx.from.id))
}

// /start command — formatted date/time
bot.start((ctx) => {
  if (!isAllowed(ctx)) return

  const now = new Date()
  const tz = "America/New_York"
  const weekday = now.toLocaleString("en-US", { weekday: "long", timeZone: tz })
  const month = now.toLocaleString("en-US", { month: "short", timeZone: tz })
  const day = now.toLocaleString("en-US", { day: "2-digit", timeZone: tz })
  const year = now.toLocaleString("en-US", { year: "numeric", timeZone: tz })
  const time = now
    .toLocaleString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: tz,
    })
    .replace(" ", "")

  ctx.reply(`${weekday}, ${month} ${day} ${year} - ${time} - ${tz}`)
})

// --- Session Commands ---

// /session — mode switching + status
bot.command("session", async (ctx) => {
  if (!isAllowed(ctx)) return

  const userId = String(ctx.from.id)
  const displayName = ctx.from.first_name || "User"
  const state = getUserState(userId)
  const arg = (ctx.payload || "").trim()

  // No args or --help: show status + help
  if (!arg || arg === "--help") {
    // Resolve what session WOULD be used for the next message
    if (!state.sessionId && isAttached) {
      try {
        const resolved = await findActiveSession()
        if (resolved) state.sessionId = resolved
      } catch {}
    }

    const title = await getSessionTitle(state.sessionId)
    const mode = state.mode || "most-recent"
    const sid = state.sessionId
    const short = sid ? sid.slice(0, 16) + "..." : "none"
    const override = mcpSessionOverride ? ` (MCP override active)` : ""

    const lines = [
      `Current: ${mode}${override}`,
      sid ? `Session: "${title || "untitled"}" (${short})` : "Session: none",
      "",
      `/session most-recent — Smart session resolution (default)`,
      `/session telegram-chat — Dedicated fallback (Telegram-${displayName})`,
      `/session <name> — Switch to a session by title match`,
      "",
      `/session_list N — Show N most recent sessions (default 3)`,
      `/session_find <str> — Search sessions by title substring`,
      `/session_rename <name> — Rename the current session`,
    ]
    return ctx.reply(lines.join("\n"))
  }

  // /session most-recent
  if (arg === "most-recent") {
    state.mode = "most-recent"
    mcpSessionOverride = null // clear override
    return ctx.reply("Mode set to most-recent. Next message will use smart session resolution.")
  }

  // /session telegram-chat
  if (arg === "telegram-chat") {
    state.mode = "telegram-chat"
    mcpSessionOverride = null // clear override
    try {
      const sid = await findOrCreateTelegramChat(displayName)
      state.sessionId = sid
      return ctx.reply(`Mode set to telegram-chat. Using "Telegram-${displayName}" (${sid.slice(0, 16)}...).`)
    } catch (e) {
      return ctx.reply(`Error creating telegram-chat session: ${e.message}`)
    }
  }

  // /session <name> — switch to a session by title match
  try {
    const match = await findSessionByTitle(arg)
    if (match) {
      state.sessionId = match.id
      state.mode = "most-recent" // resume smart resolution after this
      mcpSessionOverride = null
      return ctx.reply(`Switched to "${match.title}" (${match.id.slice(0, 16)}...).`)
    }
    return ctx.reply(`No session found matching "${arg}". Use /session_list to see available sessions.`)
  } catch (e) {
    return ctx.reply(`Error: ${e.message}`)
  }
})

// /session_list — show N most recent sessions
bot.command("session_list", async (ctx) => {
  if (!isAllowed(ctx)) return

  const arg = (ctx.payload || "").trim()
  const count = parseInt(arg, 10) || 3

  try {
    const sessions = (await client.session.list()).data || []
    if (!sessions.length) {
      return ctx.reply("No sessions found.")
    }

    const state = getUserState(String(ctx.from.id))
    const statusResult = await client.session.status()
    const statuses = statusResult.data || {}

    const lines = sessions.slice(0, count).map((s, i) => {
      const status = statuses[s.id]?.status || "idle"
      const current = s.id === state.sessionId ? " *current*" : ""
      const title = s.title || "untitled"
      return `${i + 1}. ${title} (${status})${current}`
    })

    lines.push("", `Use /session <name> to switch.`)
    return ctx.reply(lines.join("\n"))
  } catch (e) {
    return ctx.reply(`Error: ${e.message}`)
  }
})

// /session_find — search sessions by title substring
bot.command("session_find", async (ctx) => {
  if (!isAllowed(ctx)) return

  const query = (ctx.payload || "").trim()
  if (!query) {
    return ctx.reply("Usage: /session_find <search term>")
  }

  try {
    const sessions = (await client.session.list()).data || []
    const lower = query.toLowerCase()
    const matches = sessions.filter(s => s.title?.toLowerCase().includes(lower))

    if (!matches.length) {
      return ctx.reply(`No sessions matching "${query}".`)
    }

    const lines = matches.slice(0, 10).map((s, i) => {
      const title = s.title || "untitled"
      return `${i + 1}. ${title} (${s.id.slice(0, 16)}...)`
    })
    if (matches.length > 10) lines.push(`... and ${matches.length - 10} more`)
    lines.push("", `Use /session <name> to switch.`)
    return ctx.reply(lines.join("\n"))
  } catch (e) {
    return ctx.reply(`Error: ${e.message}`)
  }
})

// /session_rename — rename the current session
bot.command("session_rename", async (ctx) => {
  if (!isAllowed(ctx)) return

  const newName = (ctx.payload || "").trim()
  if (!newName) {
    return ctx.reply("Usage: /session_rename <new name>")
  }

  const state = getUserState(String(ctx.from.id))
  if (!state.sessionId) {
    return ctx.reply("No active session to rename. Send a message first.")
  }

  try {
    await client.session.update({
      path: { id: state.sessionId },
      body: { title: newName },
    })
    return ctx.reply(`Session renamed to "${newName}".`)
  } catch (e) {
    return ctx.reply(`Error renaming session: ${e.message}`)
  }
})

// --- Text Message Handler ---

bot.on("text", async (ctx) => {
  if (ctx.from.is_bot) return
  if (!isAllowed(ctx)) return

  const userId = String(ctx.from.id)
  const displayName = ctx.from.first_name || "User"

  // Send typing indicator periodically while processing
  const typingInterval = setInterval(() => {
    ctx.sendChatAction("typing").catch(() => {})
  }, 4000)
  await ctx.sendChatAction("typing").catch(() => {})

  try {
    const sessionId = await resolveSessionId(userId, displayName)
    const responseText = await promptAndWait(sessionId, ctx.message.text)

    clearInterval(typingInterval)

    if (!responseText) {
      await ctx.reply("No response from agent.", {
        reply_parameters: { message_id: ctx.message.message_id },
      })
      return
    }

    const chunks = splitMessage(responseText)
    for (const chunk of chunks) {
      await ctx.reply(chunk, {
        reply_parameters: { message_id: ctx.message.message_id },
      })
    }
  } catch (err) {
    clearInterval(typingInterval)
    console.error("Error processing message:", err)

    // If session errored, clear it so next message creates a fresh one
    const state = getUserState(userId)
    state.sessionId = null

    await ctx.reply(`Error: ${err.message}`, {
      reply_parameters: { message_id: ctx.message.message_id },
    })
  }
})

bot.launch()
console.log("Telegram bot started. Allowed users:", ALLOWED_USERS.join(", "))

// Graceful shutdown
function shutdown(signal) {
  console.log(`${signal} received, shutting down...`)
  bot.stop(signal)
  if (server) server.close()
  process.exit(0)
}
process.once("SIGINT", () => shutdown("SIGINT"))
process.once("SIGTERM", () => shutdown("SIGTERM"))
