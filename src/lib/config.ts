/**
 * Unified Configuration — ~/.personal-suite/config.json
 *
 * Single config file for all modules. Each module has its own section.
 * Config is loaded lazily and cached. Writes are atomic (write to tmp, rename).
 */

import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from './logger.js';
import { getCurrentTenantId } from './tenant-storage.js';
import { encryptConfig, decryptConfig } from './crypto.js';

// ─── Config Types ────────────────────────────────────

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId?: string;
  clientSecret?: string;
}

export interface ImapSmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  tls?: boolean;
}

export interface EmailConfig {
  provider: 'gmail' | 'outlook' | 'imap';
  oauth?: OAuthTokens;
  imap?: ImapSmtpConfig;
  smtp?: ImapSmtpConfig;
  fromName?: string;
  fromAddress?: string;
}

export interface CalDAVConfig {
  url: string;
  username: string;
  password: string;
  defaultCalendarId?: string;
}

export interface CalendarConfig {
  provider: 'google' | 'caldav';
  oauth?: OAuthTokens;       // for google
  caldav?: CalDAVConfig;      // for caldav
  defaultCalendarId?: string;
}

export interface TelegramConfig {
  botToken: string;
  defaultChatId?: string;
}

export interface DiscordConfig {
  botToken: string;
  defaultChannelId?: string;
}

export interface SlackConfig {
  botToken: string;
  signingSecret?: string;
  defaultChannelId?: string;
}

export interface WhatsAppConfig {
  sessionPath?: string;
}

export interface MessagingConfig {
  telegram?: TelegramConfig;
  discord?: DiscordConfig;
  slack?: SlackConfig;
  whatsapp?: WhatsAppConfig;
}

export interface SearchConfig {
  /** Self-hosted SearXNG instance URL (privacy-focused, free) */
  searxngUrl?: string;
  /** Brave Search API key (2000 queries/month free tier) */
  braveApiKey?: string;
  /** Exa API key — enables search_semantic + search_code_context (neural search) */
  exaApiKey?: string;
  /** Tavily API key — enables search_research (LLM-optimized deep research) */
  tavilyApiKey?: string;
}

export interface ImageConfig {
  /** OpenAI API key for DALL-E 3 */
  openaiApiKey?: string;
  /** fal.ai API key for Flux models */
  fluxApiKey?: string;
  /** Google AI API key for Gemini Imagen 3 */
  geminiApiKey?: string;
}

export interface SuiteConfig {
  email?: EmailConfig;
  calendar?: CalendarConfig;
  messaging?: MessagingConfig;
  search?: SearchConfig;
  image?: ImageConfig;
}

// ─── Config Path ─────────────────────────────────────

const CONFIG_DIR = join(homedir(), '.personal-suite');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}

// ─── Load / Save ─────────────────────────────────────

let cachedConfig: SuiteConfig | null = null;

export async function loadConfig(): Promise<SuiteConfig> {
  if (cachedConfig) return cachedConfig;

  try {
    if (!existsSync(CONFIG_FILE)) {
      cachedConfig = {};
      return cachedConfig;
    }
    const raw = await readFile(CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as SuiteConfig;
    // Decrypt any encrypted credential fields
    cachedConfig = decryptConfig(parsed as unknown as Record<string, unknown>) as unknown as SuiteConfig;
    return cachedConfig;
  } catch (err) {
    logger.logError('Failed to load config', err);
    cachedConfig = {};
    return cachedConfig;
  }
}

export async function saveConfig(config: SuiteConfig): Promise<void> {
  try {
    if (!existsSync(CONFIG_DIR)) {
      await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
    }

    // Encrypt sensitive fields before writing to disk
    const encrypted = encryptConfig(config as unknown as Record<string, unknown>);
    const tmpFile = CONFIG_FILE + '.tmp';
    await writeFile(tmpFile, JSON.stringify(encrypted, null, 2), { encoding: 'utf-8', mode: 0o600 });

    // Atomic rename
    const { rename } = await import('node:fs/promises');
    await rename(tmpFile, CONFIG_FILE);
    // Ensure final file has restrictive permissions (owner-only read/write)
    await chmod(CONFIG_FILE, 0o600);

    cachedConfig = config;
    logger.info('Config saved');
  } catch (err) {
    logger.logError('Failed to save config', err);
    throw new Error('Failed to save configuration');
  }
}

export async function updateConfig(
  updater: (config: SuiteConfig) => SuiteConfig,
): Promise<SuiteConfig> {
  const config = await loadConfig();
  const updated = updater({ ...config });
  await saveConfig(updated);
  return updated;
}

/**
 * Clear the in-memory config cache.
 * Useful after external config changes.
 */
export function clearConfigCache(): void {
  cachedConfig = null;
}

// ─── Status Helpers ──────────────────────────────────

export interface ModuleStatus {
  email: { configured: boolean; provider?: string };
  calendar: { configured: boolean; provider?: string };
  messaging: {
    configured: boolean;
    platforms: string[];
  };
  search: {
    configured: boolean;
    engines: string[];
  };
  image: {
    configured: boolean;
    providers: string[];
  };
}

export async function getModuleStatus(): Promise<ModuleStatus> {
  const config = await loadConfig();

  const messagingPlatforms: string[] = [];
  if (config.messaging?.telegram?.botToken) messagingPlatforms.push('telegram');
  if (config.messaging?.discord?.botToken) messagingPlatforms.push('discord');
  if (config.messaging?.slack?.botToken) messagingPlatforms.push('slack');
  if (config.messaging?.whatsapp) messagingPlatforms.push('whatsapp');

  const searchEngines: string[] = [];
  if (config.search?.searxngUrl) searchEngines.push('searxng');
  if (config.search?.braveApiKey) searchEngines.push('brave');
  if (config.search?.exaApiKey) searchEngines.push('exa');
  if (config.search?.tavilyApiKey) searchEngines.push('tavily');

  const imageProviders: string[] = [];
  if (config.image?.openaiApiKey) imageProviders.push('openai');
  if (config.image?.fluxApiKey) imageProviders.push('flux');
  if (config.image?.geminiApiKey) imageProviders.push('gemini');

  // Email: "configured" means fully usable (has tokens/password)
  const emailUsable = !!(
    (config.email?.provider === 'imap' && config.email.imap?.password) ||
    (config.email?.provider !== 'imap' && config.email?.oauth?.accessToken)
  );

  // Calendar: Google needs access token; CalDAV needs URL + credentials
  const calendarUsable = !!(
    (config.calendar?.provider === 'google' && config.calendar?.oauth?.accessToken) ||
    (config.calendar?.provider === 'caldav' && config.calendar?.caldav?.url && config.calendar?.caldav?.username)
  );

  return {
    email: {
      configured: emailUsable,
      provider: config.email?.provider,
    },
    calendar: {
      configured: calendarUsable,
      provider: config.calendar?.provider,
    },
    messaging: {
      configured: messagingPlatforms.length > 0,
      platforms: messagingPlatforms,
    },
    search: {
      configured: searchEngines.length > 0,
      engines: searchEngines,
    },
    image: {
      configured: imageProviders.length > 0,
      providers: imageProviders,
    },
  };
}
