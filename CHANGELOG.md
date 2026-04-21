# Changelog

All notable changes to mcp-personal-suite are documented here.

## Unreleased

### Security + Quality — Split-Critic follow-through + five leak shapes (Session 840, 2026-04-21)

The four deferred Session 839 Split-Critic nachbesserungen are now addressed.
28 new tests; 418/418 green.

- **NEW `src/lib/concurrency.ts`** — zero-dep `createLimiter(N)` (p-limit
  shape). Used in `doDeepSearch` to cap concurrent upstream requests.
  Default is 3 (overridable via `MCP_SUITE_DEEP_SEARCH_CONCURRENCY`);
  previously 8 search-angles fanned out at once against a single BYOK
  provider, which blew past Brave free-tier + Tavily/Exa rate limits.

- **NEW `src/lib/sanitize-output.ts`** — `sanitizeToolOutput(response)`
  walks a full MCP tool-response tree and pushes every string through
  the existing `logger.sanitizeSecrets` scrub (15+ secret shapes:
  Bearer / sk-ant / sk- / xox / Telegram / AKIA / AIza / ghp_ / gho_ /
  BSA / Stripe rk_live / Mailgun / SendGrid / Brevo pattern / basic-auth
  URL). Catches the case where an upstream library — imapflow,
  googleapis, grammy, `@slack/bolt`, fal — embedded credentials into an
  Error.message that was then echoed to the MCP client.

- **NEW `src/lib/tool-response.ts`** — shared `jsonResponse` /
  `errorResponse` / `textResponse` helpers. Every one of the six
  modules (email, calendar, messaging, search, image, system) had its
  own copy of `jsonResponse` — six chances to forget the sanitizer on
  an error path. Extracted to a single helper; every outgoing response
  now goes through `sanitizeToolOutput`. No API changes (the shared
  ToolResponse type matches the one each module had locally).

- **Boundary tests** — `tests/module-boundaries.test.ts` locks in the
  independence the Session 839 module splits promised: each sub-module
  is importable in isolation, exports the API its orchestrator expects,
  is free of circular imports between search and system.

**Post-review follow-through (Session 840 Agent Critic):**

- `src/lib/logger.ts` SECRET_PATTERNS gains five leak shapes that were
  missing from the 15-pattern list: Tavily (`tvly-`), fal.ai (`fal-`),
  Google OAuth refresh tokens (`1//0...`), SMTP `AUTH PLAIN/LOGIN`
  base64, and Baileys WhatsApp session-state keys (`noiseKey`,
  `signedIdentityKey`, `signedPreKey`, `registrationId`, `advSecretKey`).
  Placed before the catch-all `password=` / URL basic-auth rules so
  provider-specific tokens win when both would match.
- One extra test in `tests/sanitize-output.test.ts` exercises all five
  new patterns plus negative-space assertions (none of the original
  secret values survives the scrub).

### Refactor — split the two largest modules along their natural seams

The Analyst cohesion review flagged `src/modules/system/index.ts` (953 LOC)
and `src/modules/search/index.ts` (873 LOC) as the only two files large
enough to hide their responsibilities. Each had three distinct concerns
glued together; split along those concerns so every file owns one thing.

- **`system/index.ts`** 953 → 537 LOC (MCP tool registration only)
  - **New** `system/setup-builders.ts` (219) — `build{Email,Calendar,Messaging,Search,Image}Config`. Pure arg→config mapping, trivially unit-testable in isolation.
  - **New** `system/health-checks.ts`  (234) — `check{Email,Calendar,Messaging,Search,Image}Health`. No MCP-server dependency; each function takes a config object and returns a status string.
- **`search/index.ts`** 873 → 344 LOC (MCP tool registration + jsonResponse / errorResponse helpers, re-exports engine types so external import paths keep working)
  - **New** `search/engines.ts` (344) — SearXNG + Brave clients, the SSRF-guarded `validateSearxngUrl`, config resolvers (`getConfig` / `getProviderConfig` / `hasAnyEngine` / `hasAnyProvider`), shared result types.
  - **New** `search/orchestrators.ts` (262) — `doWebSearch` / `doNewsSearch` / `doImageSearch` / `doDeepSearch` + `generateSearchAngles`. Encodes the "which engine, with what fallback" routing policy.

No API changes. All 390 tests + `tsc --noEmit` still green.

