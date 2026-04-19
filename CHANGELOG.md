# Changelog

All notable changes to mcp-personal-suite are documented here.

## [0.5.1] - 2026-04-19

### Security
- **CORS strict by default** (`src/lib/dual-transport.ts`). Previously the
  HTTP transport set `Access-Control-Allow-Origin: *` unconditionally, which
  exposed `localhost:5120` to CSRF from any page a user browsed to. The new
  default sends no CORS headers — browser clients must be explicitly
  whitelisted via `MCP_ALLOWED_ORIGINS` (comma-separated). stdio and
  server-to-server clients are unaffected (no `Origin` header).
- **Removed hostname-derived encryption-key fallback** (`src/lib/crypto.ts`).
  When the key file was unwritable and no `CREDENTIAL_ENCRYPTION_KEY` env was
  set, the code previously fell back to `sha256(homedir() + '-personal-suite')`
  — a deterministic key an attacker with config-file access could reproduce.
  The fallback is now a hard error telling the user how to fix it properly.
- **Session cap on HTTP transport** (`src/lib/dual-transport.ts`). New sessions
  beyond `MCP_MAX_SESSIONS` (default `100`) receive `503 Retry-After: 60`.
  Prevents OOM from session-creation floods.
- **`overrides: { protobufjs: "^7.5.5" }`** pins the transitive `protobufjs`
  via Baileys → `@whiskeysockets/libsignal-node` above the arbitrary-code-
  execution advisory (GHSA-xq3m-2v4x-88gg). `npm audit` now clean.

### Documentation
- README: Baileys supply-chain warning added to the Messaging section. For
  production WhatsApp use the official Business API.
- README: HTTP-mode env vars documented (`MCP_ALLOWED_ORIGINS`,
  `MCP_MAX_SESSIONS`, `MCP_HOST`).

## [0.5.0] - 2026-04-19

### Changed
- **Repositioned as local-first, BYOK, no cloud.** Removed the hosted SaaS layer
  (OAuth 2.1 server, multi-tenant DB, magic-link onboarding, signup webhook,
  tier gating). This release is fully self-contained — nothing leaves your
  machine except the direct API calls you make to configured providers.
- Instructions, embedded guide, and CLI setup wizard rewritten for local-first
  flow. All references to hosted suite.studiomeyer.io removed from documentation
  so the open-source build stands on its own.
- `package.json` slimmed: `pg`, `@anthropic-ai/sdk`, `node-telegram-bot-api`
  dropped (they were only used by the SaaS server and legacy Telegram bot).
- `suite_connect` tool (browser form for credentials) removed. `suite_setup`
  accepts the same fields directly, stored locally and encrypted at rest.
- First public release under `studiomeyer-io/mcp-personal-suite`.

### Kept
- All 49 functional tools across 6 modules (Email 15, Calendar 11, Messaging 8,
  Search 7, Image 3, System 5). Every module works standalone — configure only
  what you use.
- AES-256-GCM encryption of sensitive config fields, `0600` file permissions.
- Dual transport: stdio (default) and Streamable HTTP (`--http --port=5120`).
- Email auto-discovery via Mozilla ISPDB (30,000+ providers).
- CalDAV support for Apple iCloud, Nextcloud, mailbox.org, Posteo, Radicale.
- OAuth 2.0 flows for Gmail and Google Calendar (BYOK Google Cloud project).
- CLI setup wizard (`mcp-personal-suite setup`) with local HTTP callback server.

## [0.4.x] - Pre-release (not published)

Private development releases. See the repository history for details on the
SaaS-era features that were removed in 0.5.0.
