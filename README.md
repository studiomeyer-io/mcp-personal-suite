<div align="center">

# mcp-personal-suite

**Local-first personal productivity MCP server. 49 tools. BYOK. No cloud. No signup.**

Email, Calendar, Messaging, Search, Image Generation — all in one MCP server,
running entirely on your machine. Works with Claude Desktop, Claude Code, Cursor,
and any MCP client.

[![npm](https://img.shields.io/npm/v/mcp-personal-suite)](https://www.npmjs.com/package/mcp-personal-suite)
[![downloads](https://img.shields.io/npm/dm/mcp-personal-suite)](https://www.npmjs.com/package/mcp-personal-suite)
[![license](https://img.shields.io/npm/l/mcp-personal-suite)](./LICENSE)
[![node](https://img.shields.io/node/v/mcp-personal-suite)](./package.json)

[Quick Start](#quick-start) · [Modules](#49-tools-6-modules) · [Config](#config) · [Privacy](#privacy) · [ECOSYSTEM](./ECOSYSTEM.md)

</div>

---

## Why

Managing email, calendar, messaging, search, and image generation from an AI
assistant usually means five to six separate MCP servers, each with its own
install, OAuth dance, and API keys. This bundles all of it into one server that
runs on your laptop.

Everything stays local. Your credentials live in `~/.personal-suite/config.json`
with `0600` permissions and AES-256-GCM encryption at rest. The only data that
ever leaves your machine is the direct API call to the provider you configured.
No signup, no backend, no tenant database.

Bring your own keys (BYOK) for Brave, Exa, Tavily, OpenAI, Gemini, and so on.
Messaging uses your own bot tokens (BotFather for Telegram, Discord developer
portal, Slack app, etc.). Email uses Gmail/Outlook OAuth or plain IMAP with
auto-discovery for 30,000+ providers.

## Quick Start

```bash
# Claude Desktop: add to claude_desktop_config.json
{
  "mcpServers": {
    "personal-suite": {
      "command": "npx",
      "args": ["-y", "mcp-personal-suite"]
    }
  }
}

# Claude Code
claude mcp add personal-suite -- npx -y mcp-personal-suite

# Cursor: same stdio command as Claude
```

Then in chat:

```
"What's configured?"                         → suite_status
"Show me the quickstart guide"               → suite_guide
"Set up email for info@example.com"          → suite_setup (module: email)
"What's on my calendar today?"               → calendar_list_events
"Send a Telegram to the team"                → channel_send
```

First-time setup wizard (optional, for Google OAuth):

```bash
npx mcp-personal-suite setup
```

## 49 Tools, 6 Modules

### Email — `email_*` (15 tools)
Gmail OAuth2, Outlook OAuth2, generic IMAP/SMTP. Auto-discovery for 30K+
providers (Gmail, Outlook, Yahoo, iCloud, WEB.DE, GMX, T-Online, mailbox.org,
Posteo, IONOS, Strato, Fastmail, ProtonMail Bridge, and many more). Attachments
up to 25 MB with path-traversal protection.

```
email_status    email_setup       email_auth       email_list       email_read
email_send      email_reply       email_forward    email_search     email_threads
email_move      email_mark_read   email_mark_unread  email_delete   email_folders
```

### Calendar — `calendar_*` (11 tools)
Google Calendar (OAuth2) plus CalDAV (Apple iCloud, Nextcloud, mailbox.org,
Posteo, Radicale, any CalDAV server). Events, availability, conflict detection,
Meet links, daily summaries. Provider-transparent: same tools for both.

```
calendar_status            calendar_list_events         calendar_get_event
calendar_create_event      calendar_update_event        calendar_delete_event
calendar_search_events     calendar_list_calendars      calendar_check_availability
calendar_upcoming          calendar_daily_summary
```

### Messaging — `channel_*` (8 tools)
Telegram (grammy), Discord (discord.js), Slack (@slack/bolt), WhatsApp (Baileys).
Bring your own bot tokens. Send, receive, broadcast, history.

```
channel_status    channel_send       channel_receive     channel_list
channel_connect   channel_disconnect channel_broadcast   channel_history
```

### Search — `search_*` (7 tools)
Multi-provider gateway (BYOK): SearXNG (self-hosted), Brave, Exa (neural),
Tavily (research with citations). Web, news, images, deep research, semantic,
code context.

```
search_web      search_news          search_images   search_deep
search_semantic search_code_context  search_research
```

### Image — `image_*` (3 tools)
BYOK image generation: OpenAI DALL-E 3, Flux via fal.ai (photorealistic),
Google Gemini Imagen 3 (product shots). Auto-routing by prompt type.

```
image_generate   image_edit   image_download
```

### System — `suite_*` (5 tools)
Onboarding, status, setup wizard, health checks, embedded documentation, GDPR
delete (per-module or complete wipe).

```
suite_status   suite_setup   suite_health   suite_guide   suite_delete
```

## Config

Credentials live in a single JSON file:

- **macOS / Linux:** `~/.personal-suite/config.json`
- **Windows:** `%USERPROFILE%\.personal-suite\config.json`

Permissions are forced to `0600` (owner read/write only). Sensitive fields
(passwords, tokens, secrets, API keys) are encrypted with AES-256-GCM before
being written. The encryption key is auto-generated in `~/.personal-suite/.key`
on first run, or you can provide your own via the `CREDENTIAL_ENCRYPTION_KEY`
environment variable (32 bytes, base64).

Nothing ever leaves your machine except the direct API calls you make to the
providers you explicitly configure.

## Privacy

- No signup, no account, no telemetry.
- No outbound requests until you configure a module.
- Credentials encrypted at rest, file mode `0600`.
- `suite_delete(module: "all", confirm: true)` wipes everything.
- MIT licensed. Read the source. Fork it if you want.

## Development

```bash
git clone https://github.com/studiomeyer-io/mcp-personal-suite.git
cd mcp-personal-suite
npm install
npm run build
npm test             # ~400 tests, runs in under 5s
npm run dev          # watch-mode stdio
npm run start:http   # HTTP transport on :5120
```

### HTTP Transport (self-hosted)

If you want a long-running server for multiple clients on your LAN:

```bash
mcp-personal-suite --http --port=5120
```

Point your MCP client at `http://localhost:5120/mcp`. Streamable HTTP, session
management included. Bind it behind your own reverse proxy if you expose it.

### Docker

```bash
docker build -t personal-suite .
docker run -d --network host \
  -v $HOME/.personal-suite:/root/.personal-suite \
  -e MCP_HTTP=1 -e MCP_PORT=5120 \
  personal-suite
```

## Tech

- TypeScript strict, no `any`, no circular deps
- `@modelcontextprotocol/sdk@^1.26.0`
- `imapflow` (async IMAP with auto-reconnect), `nodemailer` (SMTP)
- `googleapis` (Gmail + Calendar OAuth)
- `ts-caldav` (Apple iCloud, Nextcloud, Radicale)
- `grammy`, `discord.js`, `@slack/bolt`, `@whiskeysockets/baileys`
- `vitest` for tests, stdio + Streamable HTTP dual transport

## Related

- [local-memory-mcp](https://github.com/studiomeyer-io/local-memory-mcp) —
  persistent local memory for Claude, Cursor, Codex. Pairs nicely with this.
- [mcp-video](https://github.com/studiomeyer-io/mcp-video) — cinema-grade video
  production (ffmpeg + Playwright).
- [agent-fleet](https://github.com/studiomeyer-io/agent-fleet) — multi-agent
  orchestration for Claude Code.
- [ai-shield](https://github.com/studiomeyer-io/ai-shield) — LLM security for
  TypeScript (prompt injection, PII, cost control).
- [darwin-agents](https://github.com/studiomeyer-io/darwin-agents) —
  self-evolving prompts via A/B testing.

## License

[MIT](./LICENSE). Built by [StudioMeyer](https://studiomeyer.io).
