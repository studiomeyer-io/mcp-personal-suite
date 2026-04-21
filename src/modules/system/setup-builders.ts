/**
 * Config builders for suite_setup.
 *
 * Each builder turns the flat args object from the MCP tool call into a typed,
 * validated module config. Kept separate from index.ts so the registration
 * layer stays small and the per-module invariants (required fields, defaults,
 * error messages) live next to each other.
 */

import type {
  EmailConfig,
  CalendarConfig,
  CalDAVConfig,
  MessagingConfig,
  SearchConfig,
  ImageConfig,
} from '../../lib/config.js';

export function buildEmailConfig(args: Record<string, unknown>): EmailConfig {
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

export function buildCalendarConfig(args: Record<string, unknown>): CalendarConfig {
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

export function buildMessagingConfig(
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

export function buildSearchConfig(args: Record<string, unknown>): SearchConfig {
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

export function buildImageConfig(args: Record<string, unknown>): ImageConfig {
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
