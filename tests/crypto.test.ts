/**
 * Crypto Module — AES-256-GCM encryption of sensitive config fields.
 *
 * These tests cover the encrypt/decrypt pipeline, sensitive-field detection,
 * recursive object encryption, and the security hardening introduced in
 * v0.5.1 (no silent hostname-derived fallback key).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const TEST_KEY = 'test-key-do-not-use-in-prod-' + 'x'.repeat(20);

async function freshCrypto(envOverrides: Record<string, string | undefined> = {}) {
  // Reset module cache so the cachedKey in crypto.ts is re-derived per test.
  vi.resetModules();
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return await import('../src/lib/crypto.js');
}

describe('crypto — encrypt/decrypt roundtrip', () => {
  beforeEach(() => {
    process.env['CREDENTIAL_ENCRYPTION_KEY'] = TEST_KEY;
  });

  it('encrypts plaintext and decrypts back to the same value', async () => {
    const { encrypt, decrypt } = await freshCrypto({ CREDENTIAL_ENCRYPTION_KEY: TEST_KEY });
    const original = 'hunter2-my-secret-password';
    const encrypted = encrypt(original);
    expect(encrypted).toMatch(/^enc:/);
    expect(encrypted).not.toContain(original);
    expect(decrypt(encrypted)).toBe(original);
  });

  it('produces different ciphertext for same plaintext on each call (random IV)', async () => {
    const { encrypt } = await freshCrypto({ CREDENTIAL_ENCRYPTION_KEY: TEST_KEY });
    const a = encrypt('same-input');
    const b = encrypt('same-input');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^enc:/);
    expect(b).toMatch(/^enc:/);
  });

  it('is idempotent — re-encrypting an already-encrypted value returns it unchanged', async () => {
    const { encrypt } = await freshCrypto({ CREDENTIAL_ENCRYPTION_KEY: TEST_KEY });
    const once = encrypt('secret');
    const twice = encrypt(once);
    expect(twice).toBe(once);
  });

  it('returns plaintext unchanged on decrypt (backward-compat for un-migrated values)', async () => {
    const { decrypt } = await freshCrypto({ CREDENTIAL_ENCRYPTION_KEY: TEST_KEY });
    expect(decrypt('plain-value')).toBe('plain-value');
    expect(decrypt('')).toBe('');
  });

  it('returns empty string (not an exception) when GCM auth tag is tampered', async () => {
    const { encrypt, decrypt } = await freshCrypto({ CREDENTIAL_ENCRYPTION_KEY: TEST_KEY });
    const valid = encrypt('tamper-me');
    // Flip one hex char in the auth-tag segment (between the first and second colon).
    const parts = valid.slice('enc:'.length).split(':');
    parts[1] = parts[1].slice(0, -1) + (parts[1].slice(-1) === '0' ? '1' : '0');
    const tampered = 'enc:' + parts.join(':');
    expect(decrypt(tampered)).toBe('');
  });

  it('returns malformed enc: payload as-is instead of throwing', async () => {
    const { decrypt } = await freshCrypto({ CREDENTIAL_ENCRYPTION_KEY: TEST_KEY });
    const malformed = 'enc:not-a-valid-payload';
    expect(decrypt(malformed)).toBe(malformed);
  });
});

describe('crypto — isSensitiveField', () => {
  it('recognizes exact field names from the SENSITIVE_FIELDS set', async () => {
    const { isSensitiveField } = await freshCrypto({ CREDENTIAL_ENCRYPTION_KEY: TEST_KEY });
    expect(isSensitiveField('password')).toBe(true);
    expect(isSensitiveField('accessToken')).toBe(true);
    expect(isSensitiveField('refreshToken')).toBe(true);
    expect(isSensitiveField('clientSecret')).toBe(true);
    expect(isSensitiveField('botToken')).toBe(true);
    expect(isSensitiveField('braveApiKey')).toBe(true);
  });

  it('recognizes substring patterns (contains password/secret/token)', async () => {
    const { isSensitiveField } = await freshCrypto({ CREDENTIAL_ENCRYPTION_KEY: TEST_KEY });
    expect(isSensitiveField('smtpPassword')).toBe(true);
    expect(isSensitiveField('oauthSecret')).toBe(true);
    expect(isSensitiveField('userToken')).toBe(true);
  });

  it('recognizes api-key suffix variants', async () => {
    const { isSensitiveField } = await freshCrypto({ CREDENTIAL_ENCRYPTION_KEY: TEST_KEY });
    expect(isSensitiveField('openaiApiKey')).toBe(true);
    expect(isSensitiveField('google_api_key')).toBe(true);
    expect(isSensitiveField('tavily_api_key')).toBe(true);
  });

  it('does not flag non-sensitive fields', async () => {
    const { isSensitiveField } = await freshCrypto({ CREDENTIAL_ENCRYPTION_KEY: TEST_KEY });
    expect(isSensitiveField('email')).toBe(false);
    expect(isSensitiveField('host')).toBe(false);
    expect(isSensitiveField('port')).toBe(false);
    expect(isSensitiveField('provider')).toBe(false);
    expect(isSensitiveField('username')).toBe(false);
  });
});

describe('crypto — encryptConfig / decryptConfig', () => {
  beforeEach(() => {
    process.env['CREDENTIAL_ENCRYPTION_KEY'] = TEST_KEY;
  });

  it('encrypts sensitive fields, leaves non-sensitive fields alone', async () => {
    const { encryptConfig } = await freshCrypto({ CREDENTIAL_ENCRYPTION_KEY: TEST_KEY });
    const input = {
      host: 'imap.example.com',
      port: 993,
      user: 'alice',
      password: 'secret-pw',
      apiKey: 'sk-abc123',
    };
    const result = encryptConfig(input) as Record<string, unknown>;
    expect(result['host']).toBe('imap.example.com');
    expect(result['port']).toBe(993);
    expect(result['user']).toBe('alice');
    expect(result['password']).toMatch(/^enc:/);
    expect(result['apiKey']).toMatch(/^enc:/);
  });

  it('recurses into nested objects', async () => {
    const { encryptConfig, decryptConfig } = await freshCrypto({ CREDENTIAL_ENCRYPTION_KEY: TEST_KEY });
    const input = {
      email: {
        smtp: { host: 'smtp.example.com', password: 'inner-secret' },
        imap: { host: 'imap.example.com', password: 'another-secret' },
      },
    };
    const encrypted = encryptConfig(input) as Record<string, Record<string, Record<string, string>>>;
    expect(encrypted['email']!['smtp']!['password']).toMatch(/^enc:/);
    expect(encrypted['email']!['imap']!['password']).toMatch(/^enc:/);
    expect(encrypted['email']!['smtp']!['host']).toBe('smtp.example.com');

    const decrypted = decryptConfig(encrypted as unknown as Record<string, unknown>) as Record<string, Record<string, Record<string, string>>>;
    expect(decrypted['email']!['smtp']!['password']).toBe('inner-secret');
    expect(decrypted['email']!['imap']!['password']).toBe('another-secret');
  });

  it('leaves arrays and null values unchanged', async () => {
    const { encryptConfig } = await freshCrypto({ CREDENTIAL_ENCRYPTION_KEY: TEST_KEY });
    const input = {
      tags: ['a', 'b', 'c'],
      count: 5,
      enabled: true,
      maybe: null,
    };
    const result = encryptConfig(input) as Record<string, unknown>;
    expect(result['tags']).toEqual(['a', 'b', 'c']);
    expect(result['count']).toBe(5);
    expect(result['enabled']).toBe(true);
    expect(result['maybe']).toBeNull();
  });
});

describe('crypto — security hardening (v0.5.1)', () => {
  it('uses the env-provided key when CREDENTIAL_ENCRYPTION_KEY is set', async () => {
    const { encrypt, decrypt } = await freshCrypto({ CREDENTIAL_ENCRYPTION_KEY: TEST_KEY });
    const roundtrip = decrypt(encrypt('env-keyed-value'));
    expect(roundtrip).toBe('env-keyed-value');
  });

  it('derives the same key for the same env password (enables decrypt across restarts)', async () => {
    const { encrypt } = await freshCrypto({ CREDENTIAL_ENCRYPTION_KEY: TEST_KEY });
    const ct = encrypt('persisted');

    const { decrypt } = await freshCrypto({ CREDENTIAL_ENCRYPTION_KEY: TEST_KEY });
    expect(decrypt(ct)).toBe('persisted');
  });

  it('fails to decrypt when the env key changes (auth-tag mismatch → empty string)', async () => {
    const { encrypt } = await freshCrypto({ CREDENTIAL_ENCRYPTION_KEY: TEST_KEY });
    const ct = encrypt('locked-to-first-key');

    const { decrypt } = await freshCrypto({ CREDENTIAL_ENCRYPTION_KEY: 'completely-different-key-value-here' });
    expect(decrypt(ct)).toBe('');
  });
});
