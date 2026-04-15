#!/usr/bin/env node

import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync } from "node:fs"
import { Telegraf } from "telegraf"

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load .env if available
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

const telegram = new Telegraf(BOT_TOKEN).telegram
const [,, cmd, ...args] = process.argv

async function run() {
  if (cmd === "send") {
    const text = args.join(" ")
    if (!text) {
      console.error('Usage: opencode-telegram-agent send "message"')
      process.exit(1)
    }
    // Send to all allowed users
    for (const chatId of ALLOWED_USERS) {
      await telegram.sendMessage(chatId, text)
    }
    console.log("Message sent.")
    process.exit(0)
  }

  if (cmd === "reply") {
    const messageId = args[0]
    const text = args.slice(1).join(" ")
    if (!messageId || !text) {
      console.error('Usage: opencode-telegram-agent reply <messageId> "message"')
      process.exit(1)
    }
    // Reply targets the first allowed user (DM model)
    await telegram.sendMessage(ALLOWED_USERS[0], text, {
      reply_parameters: { message_id: Number(messageId) },
    })
    console.log("Reply sent.")
    process.exit(0)
  }

  console.log(`opencode-telegram-agent — send messages via Telegram

Commands:
  send "message"                 Send a DM to all allowed users
  reply <messageId> "message"    Reply to a specific message
`)
}

run().catch((err) => {
  console.error("Error:", err.message)
  process.exit(1)
})