## [0.5.4] - 2026-04-20

### Added — Supply-Chain Trust Signals

After the third agent-code-review pass (which verified the codebase as STABLE)
this release adds the post-launch trust infrastructure the project had been
missing for a public npm release.

- **`.github/workflows/publish.yml`** — Automated publish-on-tag workflow.
  Builds, typechecks, tests, audits, then publishes with `npm publish
  --provenance`. Uses GitHub Actions OIDC (`id-token: write`) so the
  attestation is cryptographically signed by GitHub at build time and
  verifiable via `npm audit signatures`. The job runs inside a GitHub
  Environment (`npm-publish`) so a human approval gate can be wired in at
  the repository level without changing the workflow file.
- **`.github/workflows/scorecard.yml`** — OpenSSF Scorecard analysis
  weekly plus on every push to `main`. Writes SARIF to the code-scanning
  tab and publishes the score to the public Scorecard directory. Surfaces
  branch protection, signed commits, dangerous workflow patterns, and
  dependency pinning as actionable weaknesses.
- **README badges** — CI status and OpenSSF Scorecard badge added above
  the navigation row. `Security` link in the top nav points at
  [SECURITY.md](./SECURITY.md) for the disclosure policy and threat model.
- **README Docker volume path** — Corrected to `/home/node/.personal-suite`
  to match the non-root `USER node` switch added in v0.5.3. Old path
  `/root/.personal-suite` would have silently failed under the hardened
  image.

### Changed — Secret Redaction Coverage

`sanitizeSecrets()` in `src/lib/logger.ts` now covers six additional
provider token shapes. Previous version caught Bearer / sk- / Slack /
Telegram / AWS / GitHub-PAT / Brave / basic-auth URLs / password= fields.
New patterns:

- **Anthropic keys** — `sk-ant-…` gets its own match that runs before the
  generic `sk-` so the "ant-" prefix is preserved in the redaction tag.
- **Google Cloud keys** — `AIza[0-9A-Za-z_-]{35}` (Gemini, Maps, other GCP).
- **GitHub OAuth tokens** — `gho_…` (separate from the `ghp_` personal
  access tokens which were already covered).
- **Stripe keys** — `sk_live_…`, `rk_test_…`, and the other four Stripe
  prefix variants matched by `(?:rk|sk)_(?:live|test)_[A-Za-z0-9]{24,}`.
- **Mailgun API keys** — `key-<32-hex>` (the legacy domain format).
- **SendGrid keys** — `SG.<22>.<43>` full-length.
- **Brevo / xkeysib UUID pattern** — any canonical 32-hex UUID gets
  masked. Broad on purpose — false positives here are cheap.

### Test coverage

- `tests/security.test.ts` — 6 new tests, one per new provider pattern.
  Total 18 tests in `security.test.ts`, 390 / 390 across the full suite.
- All secret fixtures are assembled at runtime from fragments
  (`'xox' + 'b-' + …`) so GitHub Push Protection does not flag the
  repository on every push.

### Docs

- [SECURITY.md](./SECURITY.md) remains the single source of truth for
  threat model, supported versions, and 72h / 7d / 14d / 30d response SLAs.

### Notes on what did not change

The third review pass flagged four "HIGH" findings that we investigated
and chose not to act on:

- **Dockerfile `USER node` position** — report claimed `USER` preceded
  `RUN npm ci`. It does not (line 31 is after line 25). No change needed.
- **`setInterval` without cleanup** — both intervals in the codebase are
  handled: `dual-transport.ts` has `clearInterval` in its SIGINT/SIGTERM
  shutdown path; `email-client.ts` uses `.unref()` so the interval does
  not block process exit. No leak under realistic lifetimes.
- **Prompt-injection via tool outputs** — explicitly out of scope per the
  threat model in [SECURITY.md](./SECURITY.md). Content returned from
  configured providers (email body, calendar summary, search snippets)
  is passed through with structural validation only; defending the
  downstream LLM is the MCP client's responsibility.
- **sanitizeSecrets deny-list fundamental unreliability** — correct in
  principle (no deny-list catches 100% of unknown token shapes), but the
  suggested alternative (pino `redact`) is field-based and would not help
  with arbitrary `Error.message` strings from upstream libraries. We add
  coverage (this release) rather than swap the approach.

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
