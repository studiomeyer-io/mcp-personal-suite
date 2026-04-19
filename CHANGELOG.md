# Changelog

All notable changes to mcp-personal-suite are documented here.

## [0.5.3] - 2026-04-19

### Security (Round 2 of 3-agent review)

Three new HIGH-severity findings and two Round-1 weakenings that the second
review caught. Plus defence-in-depth on container + CI hygiene.

- **Path traversal in `image_download`** (`src/modules/image/index.ts`).
  Caller-supplied `filename` was passed to `path.join()` without sanitization,
  so `filename: "../../etc/passwd"` would escape the download directory.
  New `sanitizeFilename()` enforces `[A-Za-z0-9._-]+`, rejects `.`, `..`, path
  separators, control characters, and filenames over 128 chars.
- **SSRF via redirect** (`src/modules/image/index.ts`). `fetch()` was following
  3xx responses by default, so a domain on the CDN allowlist could redirect
  the server to `http://169.254.169.254/latest/meta-data/` (AWS metadata) or
  any private IP. Fixed with `redirect: 'error'` — we now require direct URLs.
- **Credential leakage in error logs** (`src/lib/logger.ts`). Upstream
  libraries (imapflow, nodemailer, grammy, googleapis, etc.) sometimes include
  user credentials in their thrown `Error.message`. New `sanitizeSecrets()`
  strips Bearer tokens, `sk-…` API keys, Slack `xox…` tokens, Telegram bot
  tokens, AWS/GitHub keys, `password=` query params, and basic-auth URLs
  before anything reaches stderr.
- **MAX_SESSIONS TOCTOU** (`src/lib/dual-transport.ts`). The `if (sessions.size
  >= MAX)` check and the `sessions.set()` in `onsessioninitialized` were
  separated by multiple `await`s, so 100 concurrent POSTs could all pass the
  check and all create sessions. Now we reserve a placeholder slot
  synchronously in the same tick as the check, and swap in the real session
  id once the transport initializes. Reservation is cleaned up on failure.
- **CORS Simple-Request bypass** (`src/lib/dual-transport.ts`). Browsers can
  send cross-origin POSTs without preflight when `Content-Type` is form-encoded
  or `text/plain`, so the origin whitelist alone was not sufficient. The
  `/mcp` endpoint now enforces `Content-Type: application/json` and returns
  `415` otherwise — any such attack is rejected before touching the transport.

### Container hardening

- **Dockerfile runs as `node` user** instead of root. `node:22-slim` ships
  with a pre-built non-root user at UID 1000; `dist/` is now `--chown=node:node`
  on copy. The HTTP endpoint is unchanged; the volume-mount path in the
  README was updated to `/home/node/.personal-suite`.
- **`.dockerignore`** added. Keeps `node_modules`, `.git`, tests, and env
  files out of the build context.

### Tests

- `tests/security.test.ts` (10 new tests): roundtrip coverage for
  `sanitizeSecrets()` across all supported token patterns, plus
  env-var parsing shape checks for MAX_SESSIONS and ALLOWED_ORIGINS.
- 384 / 384 tests green, typecheck clean, build clean, `npm audit`: 0.

### Open-source hygiene

- `SECURITY.md` — disclosure policy, threat model, response timelines.
- `.github/workflows/ci.yml` — Node 20 + 22 matrix, typecheck / test /
  build / `npm audit --audit-level=high` on every push and PR.
- `.github/dependabot.yml` — weekly npm updates (grouped minor+patch,
  separate `@types/*` group), monthly GitHub Actions updates.

## [0.5.2] - 2026-04-19

### Added
- **`tests/crypto.test.ts`** — 16 unit tests for the credential encryption
  pipeline: AES-256-GCM encrypt/decrypt roundtrip, random IV per call,
  idempotent re-encryption, plaintext pass-through (backward compat),
  GCM auth-tag tamper detection, malformed payload handling, sensitive-field
  pattern matching, recursive config encryption, key-stability across
  module reloads. Regression coverage for the v0.5.1 security hardening.

### Changed
- **Removed `tenant-storage.ts` and all 17 `getCurrentTenantId()` call sites.**
  This code was dead in single-user mode (always returned `undefined`,
  triggering the `|| '_default'` fallback) but created kognitive load for
  contributors wondering what tenant context was for. Files cleaned:
  `src/lib/tenant-storage.ts` (deleted), `src/lib/config.ts`,
  `src/modules/email/email-client.ts`, `src/modules/email/index.ts`
  (removed `wrapServerWithPreload`, `preloadForTenant`, `saveForTenant`),
  `src/modules/email/oauth2.ts` (removed tenant config cache + SaaS
  refresh branch), `src/modules/system/index.ts` (removed tenant-aware
  storage notes). 372/372 tests still green.

### Dev
- TypeScript strict build clean, total `src/` LOC: 9,748.

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
