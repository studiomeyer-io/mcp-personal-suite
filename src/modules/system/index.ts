/**
 * System Module — suite_guide, suite_status, suite_setup, suite_health, suite_delete
 *
 * Meta-tools for managing the Personal Suite itself. This file owns the MCP
 * tool-registration surface. The heavier logic lives in:
 *   - ./setup-builders.ts — turns flat tool args into typed module configs
 *   - ./health-checks.ts  — probes each configured module
 *   - ./guide.ts          — embedded documentation strings
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  loadConfig,
  saveConfig,
  getModuleStatus,
  getConfigPath,
} from '../../lib/config.js';
import { logger } from '../../lib/logger.js';
import { sanitizeToolOutput } from '../../lib/sanitize-output.js';
import { getSuiteGuide } from './guide.js';
import {
  buildEmailConfig,
  buildCalendarConfig,
  buildMessagingConfig,
  buildSearchConfig,
  buildImageConfig,
} from './setup-builders.js';
import {
  checkEmailHealth,
  checkCalendarHealth,
  checkMessagingHealth,
  checkSearchHealth,
  checkImageHealth,
} from './health-checks.js';

// ─── Registration ────────────────────────────────────

export function registerSystemTools(server: McpServer): void {
  registerSuiteGuide(server);
  registerSuiteStatus(server);
  registerSuiteSetup(server);
  registerSuiteHealth(server);
  registerSuiteDelete(server);
}

// ─── suite_guide ─────────────────────────────────────

function registerSuiteGuide(server: McpServer): void {
  server.tool(
    'suite_guide',
    'Embedded documentation. Topics: quickstart, connect, email, calendar, messaging, search, image, oauth. Call this FIRST on a new connection to learn how the suite works.',
    {
      topic: z
        .enum(['quickstart', 'connect', 'email', 'calendar', 'messaging', 'search', 'image', 'oauth'])
        .optional()
        .describe('Which topic to load. Default: quickstart'),
    },
    async ({ topic }) => {
      const guide = getSuiteGuide(topic || 'quickstart');
      return sanitizeToolOutput({
        content: [{ type: 'text' as const, text: guide }],
      });
    },
  );
}

// ─── suite_status ────────────────────────────────────

function registerSuiteStatus(server: McpServer): void {
  server.tool(
    'suite_status',
    'Show which modules are configured and ready to use. Call this first to understand what is available.',
    {},
    async () => {
      try {
        const status = await getModuleStatus();
        const configPath = getConfigPath();

        // First-time detection: NO modules configured
        const anyConfigured = status.email.configured || status.calendar.configured ||
          status.messaging.configured || status.search.configured || status.image.configured;

        const lines: string[] = [];

        if (!anyConfigured) {
          lines.push('# Welcome to Personal Suite!');
          lines.push('');
          lines.push('This is your first connection. None of the 4 modules are configured yet.');
          lines.push('');
          lines.push('## Get started in 3 steps:');
          lines.push('');
          lines.push('1. **Learn the basics:** `suite_guide(topic: "quickstart")`');
          lines.push('2. **Configure a module:** `suite_setup(module: "email")` (or calendar/messaging/search)');
          lines.push('3. **Verify it works:** `suite_health`');
          lines.push('');
          lines.push('## What you can do');
          lines.push('- Send and receive emails (Gmail, Outlook, IMAP)');
          lines.push('- Manage your calendar (Google Calendar or CalDAV: iCloud, Nextcloud, mailbox.org, etc.)');
          lines.push('- Send messages on Telegram, Discord, Slack, WhatsApp');
          lines.push('- Search the web (SearXNG or Brave)');
          lines.push('');
          lines.push('## Need OAuth help?');
          lines.push('Call `suite_guide(topic: "oauth")` for Google Cloud setup walkthrough.');
          lines.push('');
          lines.push('---');
          lines.push('');
        }

        lines.push('# Module Status');
        lines.push('');
        lines.push(`Config: ${configPath}`);
        lines.push('');
        lines.push('## Modules');
        lines.push('');

        // Email
        const emailIcon = status.email.configured ? '[OK]' : '[--]';
        const emailDetail = status.email.configured
          ? `Provider: ${status.email.provider}`
          : 'Not configured. Run suite_setup(module: "email") to set up.';
        lines.push(`${emailIcon} Email: ${emailDetail}`);

        // Calendar
        const calIcon = status.calendar.configured ? '[OK]' : '[--]';
        const calDetail = status.calendar.configured
          ? `Provider: ${status.calendar.provider}`
          : 'Not configured. Run suite_setup(module: "calendar") to set up.';
        lines.push(`${calIcon} Calendar: ${calDetail}`);

        // Messaging
        const msgIcon = status.messaging.configured ? '[OK]' : '[--]';
        const msgDetail = status.messaging.configured
          ? `Platforms: ${status.messaging.platforms.join(', ')}`
          : 'Not configured. Run suite_setup(module: "messaging") to set up.';
        lines.push(`${msgIcon} Messaging: ${msgDetail}`);

        // Search
        const searchIcon = status.search.configured ? '[OK]' : '[--]';
        const searchDetail = status.search.configured
          ? `Engines: ${status.search.engines.join(', ')}`
          : 'Not configured. Run suite_setup(module: "search") to set up.';
        lines.push(`${searchIcon} Search: ${searchDetail}`);

        // Image
        const imageIcon = status.image.configured ? '[OK]' : '[--]';
        const imageDetail = status.image.configured
          ? `Providers: ${status.image.providers.join(', ')}`
          : 'Not configured. Run suite_setup(module: "image") to set up.';
        lines.push(`${imageIcon} Image: ${imageDetail}`);

        lines.push('');
        lines.push('## Tool Prefixes');
        lines.push('- email_*    — Email tools (15)');
        lines.push('- calendar_* — Calendar tools (11)');
        lines.push('- channel_*  — Messaging tools (8)');
        lines.push('- search_*   — Search tools (7): web/news/images/deep + semantic/code/research');
        lines.push('- image_*    — Image tools (3): generate/edit/download');
        lines.push('- suite_*    — System tools (4): status, setup, health, guide');

        return sanitizeToolOutput({
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        });
      } catch (err) {
        logger.logError('suite_status failed', err);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error checking status: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}

// ─── suite_setup ─────────────────────────────────────

function registerSuiteSetup(server: McpServer): void {
  server.tool(
    'suite_setup',
    'Configure a module. For email: just provide email_address + email_password — settings are auto-detected for 30K+ providers. For advanced/OAuth: use email_provider + manual fields. Supported modules: email, calendar, messaging, search.',
    {
      module: z
        .enum(['email', 'calendar', 'messaging', 'search', 'image'])
        .describe('Which module to configure'),

      // Email Quick Setup (KMU-friendly: just email + password)
      email_address: z
        .string()
        .optional()
        .describe('Email address (e.g. info@meinefirma.de). Auto-detects IMAP/SMTP settings for 30K+ providers. Just provide this + email_password for quick setup.'),
      email_password: z
        .string()
        .optional()
        .describe('Email password or app password. Used with auto-detected IMAP/SMTP settings.'),

      // Email fields (advanced / override)
      email_provider: z
        .enum(['gmail', 'outlook', 'imap'])
        .optional()
        .describe('Email provider. Not needed if email_address is provided (auto-detected). Use for OAuth flows (gmail/outlook).'),
      email_imap_host: z.string().optional().describe('IMAP host (for IMAP provider)'),
      email_imap_port: z.number().optional().describe('IMAP port (default: 993)'),
      email_imap_user: z.string().optional().describe('IMAP username'),
      email_imap_password: z.string().optional().describe('IMAP password'),
      email_smtp_host: z.string().optional().describe('SMTP host (for IMAP provider)'),
      email_smtp_port: z.number().optional().describe('SMTP port (default: 587)'),
      email_from_name: z.string().optional().describe('Sender display name'),
      email_from_address: z.string().optional().describe('Sender email address'),
      email_oauth_client_id: z
        .string()
        .optional()
        .describe('OAuth2 client ID (for Gmail/Outlook)'),
      email_oauth_client_secret: z
        .string()
        .optional()
        .describe('OAuth2 client secret (for Gmail/Outlook)'),
      email_oauth_access_token: z
        .string()
        .optional()
        .describe('OAuth2 access token'),
      email_oauth_refresh_token: z
        .string()
        .optional()
        .describe('OAuth2 refresh token'),

      // Calendar fields
      calendar_provider: z
        .enum(['google', 'caldav'])
        .optional()
        .describe('Calendar provider: "google" (default) or "caldav" (iCloud, Nextcloud, mailbox.org, Posteo, Radicale, any CalDAV server)'),
      calendar_oauth_client_id: z
        .string()
        .optional()
        .describe('Google OAuth2 client ID (for Google provider)'),
      calendar_oauth_client_secret: z
        .string()
        .optional()
        .describe('Google OAuth2 client secret (for Google provider)'),
      calendar_oauth_access_token: z
        .string()
        .optional()
        .describe('Google OAuth2 access token (for Google provider)'),
      calendar_oauth_refresh_token: z
        .string()
        .optional()
        .describe('Google OAuth2 refresh token (for Google provider)'),
      calendar_caldav_url: z
        .string()
        .optional()
        .describe('CalDAV server URL (e.g. https://caldav.icloud.com, https://cloud.example.com/remote.php/dav, https://dav.mailbox.org)'),
      calendar_caldav_username: z
        .string()
        .optional()
        .describe('CalDAV username (usually your email address)'),
      calendar_caldav_password: z
        .string()
        .optional()
        .describe('CalDAV password (or app-specific password for iCloud/Fastmail)'),
      calendar_default_calendar_id: z
        .string()
        .optional()
        .describe('Default calendar ID. For Google: "primary". For CalDAV: the calendar URL from calendar_list_calendars.'),

      // Messaging fields (use channel_* prefix to match tool names)
      channel_platform: z
        .enum(['telegram', 'discord', 'slack', 'whatsapp'])
        .optional()
        .describe('Which messaging platform to configure'),
      channel_bot_token: z
        .string()
        .optional()
        .describe('Bot token (Telegram/Discord/Slack)'),
      channel_signing_secret: z
        .string()
        .optional()
        .describe('Signing secret (Slack only)'),
      channel_default_id: z
        .string()
        .optional()
        .describe('Default channel/chat ID'),

      // Search fields
      search_searxng_url: z
        .string()
        .optional()
        .describe('SearXNG instance URL (self-hosted, privacy-focused)'),
      search_brave_api_key: z
        .string()
        .optional()
        .describe('Brave Search API key (2000 queries/month free)'),
      search_exa_api_key: z
        .string()
        .optional()
        .describe('Exa API key — enables search_semantic + search_code_context (see exa.ai pricing)'),
      search_tavily_api_key: z
        .string()
        .optional()
        .describe('Tavily API key — enables search_research (1000 free credits/month, advanced=2 credits/query)'),

      // Image fields
      image_openai_api_key: z
        .string()
        .optional()
        .describe('OpenAI API key for DALL-E 3 image generation (best for text/logos). ~$0.04-0.12/image.'),
      image_flux_api_key: z
        .string()
        .optional()
        .describe('fal.ai API key for Flux Pro (best for photorealistic). ~$0.04/image.'),
      image_gemini_api_key: z
        .string()
        .optional()
        .describe('Google AI API key for Gemini / Imagen 3 (versatile fallback). ~$0.04-0.30/image.'),
    },
    async (args) => {
      try {
        const config = await loadConfig();
        const moduleName = args.module as string;

        let setupNote = '';

        switch (moduleName) {
          case 'email': {
            // Quick Setup: email_address + email_password → auto-discover
            const emailAddr = args.email_address as string | undefined;
            const emailPass = args.email_password as string | undefined;
            if (emailAddr && emailPass && !args.email_provider) {
              const { discoverEmailSettings, formatDiscoveryResult } = await import('../../modules/email/auto-discover.js');
              const discovery = await discoverEmailSettings(emailAddr);
              if (discovery.found && discovery.settings) {
                const s = discovery.settings;
                if (s.requiresOAuth) {
                  // Can't auto-configure OAuth — give instructions
                  setupNote = formatDiscoveryResult(emailAddr, discovery);
                  setupNote += '\n\nOAuth provider detected — use suite_setup with email_provider: "' + s.provider + '" and OAuth tokens instead.';
                  break;
                }
                // Auto-configure IMAP with discovered settings
                config.email = {
                  provider: 'imap',
                  imap: { host: s.imap.host, port: s.imap.port, user: emailAddr, password: emailPass, tls: s.imap.tls },
                  smtp: { host: s.smtp.host, port: s.smtp.port, user: emailAddr, password: emailPass, tls: s.smtp.tls },
                  fromAddress: emailAddr,
                  fromName: args.email_from_name as string || undefined,
                };
                setupNote = formatDiscoveryResult(emailAddr, discovery);
              } else {
                setupNote = discovery.suggestions?.join('\n') || 'Could not auto-detect settings. Please provide IMAP/SMTP details manually.';
                break;
              }
            } else {
              config.email = buildEmailConfig(args);
            }
            break;
          }
          case 'calendar':
            config.calendar = buildCalendarConfig(args);
            break;
          case 'messaging':
            config.messaging = buildMessagingConfig(config.messaging, args);
            break;
          case 'search':
            config.search = buildSearchConfig(args);
            break;
          case 'image':
            config.image = buildImageConfig(args);
            break;
        }

        // If we only have a note (e.g., OAuth required), return without saving
        if (setupNote && !config.email && !config.calendar && !config.messaging && !config.search) {
          return sanitizeToolOutput({
            content: [{ type: 'text' as const, text: setupNote }],
          });
        }

        await saveConfig(config);

        // Trust signal: tell user where credentials are stored
        const storageNote = `Your credentials are stored in ${getConfigPath()} (owner-read-only, permissions 0600, AES-256-GCM encrypted at rest). No data is sent to external servers.`;

        const successMsg = setupNote
          ? `${setupNote}\n\n---\nModule "${moduleName}" configured successfully. ${storageNote}\n\nRun suite_health to test the connection.`
          : `Module "${moduleName}" configured successfully. ${storageNote}\n\nRun suite_status to verify, or suite_health to test the connection.`;

        return sanitizeToolOutput({
          content: [{ type: 'text' as const, text: successMsg }],
        });
      } catch (err) {
        logger.logError('suite_setup failed', err);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Setup failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}

// ─── suite_health ────────────────────────────────────

function registerSuiteHealth(server: McpServer): void {
  server.tool(
    'suite_health',
    'Run health checks on all configured modules. Tests actual connections (IMAP, Calendar API, messaging bots, search engines).',
    {},
    async () => {
      try {
        const config = await loadConfig();
        const results: string[] = ['# Health Check Results', ''];

        // Email health
        results.push('## Email');
        if (config.email) {
          results.push(await checkEmailHealth(config.email));
        } else {
          results.push('[SKIP] Not configured');
        }
        results.push('');

        // Calendar health
        results.push('## Calendar');
        if (config.calendar) {
          results.push(await checkCalendarHealth(config.calendar));
        } else {
          results.push('[SKIP] Not configured');
        }
        results.push('');

        // Messaging health
        results.push('## Messaging');
        if (config.messaging) {
          const msgResults = await checkMessagingHealth(config.messaging);
          results.push(...msgResults);
        } else {
          results.push('[SKIP] Not configured');
        }
        results.push('');

        // Search health
        results.push('## Search');
        if (config.search) {
          const searchResults = await checkSearchHealth(config.search);
          results.push(...searchResults);
        } else {
          results.push('[SKIP] Not configured');
        }
        results.push('');

        // Image health
        results.push('## Image');
        if (config.image) {
          const imageResults = checkImageHealth(config.image);
          results.push(...imageResults);
        } else {
          results.push('[SKIP] Not configured');
        }

        return sanitizeToolOutput({
          content: [{ type: 'text' as const, text: results.join('\n') }],
        });
      } catch (err) {
        logger.logError('suite_health failed', err);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Health check error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}

// ─── suite_delete (GDPR/DSGVO) ──────────────────────

function registerSuiteDelete(server: McpServer): void {
  server.tool(
    'suite_delete',
    'Delete your configuration and credentials. For GDPR/DSGVO compliance — removes all stored data. Specify a module or "all".',
    {
      module: z
        .enum(['email', 'calendar', 'messaging', 'search', 'image', 'all'])
        .describe('Which module to delete, or "all" to remove everything'),
      confirm: z
        .boolean()
        .describe('Must be true to confirm deletion. This action cannot be undone.'),
    },
    async ({ module: mod, confirm }) => {
      if (!confirm) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Deletion cancelled. Set confirm: true to proceed. This will permanently remove your credentials.',
          }],
        };
      }

      try {
        const config = await loadConfig();
        const deleted: string[] = [];

        if (mod === 'all' || mod === 'email') { delete config.email; deleted.push('email'); }
        if (mod === 'all' || mod === 'calendar') { delete config.calendar; deleted.push('calendar'); }
        if (mod === 'all' || mod === 'messaging') { delete config.messaging; deleted.push('messaging'); }
        if (mod === 'all' || mod === 'search') { delete config.search; deleted.push('search'); }
        if (mod === 'all' || mod === 'image') { delete config.image; deleted.push('image'); }

        await saveConfig(config);

        return {
          content: [{
            type: 'text' as const,
            text: `Deleted: ${deleted.join(', ')}. All credentials removed from ${getConfigPath()}. Run suite_status to verify.`,
          }],
        };
      } catch (err) {
        logger.logError('suite_delete failed', err);
        return sanitizeToolOutput({
          content: [{ type: 'text' as const, text: `Delete failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        });
      }
    },
  );
}
