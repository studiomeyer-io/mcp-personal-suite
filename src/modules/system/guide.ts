/**
 * suite_guide — Embedded documentation for the Personal Suite
 *
 * Topics are compiled into the binary (no filesystem dependency).
 * Returns markdown-formatted help for users and AI agents.
 */

const TOPICS: Record<string, { title: string; content: string }> = {
  quickstart: {
    title: 'Quickstart — get started in 2 minutes',
    content: `Personal Suite gives Claude access to your email, calendar, messaging, and web search — all in one server.

## Step 1: Check what's configured
\`suite_status\` — shows which modules are ready and which need setup.

## Step 2: Set up your first module

### Email — the easiest start

**Quick Setup (30 seconds):** Just provide your email address and password — settings are auto-detected for 30,000+ providers (Gmail, Outlook, WEB.DE, GMX, T-Online, mailbox.org, IONOS, Strato, and many more):
\`suite_setup(module: "email", email_address: "you@yourcompany.com", email_password: "your-password")\`

That's it! IMAP and SMTP settings are found automatically.

**Gmail/Outlook users:** These require OAuth (no password login). Call \`suite_guide(topic: "oauth")\` for the Google Cloud walkthrough, or use an app-specific password with IMAP instead (simpler).

**Note:** Some providers (WEB.DE, GMX) require you to activate IMAP in their settings first. The setup will tell you if that's needed.

### Telegram (30 seconds) — great for mobile access
1. Open Telegram, search for **@BotFather**
2. Send \`/newbot\`, pick any name (e.g. "My Company Bot"), pick a username (must end in "bot")
3. BotFather replies with a token like \`123456:ABC-xyz...\` — copy the whole thing
4. \`suite_setup(module: "messaging", channel_platform: "telegram", channel_bot_token: "YOUR_TOKEN")\`

### Search (1 minute) — web access for Claude
Get a free Brave API key (2000 queries/month): brave.com/search/api → Sign up → Create key
\`suite_setup(module: "search", search_brave_api_key: "BSA...")\`

## Step 3: Verify
\`suite_health\` — tests all connections and shows what's working.

## What you get

| Module | Tools | What it does |
|--------|-------|-------------|
| Email | 15 | Send, receive, search, reply, forward, folders, attachments |
| Calendar | 11 | Events, availability, daily summary (Google + CalDAV) |
| Messaging | 8 | Telegram, Discord, Slack, WhatsApp |
| Search | 7 | Web, news, images, deep research, semantic, code |
| Image | 3 | Generate, edit, download (OpenAI/Flux/Gemini) |
| System | 5 | Status, setup, health, guide, delete |

Your credentials are stored locally in \`~/.personal-suite/config.json\` with owner-read-only permissions (0600) and AES-256-GCM encryption at rest. Nothing leaves your machine except direct API calls to the providers you configure.

## More help
- \`suite_guide(topic: "email")\` — Email details
- \`suite_guide(topic: "messaging")\` — Messaging platforms
- \`suite_guide(topic: "image")\` — Image generation setup + provider comparison
- \`suite_guide(topic: "oauth")\` — Google Cloud OAuth walkthrough
- \`suite_guide(topic: "connect")\` — How to add the MCP server to Claude`,
  },

  connect: {
    title: 'Connect — add Personal Suite to your MCP client',
    content: `## Claude Desktop (easiest)

Edit your \`claude_desktop_config.json\`:

**macOS:** \`~/Library/Application Support/Claude/claude_desktop_config.json\`
**Windows:** \`%APPDATA%\\Claude\\claude_desktop_config.json\`
**Linux:** \`~/.config/Claude/claude_desktop_config.json\`

\`\`\`json
{
  "mcpServers": {
    "personal-suite": {
      "command": "npx",
      "args": ["-y", "mcp-personal-suite"]
    }
  }
}
\`\`\`

**Restart Claude** → the suite_* tools appear.

## Claude Code (CLI)

\`\`\`bash
claude mcp add personal-suite -- npx -y mcp-personal-suite
\`\`\`

## Cursor, Continue, other MCP clients

Most MCP clients accept the same stdio command: \`npx -y mcp-personal-suite\`.

For HTTP transport (self-hosted), run \`mcp-personal-suite --http --port=5120\`
and point your client at \`http://localhost:5120/mcp\`.

## Config file location

After \`suite_setup\`, credentials are saved to:
- **macOS/Linux:** \`~/.personal-suite/config.json\`
- **Windows:** \`%USERPROFILE%\\.personal-suite\\config.json\`

Permissions are set to 0600 (owner read/write only) and sensitive fields are
encrypted with AES-256-GCM. The encryption key is auto-generated on first run
at \`~/.personal-suite/.key\`, or you can set \`CREDENTIAL_ENCRYPTION_KEY\` in your env.

## First steps after connecting
1. Ask Claude: "What's configured?" → calls \`suite_status\`
2. Start with Telegram — 30-second setup (see \`suite_guide(topic: "messaging")\`)
3. Then add Search, Email, Calendar as you need them`,
  },

  email: {
    title: 'Email — Gmail, Outlook, IMAP',
    content: `## Supported providers
1. **Gmail** (OAuth2) — modern, no app password
2. **Outlook / Microsoft 365** (OAuth2) — modern, no app password
3. **Generic IMAP/SMTP** — any provider (Fastmail, ProtonMail Bridge, custom)

## Setup — OAuth providers (Gmail/Outlook)
\`suite_setup(module: "email", provider: "gmail")\` guides you through:
1. Create OAuth2 credentials in Google Cloud Console (Desktop app type)
2. Get client ID + client secret
3. Call \`email_auth\` to generate auth URL
4. Visit URL, approve, copy code
5. Exchange code for refresh token

See \`suite_guide(topic: "oauth")\` for the full Google Cloud setup walkthrough.

## Setup — IMAP
For Fastmail, ProtonMail Bridge, or any SMTP server:
\`suite_setup(module: "email", provider: "imap")\` with host, port, user, password.

## Common tasks
- **Send email:** \`email_send(to, subject, body, [attachments])\`
- **Reply in thread:** \`email_reply(uid, body)\` — keeps References header
- **Search inbox:** \`email_search(query, limit)\`
- **Forward:** \`email_forward(uid, to, note)\`
- **Manage folders:** \`email_folders()\`, \`email_move(uid, folder)\`
- **Read/Unread:** \`email_mark_read(uid)\`, \`email_mark_unread(uid)\`

## Attachments
Up to 25MB. Pass absolute file paths. All paths are validated (no traversal).

## Threading
\`email_threads\` groups by conversation. \`email_reply\` sets the correct In-Reply-To and References headers automatically.`,
  },

  calendar: {
    title: 'Calendar — Google Calendar + CalDAV',
    content: `Two providers, same 11 tools. Pick the one that matches your setup.

## Provider 1: Google Calendar (OAuth2)
Full-featured: events, availability, conflicts, Meet links, daily summaries.

**Setup:**
\`\`\`
suite_setup(
  module: "calendar",
  calendar_oauth_client_id: "your-client-id.apps.googleusercontent.com",
  calendar_oauth_client_secret: "GOCSPX-..."
)
\`\`\`

You can reuse the SAME OAuth2 credentials from Gmail — just enable Google Calendar API in the same Cloud project.
See \`suite_guide(topic: "oauth")\` for the full Google Cloud setup walkthrough.

## Provider 2: CalDAV (iCloud, Nextcloud, mailbox.org, and more)
Works with any CalDAV-compliant server. No OAuth needed — just URL + username + password.

**Setup:**
\`\`\`
suite_setup(
  module: "calendar",
  calendar_provider: "caldav",
  calendar_caldav_url: "https://caldav.icloud.com",
  calendar_caldav_username: "user@icloud.com",
  calendar_caldav_password: "your-app-specific-password"
)
\`\`\`

### Known CalDAV Server URLs

| Provider | URL | Notes |
|---|---|---|
| **Apple iCloud** | \`https://caldav.icloud.com\` | Use Apple ID + app-specific password (appleid.apple.com) |
| **Nextcloud** | \`https://your-server/remote.php/dav\` | Append to your Nextcloud base URL |
| **mailbox.org** | \`https://dav.mailbox.org\` | Use full email + password |
| **Posteo** | \`https://posteo.de:8443\` | Enable CalDAV in Posteo settings first |
| **Fastmail** | \`https://caldav.fastmail.com/dav/calendars\` | Use email + app-specific password |
| **Radicale** | \`http://localhost:5232\` | Self-hosted, default port 5232 |
| **Baikal** | \`https://your-server/dav.php\` | Append to your Baikal URL |
| **Synology** | \`https://your-nas:5001/caldav\` | Use DSM username + password |
| **Yahoo** | \`https://caldav.calendar.yahoo.com\` | Use Yahoo email + app password |
| **Zoho** | \`https://calendar.zoho.com/caldav\` | Use email + app-specific password |

### CalDAV Tips
- **App-specific passwords:** iCloud, Fastmail, and others require app-specific passwords instead of your main password. Generate one in your account settings.
- **Default calendar:** After setup, run \`calendar_list_calendars\` to see all calendars, then optionally set a default via \`suite_setup(module: "calendar", calendar_provider: "caldav", ..., calendar_default_calendar_id: "calendar-url-from-list")\`.
- **calendarId parameter:** For CalDAV, calendarId is the calendar URL (shown by \`calendar_list_calendars\`). If omitted, the first available calendar is used.

## Common tasks (both providers)
- **List today/week:** \`calendar_list_events()\` — defaults to next 7 days
- **Create event:** \`calendar_create_event(summary, start, end, [description], [location])\`
- **Check if you are free:** \`calendar_check_availability(date)\`
- **Daily summary:** \`calendar_daily_summary(date)\` — busy/free analysis
- **Search events:** \`calendar_search_events(query)\`
- **List calendars:** \`calendar_list_calendars()\` — see all available calendars + IDs

## Google-only features
- **Meet links:** Pass \`addMeetLink: true\` when creating an event to auto-generate a Google Meet link.
- **Attendee notifications:** Google sends email notifications to attendees automatically.

## Recurrence (both providers)
Presets: \`daily\`, \`weekly\`, \`monthly\`, \`yearly\`, or pass a custom RRULE string.

## Conflict detection (both providers)
\`calendar_create_event\` checks for overlapping events before creating.`,
  },

  messaging: {
    title: 'Messaging — Telegram, Discord, Slack, WhatsApp',
    content: `Four messaging platforms in one interface. Send, receive, broadcast across all.

## Setup per platform
- **Telegram:** Bot token from @BotFather
- **Discord:** Bot token from discord.com/developers
- **Slack:** Bot token (xoxb-...) from api.slack.com/apps
- **WhatsApp:** QR code scan via \`channel_connect\` (Baileys, unofficial)

\`suite_setup(module: "messaging", channel_platform: "telegram", channel_bot_token: "...")\` — one call per platform.

## Common tasks
- **Send to one channel:** \`channel_send(platform, channelId, text)\`
- **Broadcast:** \`channel_broadcast(targets, text)\` — send to multiple at once
- **Get recent messages:** \`channel_receive(platform, since, limit)\` — from buffer
- **Get older history:** \`channel_history(platform, channelId, limit)\` — from platform API
- **List channels:** \`channel_list(platform)\` — discover channel IDs first
- **Status:** \`channel_status()\` — see which platforms are connected

## Important
- **Always call \`channel_list\` first** to get channel IDs — do not guess them
- **Telegram bots** can only see chats they have received messages in
- **WhatsApp** needs QR scan on \`channel_connect\` — you see base64 QR in response
- **Buffer** holds messages since server start (fast); **history** fetches from API (slower)

## Message limits
Telegram 4096 chars, Discord 2000, Slack 40K, WhatsApp 65K. The server auto-chunks longer messages.`,
  },

  search: {
    title: 'Search — Multi-Provider Gateway (BYOK)',
    content: `Search is a **provider-agnostic gateway** — bring your own API keys, choose the right engine per query. Currently supports 4 providers, more coming.

## Providers

| Provider | Best For | Pricing | Required |
|---|---|---|---|
| **SearXNG** | Privacy, general web | Free (self-hosted) | \`searxngUrl\` |
| **Brave** | General web, news, images | 2000/mo free | \`braveApiKey\` |
| **Exa** | Neural/semantic search, code | Paid (check exa.ai pricing) | \`exaApiKey\` |
| **Tavily** | Deep research with citations | 1000 credits/mo free (advanced=2 credits/query) | \`tavilyApiKey\` |

## Setup (per provider, all optional)

\`\`\`
suite_setup(
  module: "search",
  search_searxng_url: "http://your-instance:8888",   // free self-hosted
  search_brave_api_key: "BSA...",                     // brave.com/search/api
  search_exa_api_key: "...",                          // exa.ai
  search_tavily_api_key: "tvly-..."                   // tavily.com
)
\`\`\`

## Tools (7 total, unified router pattern)

**Multi-provider web search** (SearXNG / Brave / Exa / Tavily):
- \`search_web(query, maxResults, engine?)\` — general web. engine="auto" (default, SearXNG→Brave) | "searxng" | "brave" | "exa" | "tavily"
- \`search_news(query, maxResults, engine?)\` — news. engine="auto" | "searxng" | "brave" | "tavily"
- \`search_images(query, maxResults)\` — SearXNG or Brave (images)
- \`search_deep(query, maxRounds)\` — multi-angle generation (aggregates multiple sub-searches)

**Neural/semantic search** (Exa-specific):
- \`search_semantic(query, category?, maxResults?)\` — finds pages by CONCEPT. Best when you know WHAT you want but not exact keywords.
- \`search_code_context(query, maxResults?)\` — code, docs, StackOverflow, GitHub

**Deep research with synthesis** (Tavily-specific):
- \`search_research(query, depth?, topic?)\` — runs sub-searches, scrapes top pages, synthesizes a cited answer (15-30s, research-grade)

## Engine override pattern

For search_web + search_news, you can force a specific provider:
\`\`\`
search_web(query: "quantum computing", engine: "exa")        → Exa keyword mode
search_news(query: "AI regulation", engine: "tavily")        → Tavily with synthesis
search_web(query: "rust async", engine: "auto")              → SearXNG or Brave (default)
\`\`\`

## When to use which

- **"What's the weather in Berlin?"** → \`search_web\` (any provider)
- **"Find me articles about approaches to reducing API costs"** → \`search_semantic\` (Exa — concept-based)
- **"How do I stream tool_use with the Anthropic SDK?"** → \`search_code_context\` (Exa — code-focused)
- **"What are the current approaches to MCP authentication?"** → \`search_research\` (Tavily — synthesized answer)
- **"Latest news on OpenAI"** → \`search_news\` (Brave/SearXNG)
- **"Research topic X thoroughly"** → \`search_deep\` (multi-angle) or \`search_research\` (Tavily)

## BYOK philosophy
We never charge for search. You pay each provider directly (all have free tiers). We provide the gateway + the tool descriptions that help Claude pick the right one.`,
  },

  oauth: {
    title: 'OAuth Setup — Google Cloud (Gmail + Calendar)',
    content: `Full walkthrough for getting Google OAuth2 credentials. Takes ~5 minutes.

## Step 1: Create Google Cloud project
1. Go to https://console.cloud.google.com
2. Create a new project (or select existing)
3. Name it "Personal Suite" or similar

## Step 2: Enable APIs
In the project:
1. Go to APIs & Services → Library
2. Search "Gmail API" → Enable
3. Search "Google Calendar API" → Enable

## Step 3: Configure OAuth consent screen
1. APIs & Services → OAuth consent screen
2. User type: **External** (personal) or **Internal** (workspace)
3. App name: "Personal Suite"
4. User support email: your email
5. Developer contact: your email
6. Scopes: add \`https://mail.google.com/\` and \`https://www.googleapis.com/auth/calendar\`
7. Test users: add your own email (while app is in Testing mode)

## Step 4: Create OAuth credentials
1. APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID
2. Application type: **Desktop app**
3. Name: "Personal Suite Desktop"
4. Click Create → download JSON or copy Client ID + Client Secret

## Step 5: Use in Personal Suite
\`\`\`
suite_setup(
  module: "email",
  email_provider: "gmail",
  email_oauth_client_id: "your-client-id.apps.googleusercontent.com",
  email_oauth_client_secret: "GOCSPX-..."
)
\`\`\`

Then call \`email_auth\` to get the authorization URL. Visit it, approve, copy the code back. Done.

## Calendar
Same credentials, same flow. Just call:
\`\`\`
suite_setup(
  module: "calendar",
  calendar_oauth_client_id: "same-as-above",
  calendar_oauth_client_secret: "same-as-above"
)
\`\`\`

## Refresh tokens
Once you have a refresh token, the server handles token refresh automatically. You only do this setup once.`,
  },

  image: {
    title: 'Image — BYOK Multi-Provider Image Generation',
    content: `Generate images using AI with your own API keys. Three providers, each with different strengths. "auto" mode picks the best provider based on your prompt.

## Providers

| Provider | Best For | Pricing | Model |
|---|---|---|---|
| **OpenAI** | Text in images, logos, illustrations, creative | ~$0.04-0.12/image | DALL-E 3 |
| **Flux** | Photorealistic, portraits, product shots, nature | ~$0.04/image | Flux Pro v1.1 (fal.ai) |
| **Gemini** | Versatile, multimodal understanding | ~$0.04-0.30/image | Gemini 2.0 Flash |

## Setup

Configure one or more providers:
\`\`\`
suite_setup(
  module: "image",
  image_openai_api_key: "sk-...",
  image_flux_api_key: "...",
  image_gemini_api_key: "AIza..."
)
\`\`\`

You only need ONE provider to get started. Add more for auto-routing.

## Getting API Keys

**OpenAI:** https://platform.openai.com/api-keys
**Flux (fal.ai):** https://fal.ai/dashboard/keys
**Gemini:** https://aistudio.google.com/app/apikey (free tier available)

## Tools (3)

### image_generate(prompt, provider?, size?, style?, quality?)
\`\`\`
image_generate(prompt: "A photorealistic golden retriever in a meadow")
image_generate(prompt: "Logo for a coffee shop", provider: "openai")
image_generate(prompt: "Studio portrait", provider: "flux", size: "portrait")
\`\`\`

**Auto-routing:** text/logo/typography prompts -> OpenAI, photo/realistic/portrait -> Flux, everything else -> Gemini.
**Sizes:** square (1024x1024), landscape (1792x1024), portrait (1024x1792).

### image_edit(imageUrl, prompt)
Edit an existing image. Only OpenAI (DALL-E 2) supports native editing.

### image_download(url, filename?)
Download a generated image to ~/Downloads/. SSRF-protected.

## Tips
- Be descriptive for best results
- OpenAI rewrites your prompt (check revisedPrompt)
- Gemini returns local files; use image_download to move them
- Image URLs expire (~1 hour for OpenAI); always download to keep

## BYOK Philosophy
We never charge for image generation. You pay each provider directly. We provide the gateway + auto-routing.`,
  },
};

const ALIASES: Record<string, string> = {
  start: 'quickstart',
  begin: 'quickstart',
  help: 'quickstart',
  mail: 'email',
  cal: 'calendar',
  events: 'calendar',
  chat: 'messaging',
  channels: 'messaging',
  messages: 'messaging',
  web: 'search',
  images: 'image',
  generate: 'image',
  dalle: 'image',
  flux: 'image',
  gemini: 'image',
  google: 'oauth',
  auth: 'oauth',
  setup: 'oauth',
};

export function getSuiteGuide(topic: string): string {
  const resolved = ALIASES[topic.toLowerCase()] || topic.toLowerCase();
  const entry = TOPICS[resolved];

  if (!entry) {
    const available = Object.keys(TOPICS).join(', ');
    return `Unknown topic: "${topic}"\n\nAvailable topics: ${available}\n\nTry: suite_guide(topic: "quickstart")`;
  }

  return `# ${entry.title}\n\n${entry.content}\n\n---\nOther topics: ${Object.keys(TOPICS).filter(t => t !== resolved).join(', ')}`;
}

export function getAllTopics(): string[] {
  return Object.keys(TOPICS);
}
