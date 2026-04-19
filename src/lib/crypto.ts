/**
 * Credential Encryption — AES-256-GCM for sensitive config fields.
 *
 * Encryption is ALWAYS ON for local mode:
 * - If CREDENTIAL_ENCRYPTION_KEY is set, uses that
 * - Otherwise, auto-generates a key and stores it in ~/.personal-suite/.key
 *
 * For SaaS mode, CREDENTIAL_ENCRYPTION_KEY env var is REQUIRED.
 *
 * Encrypted values are prefixed with "enc:" to distinguish from plaintext.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from './logger.js';

const CONFIG_DIR = join(homedir(), '.personal-suite');
const KEY_FILE = join(CONFIG_DIR, '.key');
const ENC_PREFIX = 'enc:';

// Fields that must be encrypted when storing
export const SENSITIVE_FIELDS = new Set([
  'password', 'pass', 'secret', 'token', 'accessToken', 'refreshToken',
  'clientSecret', 'botToken', 'signingSecret', 'apiKey',
  'braveApiKey', 'exaApiKey', 'tavilyApiKey',
]);

/**
 * Check if a config key name is sensitive (should be encrypted).
 */
export function isSensitiveField(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_FIELDS.has(key) ||
    lower.includes('password') ||
    lower.includes('secret') ||
    lower.includes('token') ||
    lower.endsWith('apikey') ||
    lower.endsWith('api_key');
}

// ─── Key Management ─────────────────────────────

let cachedKey: Buffer | null = null;

function getOrCreateKey(): Buffer {
  if (cachedKey) return cachedKey;

  // 1. Env var (SaaS mode or explicit)
  const envKey = process.env['CREDENTIAL_ENCRYPTION_KEY'];
  if (envKey) {
    const salt = process.env['CREDENTIAL_ENCRYPTION_SALT'] ||
      createHash('sha256').update(envKey).digest().subarray(0, 16);
    cachedKey = scryptSync(envKey, salt, 32);
    return cachedKey;
  }

  // 2. Auto-generated key file (local mode)
  try {
    if (existsSync(KEY_FILE)) {
      const stored = readFileSync(KEY_FILE, 'utf-8').trim();
      cachedKey = Buffer.from(stored, 'hex');
      return cachedKey;
    }

    // Generate new key
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    }
    const newKey = randomBytes(32);
    writeFileSync(KEY_FILE, newKey.toString('hex'), { mode: 0o600 });
    logger.info('Generated encryption key for credential storage');
    cachedKey = newKey;
    return cachedKey;
  } catch (err) {
    logger.logError('Failed to manage encryption key', err);
    // Fallback: derive from hostname (not ideal but better than plaintext)
    const fallback = createHash('sha256').update(homedir() + '-personal-suite').digest();
    cachedKey = fallback;
    return cachedKey;
  }
}

// ─── Encrypt / Decrypt ──────────────────────────

export function encrypt(text: string): string {
  if (!text || text.startsWith(ENC_PREFIX)) return text; // Already encrypted
  const key = getOrCreateKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decrypt(data: string): string {
  if (!data || !data.startsWith(ENC_PREFIX)) return data; // Not encrypted (legacy plaintext)
  const key = getOrCreateKey();
  const payload = data.slice(ENC_PREFIX.length);
  const [ivHex, tagHex, encHex] = payload.split(':');
  if (!ivHex || !tagHex || !encHex) return data; // Malformed, return as-is
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(encHex, 'hex', 'utf8') + decipher.final('utf8');
  } catch {
    logger.warn('Failed to decrypt credential — key may have changed. Re-configure the module.');
    return ''; // Return empty, user must re-enter
  }
}

// ─── Config Object Encryption ───────────────────

/**
 * Encrypt all sensitive fields in a config object (recursive).
 * Call before saving to disk/DB.
 */
export function encryptConfig(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' && isSensitiveField(key)) {
      result[key] = encrypt(value);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = encryptConfig(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Decrypt all sensitive fields in a config object (recursive).
 * Call after loading from disk/DB.
 */
export function decryptConfig(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' && value.startsWith(ENC_PREFIX)) {
      result[key] = decrypt(value);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = decryptConfig(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}
