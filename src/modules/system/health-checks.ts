/**
 * Health-check implementations for suite_health.
 *
 * Each function takes a module config and returns a human-readable status
 * string (or list). No MCP-server dependency — these are pure functions over
 * module configs, which makes them unit-testable in isolation and keeps the
 * registration layer in index.ts small.
 */

import type {
  EmailConfig,
  CalendarConfig,
  MessagingConfig,
  SearchConfig,
  ImageConfig,
} from '../../lib/config.js';

export async function checkEmailHealth(config: EmailConfig): Promise<string> {
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

export async function checkCalendarHealth(config: CalendarConfig): Promise<string> {
  if (config.provider === 'caldav') {
    try {
      const { caldavHealthCheck } = await import('../calendar/caldav-calendar.js');
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

export async function checkMessagingHealth(
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

export async function checkSearchHealth(config: SearchConfig): Promise<string[]> {
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

export function checkImageHealth(config: ImageConfig): string[] {
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
