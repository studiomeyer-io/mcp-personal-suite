/**
 * System Module — suite_status, suite_setup, suite_health
 *
 * Meta-tools for managing the Personal Suite itself:
 * - Check which modules are configured
 * - Interactive setup wizard for each module
 * - Health checks for all configured connections
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  loadConfig,
  saveConfig,
  getModuleStatus,
  getConfigPath,
  type SuiteConfig,
  type EmailConfig,
  type CalendarConfig,
  type CalDAVConfig,
  type MessagingConfig,
  type SearchConfig,
  type ImageConfig,
} from '../../lib/config.js';
import { logger } from '../../lib/logger.js';
import { getSuiteGuide } from './guide.js';
import { getCurrentTenantId } from '../../lib/tenant-storage.js';

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
      return {
        content: [{ type: 'text' as const, text: guide }],
      };
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
        const tenantId = getCurrentTenantId();
        const configPath = tenantId
          ? `cloud database (tenant ${tenantId.slice(0, 8)})`
          : getConfigPath();

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

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
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
          return {
            content: [{ type: 'text' as const, text: setupNote }],
          };
        }

        await saveConfig(config);

        // Trust signal: tell user where credentials are stored
        const tenantId = getCurrentTenantId();
        const storageNote = tenantId
          ? 'Your credentials are stored encrypted in the EU tenant database (Supabase Frankfurt). Only your account can access them.'
          : `Your credentials are stored in ${getConfigPath()} (owner-read-only, permissions 600). No data is sent to external servers.`;

        const successMsg = setupNote
          ? `${setupNote}\n\n---\nModule "${moduleName}" configured successfully. ${storageNote}\n\nRun suite_health to test the connection.`
          : `Module "${moduleName}" configured successfully. ${storageNote}\n\nRun suite_status to verify, or suite_health to test the connection.`;

        return {
          content: [{ type: 'text' as const, text: successMsg }],
        };
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

// ─── Config Builders ─────────────────────────────────

function buildEmailConfig(args: Record<string, unknown>): EmailConfig {
  const provider = args.email_provider as 'gmail' | 'outlook' | 'imap' | undefined;
  if (!provider) {
    throw new Error('email_provider is required for email module setup');
  }

  const emailConfig: EmailConfig = {
    provider,
    fromName: (args.email_from_name as string) || undefined,
    fromAddress: (args.email_from_address as string) || undefined,
  };

  if (provider === 'gmail' || provider === 'outlook') {
    const clientId = args.email_oauth_client_id as string | undefined;
    const clientSecret = args.email_oauth_client_secret as string | undefined;
    if (!clientId || !clientSecret) {
      throw new Error(
        `OAuth2 client_id and client_secret are required for ${provider}. ` +
          'Provide email_oauth_client_id and email_oauth_client_secret.',
      );
    }
    emailConfig.oauth = {
      accessToken: (args.email_oauth_access_token as string) || '',
      refreshToken: (args.email_oauth_refresh_token as string) || undefined,
      clientId,
      clientSecret,
    };
  }

  if (provider === 'imap') {
    const imapHost = args.email_imap_host as string | undefined;
    const imapUser = args.email_imap_user as string | undefined;
    const imapPassword = args.email_imap_password as string | undefined;
    if (!imapHost || !imapUser || !imapPassword) {
      throw new Error(
        'IMAP setup requires email_imap_host, email_imap_user, and email_imap_password',
      );
    }
    emailConfig.imap = {
      host: imapHost,
      port: (args.email_imap_port as number) || 993,
      user: imapUser,
      password: imapPassword,
      tls: true,
    };
    emailConfig.smtp = {
      host: (args.email_smtp_host as string) || imapHost,
      port: (args.email_smtp_port as number) || 587,
      user: imapUser,
      password: imapPassword,
      tls: true,
    };
  }

  return emailConfig;
}

function buildCalendarConfig(args: Record<string, unknown>): CalendarConfig {
  const provider = (args.calendar_provider as 'google' | 'caldav' | undefined) ?? 'google';

  if (provider === 'caldav') {
    const url = args.calendar_caldav_url as string | undefined;
    const username = args.calendar_caldav_username as string | undefined;
    const password = args.calendar_caldav_password as string | undefined;
    if (!url || !username || !password) {
      throw new Error(
        'CalDAV requires calendar_caldav_url, calendar_caldav_username, and calendar_caldav_password. ' +
        'Example: suite_setup(module: "calendar", calendar_provider: "caldav", ' +
        'calendar_caldav_url: "https://caldav.icloud.com", calendar_caldav_username: "user@icloud.com", ' +
        'calendar_caldav_password: "app-specific-password")',
      );
    }

    const caldav: CalDAVConfig = {
      url,
      username,
      password,
      defaultCalendarId: (args.calendar_default_calendar_id as string) || undefined,
    };

    return {
      provider: 'caldav',
      caldav,
      defaultCalendarId: caldav.defaultCalendarId,
    };
  }

  // Google provider
  const clientId = args.calendar_oauth_client_id as string | undefined;
  const clientSecret = args.calendar_oauth_client_secret as string | undefined;
  if (!clientId || !clientSecret) {
    throw new Error(
      'Google Calendar requires calendar_oauth_client_id and calendar_oauth_client_secret. ' +
      'Or use CalDAV: suite_setup(module: "calendar", calendar_provider: "caldav", ...)',
    );
  }

  return {
    provider: 'google',
    oauth: {
      accessToken: (args.calendar_oauth_access_token as string) || '',
      refreshToken: (args.calendar_oauth_refresh_token as string) || undefined,
      clientId,
      clientSecret,
    },
    defaultCalendarId:
      (args.calendar_default_calendar_id as string) || 'primary',
  };
}

function buildMessagingConfig(
  existing: MessagingConfig | undefined,
  args: Record<string, unknown>,
): MessagingConfig {
  const config: MessagingConfig = { ...existing };
  const platform = args.channel_platform as string | undefined;

  if (!platform) {
    throw new Error(
      'channel_platform is required for messaging module setup (telegram, discord, slack, whatsapp)',
    );
  }

  const botToken = args.channel_bot_token as string | undefined;
  const defaultChannel = args.channel_default_id as string | undefined;

  switch (platform) {
    case 'telegram':
      if (!botToken)
        throw new Error('channel_bot_token is required for Telegram');
      config.telegram = {
        botToken,
        defaultChatId: defaultChannel,
      };
      break;
    case 'discord':
      if (!botToken)
        throw new Error('channel_bot_token is required for Discord');
      config.discord = {
        botToken,
        defaultChannelId: defaultChannel,
      };
      break;
    case 'slack':
      if (!botToken)
        throw new Error('channel_bot_token is required for Slack');
      config.slack = {
        botToken,
        signingSecret: (args.channel_signing_secret as string) || undefined,
        defaultChannelId: defaultChannel,
      };
      break;
    case 'whatsapp':
      config.whatsapp = {
        sessionPath: defaultChannel || undefined,
      };
      break;
    default:
      throw new Error(`Unknown platform: ${platform}`);
  }

  return config;
}

function buildSearchConfig(args: Record<string, unknown>): SearchConfig {
  const searxngUrl = args.search_searxng_url as string | undefined;
  const braveApiKey = args.search_brave_api_key as string | undefined;
  const exaApiKey = args.search_exa_api_key as string | undefined;
  const tavilyApiKey = args.search_tavily_api_key as string | undefined;

  if (!searxngUrl && !braveApiKey && !exaApiKey && !tavilyApiKey) {
    throw new Error(
      'At least one search provider is required: search_searxng_url, search_brave_api_key, search_exa_api_key, or search_tavily_api_key',
    );
  }

  return {
    searxngUrl: searxngUrl || undefined,
    braveApiKey: braveApiKey || undefined,
    exaApiKey: exaApiKey || undefined,
    tavilyApiKey: tavilyApiKey || undefined,
  };
}

function buildImageConfig(args: Record<string, unknown>): ImageConfig {
  const openaiApiKey = args.image_openai_api_key as string | undefined;
  const fluxApiKey = args.image_flux_api_key as string | undefined;
  const geminiApiKey = args.image_gemini_api_key as string | undefined;

  if (!openaiApiKey && !fluxApiKey && !geminiApiKey) {
    throw new Error(
      'At least one image provider is required: image_openai_api_key, image_flux_api_key, or image_gemini_api_key',
    );
  }

  return {
    openaiApiKey: openaiApiKey || undefined,
    fluxApiKey: fluxApiKey || undefined,
    geminiApiKey: geminiApiKey || undefined,
  };
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

        return {
          content: [{ type: 'text' as const, text: results.join('\n') }],
        };
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

// ─── Health Check Implementations ────────────────────

async function checkEmailHealth(config: EmailConfig): Promise<string> {
  if (config.provider === 'imap' && config.imap) {
    try {
      const { ImapFlow } = await import('imapflow');
      const client = new ImapFlow({
        host: config.imap!.host,
        port: config.imap!.port,
        secure: config.imap!.tls ?? true,
        auth: { user: config.imap!.user, pass: config.imap!.password ?? '' },
        logger: false,
        tls: { rejectUnauthorized: true },
        connectionTimeout: 10_000,
      } as ConstructorParameters<typeof ImapFlow>[0]);

      try {
        await client.connect();
        await client.logout();
        return `[OK] IMAP connected to ${config.imap!.host}:${config.imap!.port}`;
      } catch (err) {
        return `[FAIL] IMAP error: ${err instanceof Error ? err.message : String(err)}`;
      }
    } catch (err) {
      return `[FAIL] IMAP: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (config.provider === 'gmail' || config.provider === 'outlook') {
    if (config.oauth?.accessToken) {
      return `[OK] ${config.provider} OAuth configured (token present)`;
    }
    return `[WARN] ${config.provider} OAuth configured but no access token. Run email_auth to complete setup.`;
  }

  return '[WARN] Email configured but provider details incomplete';
}

async function checkCalendarHealth(config: CalendarConfig): Promise<string> {
  if (config.provider === 'caldav') {
    try {
      const { caldavHealthCheck } = await import('../../modules/calendar/caldav-calendar.js');
      return await caldavHealthCheck();
    } catch (err) {
      return `[FAIL] CalDAV: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Google provider
  if (config.oauth?.accessToken) {
    return `[OK] Google Calendar OAuth configured (token present)`;
  }
  return '[WARN] Google Calendar configured but no access token';
}

async function checkMessagingHealth(
  config: MessagingConfig,
): Promise<string[]> {
  const results: string[] = [];

  if (config.telegram?.botToken) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${config.telegram.botToken}/getMe`,
      );
      if (response.ok) {
        const data = (await response.json()) as {
          ok: boolean;
          result?: { username?: string };
        };
        const username =
          data.result?.username || 'unknown';
        results.push(`[OK] Telegram bot: @${username}`);
      } else {
        results.push(`[FAIL] Telegram: HTTP ${response.status}`);
      }
    } catch (err) {
      results.push(
        `[FAIL] Telegram: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (config.discord?.botToken) {
    try {
      const response = await fetch('https://discord.com/api/v10/users/@me', {
        headers: {
          Authorization: `Bot ${config.discord.botToken}`,
        },
      });
      if (response.ok) {
        const data = (await response.json()) as { username?: string };
        results.push(`[OK] Discord bot: ${data.username || 'connected'}`);
      } else {
        results.push(`[FAIL] Discord: HTTP ${response.status}`);
      }
    } catch (err) {
      results.push(
        `[FAIL] Discord: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (config.slack?.botToken) {
    try {
      const response = await fetch('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.slack.botToken}`,
          'Content-Type': 'application/json',
        },
      });
      if (response.ok) {
        const data = (await response.json()) as {
          ok: boolean;
          user?: string;
          error?: string;
        };
        if (data.ok) {
          results.push(`[OK] Slack bot: ${data.user || 'connected'}`);
        } else {
          results.push(`[FAIL] Slack: ${data.error || 'unknown error'}`);
        }
      } else {
        results.push(`[FAIL] Slack: HTTP ${response.status}`);
      }
    } catch (err) {
      results.push(
        `[FAIL] Slack: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (config.whatsapp) {
    results.push('[INFO] WhatsApp: configured (connection tested on first use)');
  }

  if (results.length === 0) {
    results.push('[SKIP] No messaging platforms configured');
  }

  return results;
}

async function checkSearchHealth(config: SearchConfig): Promise<string[]> {
  const results: string[] = [];

  if (config.searxngUrl) {
    try {
      const response = await fetch(`${config.searxngUrl}/config`, {
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        results.push(`[OK] SearXNG at ${config.searxngUrl}`);
      } else {
        results.push(`[FAIL] SearXNG: HTTP ${response.status}`);
      }
    } catch (err) {
      results.push(
        `[FAIL] SearXNG: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (config.braveApiKey) {
    try {
      const response = await fetch(
        'https://api.search.brave.com/res/v1/web/search?q=test&count=1',
        {
          headers: {
            'X-Subscription-Token': config.braveApiKey,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(5000),
        },
      );
      if (response.ok) {
        results.push('[OK] Brave Search API');
      } else {
        results.push(`[FAIL] Brave Search: HTTP ${response.status}`);
      }
    } catch (err) {
      results.push(
        `[FAIL] Brave Search: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (results.length === 0) {
    results.push('[SKIP] No search engines configured');
  }

  return results;
}

function checkImageHealth(config: ImageConfig): string[] {
  const results: string[] = [];

  if (config.openaiApiKey) {
    const masked = config.openaiApiKey.slice(0, 7) + '...' + config.openaiApiKey.slice(-4);
    results.push(`[OK] OpenAI (DALL-E 3): key configured (${masked})`);
  }

  if (config.fluxApiKey) {
    const masked = config.fluxApiKey.slice(0, 4) + '...' + config.fluxApiKey.slice(-4);
    results.push(`[OK] Flux Pro (fal.ai): key configured (${masked})`);
  }

  if (config.geminiApiKey) {
    const masked = config.geminiApiKey.slice(0, 4) + '...' + config.geminiApiKey.slice(-4);
    results.push(`[OK] Gemini (Google AI): key configured (${masked})`);
  }

  if (results.length === 0) {
    results.push('[SKIP] No image providers configured');
  }

  return results;
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

        const tenantId = getCurrentTenantId();
        const where = tenantId ? 'tenant database' : getConfigPath();

        return {
          content: [{
            type: 'text' as const,
            text: `Deleted: ${deleted.join(', ')}. All credentials removed from ${where}. Run suite_status to verify.`,
          }],
        };
      } catch (err) {
        logger.logError('suite_delete failed', err);
        return {
          content: [{ type: 'text' as const, text: `Delete failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );
}
