# opencode-telegram-agent

MCP server that connects your OpenCode agent to Telegram. Send messages to your user, receive replies back in the same session context, and manage sessions from Telegram.

## Install

```bash
npx opencode-telegram-agent
```

This clones the repo into `./tools/opencode-telegram-agent`, installs dependencies, and configures your `opencode.json` automatically.

### Manual install

```bash
git clone https://github.com/slack-space/opencode-telegram-agent.git ./tools/opencode-telegram-agent
cd tools/opencode-telegram-agent && npm install
```

## Configure

Set two environment variables before starting OpenCode:

```bash
export TELEGRAM_BOT_TOKEN="your-bot-token"
export TELEGRAM_ALLOWED_USERS="your-user-id"
```

Or create a `.env` file in your project root:

```
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_ALLOWED_USERS=your-user-id
```

### Get credentials

1. Message [@BotFather](https://t.me/BotFather) on Telegram, create a bot, copy the token.
2. Message [@userinfobot](https://t.me/userinfobot) to get your numeric user ID.
3. Open your bot in Telegram and press `/start`.

### OpenCode MCP config

The postinstall script adds this to your `opencode.json` automatically. If you need to configure it manually:

```json
{
  "mcp": {
    "opencode-telegram-agent": {
      "type": "local",
      "command": ["node", "tools/opencode-telegram-agent/mcp.js"]
    }
  }
}
```

## Tools

### `send_message`

Send a message to all allowed Telegram users.

| Parameter | Type   | Description           |
|-----------|--------|-----------------------|
| `text`    | string | Message text to send. |

### `reply_to_message`

Reply to a specific Telegram message by ID.

| Parameter    | Type   | Description                       |
|--------------|--------|-----------------------------------|
| `message_id` | number | Telegram message ID to reply to. |
| `text`       | string | Reply text.                       |

Both tools include rate limiting (10 messages/minute), automatic message splitting at Telegram's 4096-char limit, and session-aware routing so replies land in the correct agent session.

## Session Management

The bot tracks which OpenCode session to route messages to. Control it via Telegram commands:

### `/session`

Show current mode, active session, and help text.

### `/session most-recent`

Default mode. Routes messages to the active (busy) session, or the most recently updated session.

### `/session telegram-chat`

Routes messages to a dedicated `Telegram-{Username}` session. Creates it if it doesn't exist.

### `/session <name>`

Switch to a session by title match. Useful when you want to target a specific workflow.

### `/session_list N`

Show the N most recent sessions (default 3) with their status.

### `/session_find <str>`

Search sessions by title substring.

### `/session_rename <name>`

Rename the current session.

### Session routing

Messages route through a priority chain:

1. **MCP override** -- when the agent sends a Telegram message, the MCP automatically sets the reply session to the agent's current session. Expires after 6h (if newer sessions exist) or 24h. Auto-renews on each use.
2. **User-selected mode** -- `/session telegram-chat` or `/session <name>`.
3. **Smart resolution** -- busy session first, then most recently updated.
4. **Fallback** -- creates a new `Telegram-{Username}` session.

## Architecture

```
opencode desktop
  |
  +-- MCP server (mcp.js)
  |     |-- Exposes send_message / reply_to_message tools
  |     |-- OpenCode SDK client (discovers busy session)
  |     |-- IPC channel to listener (session routing)
  |     +-- Spawns listener as child process
  |
  +-- Listener (index.js)
        |-- Telegraf bot (long-polling)
        |-- Session resolver (MCP override > mode > smart > fallback)
        |-- promptAsync + SSE event stream (parentID matching)
        +-- /session commands
```

When the agent calls `send_message`, the MCP server discovers which session is currently busy (the caller's session) and notifies the listener via IPC. When the user replies on Telegram, the listener routes the reply to that session so the agent has full context.

## Configuration Reference

| Variable                 | Required | Description                                                    |
|--------------------------|----------|----------------------------------------------------------------|
| `TELEGRAM_BOT_TOKEN`     | yes      | Bot token from @BotFather                                      |
| `TELEGRAM_ALLOWED_USERS` | yes      | Comma-separated Telegram user IDs                              |
| `OPENCODE_PROJECT_DIR`   | no       | Working directory for the agent (defaults to cwd)              |
| `DOTENV_PATH`            | no       | Path to a .env file (auto-detected if adjacent to project root)|

## Alternative Usage

### CLI

Send one-off messages from a script or shell:

```bash
node tools/opencode-telegram-agent/cli.js send "Deploy complete"
node tools/opencode-telegram-agent/cli.js reply 4521 "Done"
```

### Standalone listener

Run the listener directly without MCP -- it starts its own OpenCode server:

```bash
TELEGRAM_BOT_TOKEN=... TELEGRAM_ALLOWED_USERS=... node tools/opencode-telegram-agent/index.js
```

## Troubleshooting

| Problem                           | Fix                                                                     |
|-----------------------------------|-------------------------------------------------------------------------|
| `Missing TELEGRAM_BOT_TOKEN`      | Set the env var in your shell, `.env` file, or MCP config               |
| `Missing TELEGRAM_ALLOWED_USERS`  | Set the env var -- comma-separated numeric user IDs                     |
| `403: Forbidden`                  | The user blocked the bot -- unblock it in Telegram                      |
| `400: chat not found`             | The user hasn't started the bot -- press `/start` in Telegram           |
| `port 14096 in use`               | Another listener is running -- kill it or restart OpenCode              |
| `/session` shows "Session: none"  | Send a text message first, or the session resolves on next message      |
| `No response from agent`          | Check listener log at `/tmp/opencode-telegram-agent-listener.log`       |

### Log files

| File                                          | Contents                          |
|-----------------------------------------------|-----------------------------------|
| `/tmp/opencode-telegram-agent-listener.log`   | Listener: sessions, prompts, SSE  |
| `/tmp/opencode-telegram-agent-mcp.log`        | MCP server: IPC, session discovery|

## License

MIT
