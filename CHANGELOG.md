# Changelog

All notable changes to mcp-personal-suite are documented here.

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
