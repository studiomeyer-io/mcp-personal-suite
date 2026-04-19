/**
 * OAuth2 Authentication — Gmail + Outlook + Legacy IMAP
 *
 * Zero database. Config stored in ~/.personal-suite/config.json
 * under the "email" key (shared with other modules via lib/config.ts).
 * Optional AES-256-GCM encryption for sensitive credentials.
 *
 * Supports three auth modes:
 * 1. Environment variables (OAUTH2_PROVIDER, OAUTH2_EMAIL, etc.)
 * 2. Shared suite config file (~/.personal-suite/config.json)
 * 3. email_setup tool for interactive configuration
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { getCurrentTenantId } from '../../lib/tenant-storage.js';

// ─── Types ───────────────────────────────────────

export type OAuthProvider = 'gmail' | 'outlook' | 'imap';

export interface OAuthConfig {
  provider: OAuthProvider;
  email: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  accessTokenExpiry?: number;
  imapHost?: string;
  imapPort?: number;
  imapUser?: string;
  imapPass?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
  refresh_token?: string;
}

// ─── Provider Constants ─────────────────────────

const GMAIL_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GMAIL_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_SCOPES = ['https://mail.google.com/'];
const GMAIL_IMAP = { host: 'imap.gmail.com', port: 993 };
const GMAIL_SMTP = { host: 'smtp.gmail.com', port: 465 };

const OUTLOOK_AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const OUTLOOK_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const OUTLOOK_SCOPES = [
  'https://outlook.office365.com/IMAP.AccessAsUser.All',
  'https://outlook.office365.com/SMTP.Send',
  'offline_access',
];
const OUTLOOK_IMAP = { host: 'outlook.office365.com', port: 993 };
const OUTLOOK_SMTP = { host: 'smtp.office365.com', port: 587 };

// ─── Config Storage (File-Based) ─────────────────

function getConfigDir(): string {
  const dir = process.env['PERSONAL_SUITE_CONFIG_DIR'] || resolve(homedir(), '.personal-suite');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getConfigPath(): string {
  return resolve(getConfigDir(), 'config.json');
}

/** Raw suite config shape — we only touch the email key */
interface SuiteConfigFile {
  email?: OAuthConfig;
  calendar?: Record<string, unknown>;
  messaging?: Record<string, unknown>;
  search?: Record<string, unknown>;
}

function loadSuiteConfigFile(): SuiteConfigFile {
  const path = getConfigPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SuiteConfigFile;
  } catch {
    return {};
  }
}

function saveSuiteConfigFile(config: SuiteConfigFile): void {
  const path = getConfigPath();
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
}

// ─── Encryption ──────────────────────────────────

const SENSITIVE_FIELDS = ['clientSecret', 'refreshToken', 'accessToken', 'imapPass', 'smtpPass'];

function getEncryptionKey(): Buffer | null {
  const key = process.env['CREDENTIAL_ENCRYPTION_KEY'];
  if (!key) return null;
  // Use env-specific salt or derive from key itself (avoids hardcoded salt = rainbow table risk)
  const salt = process.env['CREDENTIAL_ENCRYPTION_SALT'] || createHash('sha256').update(key).digest().subarray(0, 16);
  return scryptSync(key, salt, 32);
}

function encrypt(text: string, key: Buffer): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(data: string, key: Buffer): string {
  const [ivHex, tagHex, encHex] = data.split(':');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(encHex, 'hex', 'utf8') + decipher.final('utf8');
}

// ─── Email Config CRUD ─────────────────────────

// ─── Per-Tenant Config Cache (SaaS Mode) ───────────

const tenantConfigCache = new Map<string, { config: OAuthConfig | null; expiresAt: number }>();
const TENANT_CACHE_TTL = 60_000; // 60s

/**
 * Preload a tenant's email config into the sync cache.
 * Called from email tool handlers before calling email-client functions.
 */
export function preloadTenantEmailConfig(tenantId: string, config: OAuthConfig | null): void {
  tenantConfigCache.set(tenantId, { config, expiresAt: Date.now() + TENANT_CACHE_TTL });
}

export function invalidateTenantEmailConfig(tenantId: string): void {
  tenantConfigCache.delete(tenantId);
}

// Cleanup stale entries every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [tid, entry] of tenantConfigCache) {
    if (now > entry.expiresAt) tenantConfigCache.delete(tid);
  }
}, 120_000).unref();

