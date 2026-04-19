# Security Policy

## Supported Versions

Only the latest minor release on npm (`mcp-personal-suite`) receives security
updates. We do not backport fixes to older tags.

| Version | Supported          |
|---------|--------------------|
| 0.5.x   | :white_check_mark: |
| < 0.5   | :x:                |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security bugs.** Use one of:

1. **GitHub Security Advisories (preferred):**
   https://github.com/studiomeyer-io/mcp-personal-suite/security/advisories/new
2. **Email:** [hello@studiomeyer.io](mailto:hello@studiomeyer.io)
   (PGP on request — we will reply within 72 hours with a key or an
   encrypted channel.)

What to include:

- A clear description of the vulnerability
- Steps to reproduce (PoC code welcome)
- The affected version(s)
- Your assessment of severity and impact

What to expect:

- **First response:** within 72 hours
- **Triage + severity assignment:** within 7 days
- **Fix timeline:** HIGH/CRITICAL within 14 days, MEDIUM within 30 days,
  LOW on the next minor release
- **Public disclosure:** we coordinate a release date with you. A CVE is
  requested when the impact warrants it

We credit reporters in the changelog and the advisory unless you ask to
remain anonymous.

## Out of Scope

- Vulnerabilities requiring physical access to the user's machine
- Issues in upstream dependencies (report those to the dependency maintainer;
  we will pin / override once a fix is available upstream)
- Denial of service via resource exhaustion *on the user's own machine*
  (this is a local-first tool — the user controls the process)
- Attacks that require the user to paste a malicious API key or
  configuration into `suite_setup` (configuration inputs are trusted by design;
  we sanitize them for path safety but not for semantic trust)

## Threat Model

mcp-personal-suite is **local-first**: the server runs on the user's machine
(stdio subprocess or self-hosted HTTP on `127.0.0.1` by default). The primary
trust boundary is:

- **Trusted:** The user, the MCP client they explicitly configured, the API
  providers they configure (Gmail, OpenAI, Brave, …)
- **Untrusted:** Any other website the user's browser is connected to, any
  third party that can send HTTP requests to the user's machine, any data
  returned from configured API providers (emails, calendar events, search
  results, image-provider responses, bot messages)

The server defends against:

- CSRF / CORS bypass on the HTTP transport (strict `Origin` whitelist,
  `Content-Type: application/json` enforcement, non-root bind by default)
- SSRF on image downloads (HTTPS-only, CDN domain allowlist, private-IP
  block, redirect refusal)
- Path traversal on user-supplied filenames (allowlist regex)
- Credential leakage in error logs (secret patterns are redacted before
  stderr output)
- Session-creation flooding on HTTP transport (`MAX_SESSIONS` cap with
  atomic reservation)
- Weak encryption keys (refuses to fall back to predictable-derivation keys;
  requires either a writable key file or an explicit env var)

The server does **not** sandbox the provider API responses it hands back to
the MCP client. If a malicious email, calendar invite, or search result tries
to prompt-inject the downstream LLM, that is the MCP client's responsibility
to defend against — we pass the data through with structural validation only.
