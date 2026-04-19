#!/usr/bin/env node

/**
 * MCP Personal Suite — Main Server Entry Point
 *
 * A unified personal productivity server for Claude Code:
 * Email, Calendar, Messaging, Search — all in one MCP server.
 *
 * Transport:
 *   Default: stdio (for Claude Code / Agent SDK subprocess)
 *   --http:  Streamable HTTP (persistent microservice, --port=XXXX)
 *
 * Modules:
 *   email_*  — Send, receive, search, reply to emails (Gmail, Outlook, IMAP)
 *   cal_*    — Create, list, update, delete calendar events (Google Calendar)
 *   msg_*    — Send and receive messages (Telegram, Discord, Slack, WhatsApp)
 *   search_* — Web search across multiple engines (SearXNG, Brave)
 *   suite_*  — System tools (status, setup, health)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startDualTransport } from './lib/dual-transport.js';
import { logger } from './lib/logger.js';
import { registerSystemTools } from './modules/system/index.js';
import { registerEmailTools } from './modules/email/index.js';
import { registerCalendarTools } from './modules/calendar/index.js';
import { registerMessagingTools } from './modules/messaging/index.js';
import { registerSearchTools } from './modules/search/index.js';
import { registerImageTools } from './modules/image/index.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../package.json') as { version: string };

// ─── Server Instructions ─────────────────────────────

const INSTRUCTIONS = `# Personal Suite — Email, Calendar, Messaging, Search, Image Generation

Local-first personal productivity MCP server. Manage email, calendar, messaging,
web search, and image generation from one server. BYOK, no cloud, no signup.
Credentials live locally in ~/.personal-suite/config.json (0600 perms, AES-256-GCM at rest).

## Getting Started

1. Call \`suite_status\` to see which modules are configured
2. Call \`suite_setup\` to configure any module (interactive wizard)
3. Call \`suite_health\` to verify connections

## Modules & Tool Prefixes

### Email — email_* (15 tools)
Gmail (OAuth2), Outlook (OAuth2), generic IMAP/SMTP. Auto-detection for 30K+ providers.
Send, receive, search, reply, forward, threads, folders, attachments up to 25MB.

Tools: email_status, email_setup, email_auth, email_list, email_read,
email_send, email_reply, email_forward, email_search, email_threads,
email_move, email_mark_read, email_mark_unread, email_delete, email_folders

### Calendar — calendar_* (11 tools)
Google Calendar (OAuth2) and CalDAV (Apple, Nextcloud, mailbox.org, any CalDAV server).
Events, availability, conflicts, Meet links, daily summaries.

Tools: calendar_status, calendar_list_events, calendar_get_event,
calendar_create_event, calendar_update_event, calendar_delete_event,
calendar_search_events, calendar_list_calendars, calendar_check_availability,
calendar_upcoming, calendar_daily_summary

### Messaging — channel_* (8 tools)
Telegram, Discord, Slack, WhatsApp. Send, receive, broadcast across all platforms.

Tools: channel_status, channel_send, channel_receive, channel_list,
channel_connect, channel_disconnect, channel_broadcast, channel_history

### Search — search_* (7 tools)
Multi-provider gateway (BYOK): SearXNG, Brave, Exa, Tavily. Web, news, images,
deep research, neural/semantic search, code context search.

Tools: search_web, search_news, search_images, search_deep,
search_semantic, search_code_context, search_research

### Image — image_* (3 tools)
BYOK image generation: Flux (photorealistic), OpenAI DALL-E 3 (text rendering),
Google Gemini Imagen 3 (product shots). Auto-routing by prompt type.

Tools: image_generate, image_edit, image_download

### System — suite_* (5 tools)
Status, setup wizard, health checks, documentation, GDPR delete.

Tools: suite_status, suite_setup, suite_health, suite_guide, suite_delete

## Important
- Call \`suite_setup\` with module + credentials to configure (stored locally, encrypted)
- Call \`suite_status\` first to check configuration
- Unconfigured modules return setup instructions
- All credentials stay on this machine. Nothing leaves your box except direct API calls.
`;

// ─── Server Factory ──────────────────────────────────

function createServer(): McpServer {
  const server = new McpServer(
    {
      name: 'personal-suite',
      version: PKG_VERSION,
    },
    {
      instructions: INSTRUCTIONS,
    },
  );

  // Register all module tools
  registerSystemTools(server);
  registerEmailTools(server);
  registerCalendarTools(server);
  registerMessagingTools(server);
  registerSearchTools(server);
  registerImageTools(server);

  return server;
}

// ─── Start ───────────────────────────────────────────

async function main(): Promise<void> {
  // Subcommands (before MCP server start)
  const subcommand = process.argv[2];
  if (subcommand === 'setup') {
    const { runSetupWizard } = await import('./cli/setup.js');
    try {
      await runSetupWizard();
      process.exit(0);
    } catch (err) {
      process.stderr.write(`\n[setup failed] ${err instanceof Error ? err.message : String(err)}\n\n`);
      process.exit(1);
    }
  }

  if (subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    process.stdout.write(`mcp-personal-suite — Email, Calendar, Messaging, Search, Image Generation MCP server

Usage:
  mcp-personal-suite              Start MCP server (stdio, default)
  mcp-personal-suite --http       Start as HTTP server
  mcp-personal-suite setup        Interactive OAuth setup for Gmail/Calendar
  mcp-personal-suite --help       Show this help

Docs: https://github.com/studiomeyer-io/mcp-personal-suite
`);
    process.exit(0);
  }

  try {
    const result = await startDualTransport(
      () => createServer(),
      {
        serverName: 'personal-suite',
        serverVersion: PKG_VERSION,
        defaultPort: 5120,
      },
    );
    logger.info(`Transport: ${result.type}${result.port ? ` on port ${result.port}` : ''}`);
  } catch (err) {
    logger.logError('Failed to start Personal Suite', err);
    process.exit(1);
  }
}

main();