export function loadConfig(): OAuthConfig | null {
  // SaaS mode: read from per-tenant sync cache (preloaded by tool handler)
  const tenantId = getCurrentTenantId();
  if (tenantId) {
    const cached = tenantConfigCache.get(tenantId);
    if (cached && Date.now() < cached.expiresAt) return cached.config;
    return null; // No preload? Config not available for this tenant
  }

  // First check env vars (highest priority)
  if (process.env['OAUTH2_PROVIDER'] && process.env['OAUTH2_EMAIL']) {
    return {
      provider: process.env['OAUTH2_PROVIDER'] as OAuthProvider,
      email: process.env['OAUTH2_EMAIL'],
      clientId: process.env['OAUTH2_CLIENT_ID'],
      clientSecret: process.env['OAUTH2_CLIENT_SECRET'],
      refreshToken: process.env['OAUTH2_REFRESH_TOKEN'],
      imapHost: process.env['IMAP_HOST'],
      imapPort: process.env['IMAP_PORT'] ? parseInt(process.env['IMAP_PORT']) : undefined,
      imapUser: process.env['IMAP_USER'],
      imapPass: process.env['IMAP_PASS'],
      smtpHost: process.env['SMTP_HOST'],
      smtpPort: process.env['SMTP_PORT'] ? parseInt(process.env['SMTP_PORT']) : undefined,
      smtpUser: process.env['SMTP_USER'],
      smtpPass: process.env['SMTP_PASS'],
    };
  }

  // Then check the email section in the shared config file
  const suiteConfig = loadSuiteConfigFile();
  const raw = suiteConfig.email;
  if (!raw) return null;

  const config = { ...raw };
  const key = getEncryptionKey();
  if (key) {
    for (const field of SENSITIVE_FIELDS) {
      const val = (config as unknown as Record<string, unknown>)[field];
      if (typeof val === 'string' && val.includes(':')) {
        try {
          (config as unknown as Record<string, unknown>)[field] = decrypt(val, key);
        } catch { /* Not encrypted or wrong key */ }
      }
    }
  }
  return config;
}

export function saveConfig(config: OAuthConfig): void {
  const toSave = { ...config };
  const key = getEncryptionKey();
  if (key) {
    for (const field of SENSITIVE_FIELDS) {
      const val = (toSave as unknown as Record<string, unknown>)[field];
      if (typeof val === 'string' && val.length > 0) {
        (toSave as unknown as Record<string, unknown>)[field] = encrypt(val, key);
      }
    }
  }

  const suiteConfig = loadSuiteConfigFile();
  suiteConfig.email = toSave;
  saveSuiteConfigFile(suiteConfig);
}

// ─── OAuth2 Flows ────────────────────────────────

export function generateAuthUrl(provider: OAuthProvider, clientId: string, redirectUri: string): string {
  const state = randomBytes(16).toString('hex');

  if (provider === 'gmail') {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GMAIL_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return `${GMAIL_AUTH_URL}?${params}`;
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: OUTLOOK_SCOPES.join(' '),
    state,
  });
  return `${OUTLOOK_AUTH_URL}?${params}`;
}

export async function exchangeCode(
  provider: OAuthProvider,
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<TokenResponse> {
  const tokenUrl = provider === 'gmail' ? GMAIL_TOKEN_URL : OUTLOOK_TOKEN_URL;

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const res = await fetch(tokenUrl, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<TokenResponse>;
}

export async function refreshAccessToken(config: OAuthConfig): Promise<string> {
  if (!config.refreshToken || !config.clientId || !config.clientSecret) {
    throw new Error('Missing OAuth2 credentials for token refresh');
  }

  const tokenUrl = config.provider === 'gmail' ? GMAIL_TOKEN_URL : OUTLOOK_TOKEN_URL;

  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetch(tokenUrl, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);

  const data = await res.json() as TokenResponse;

  config.accessToken = data.access_token;
  config.accessTokenExpiry = Date.now() + data.expires_in * 1000;
  if (data.refresh_token) config.refreshToken = data.refresh_token;

  // SaaS mode: persist refreshed token to tenant DB
  const tenantId = getCurrentTenantId();
  if (tenantId) {
    preloadTenantEmailConfig(tenantId, config);
    try {
      const libConfig = await import('../../lib/config.js');
      const suite = await libConfig.loadConfig();
      (suite as Record<string, unknown>).email = config;
      await libConfig.saveConfig(suite);
    } catch {
      // Non-blocking — in-memory cache is updated, next request can retry DB save
    }
  } else {
    // Stdio mode: save to filesystem
    saveConfig(config);
  }
  return data.access_token;
}

export async function getValidAccessToken(config: OAuthConfig): Promise<string> {
  if (config.accessToken && config.accessTokenExpiry && Date.now() < config.accessTokenExpiry - 60000) {
    return config.accessToken;
  }
  return refreshAccessToken(config);
}

// ─── IMAP/SMTP Config Builders ───────────────────

export function getImapConfig(config: OAuthConfig): { host: string; port: number; user: string; auth: 'oauth2' | 'basic'; password?: string } {
  if (config.provider === 'gmail') {
    return { host: GMAIL_IMAP.host, port: GMAIL_IMAP.port, user: config.email, auth: 'oauth2' };
  }
  if (config.provider === 'outlook') {
    return { host: OUTLOOK_IMAP.host, port: OUTLOOK_IMAP.port, user: config.email, auth: 'oauth2' };
  }
  return {
    host: config.imapHost ?? 'localhost',
    port: config.imapPort ?? 993,
    user: config.imapUser ?? config.email,
    auth: 'basic',
    password: config.imapPass,
  };
}

export function getSmtpConfig(config: OAuthConfig): { host: string; port: number; user: string; auth: 'oauth2' | 'basic'; password?: string } {
  if (config.provider === 'gmail') {
    return { host: GMAIL_SMTP.host, port: GMAIL_SMTP.port, user: config.email, auth: 'oauth2' };
  }
  if (config.provider === 'outlook') {
    return { host: OUTLOOK_SMTP.host, port: OUTLOOK_SMTP.port, user: config.email, auth: 'oauth2' };
  }
  return {
    host: config.smtpHost ?? 'localhost',
    port: config.smtpPort ?? 587,
    user: config.smtpUser ?? config.email,
    auth: 'basic',
    password: config.smtpPass,
  };
}
