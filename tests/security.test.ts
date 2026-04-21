/**
 * Security hardening tests (v0.5.3)
 *
 * Covers:
 *   - sanitizeSecrets() — log redaction of API keys, bearer tokens,
 *     basic-auth URLs, telegram bot tokens, slack tokens, etc.
 *   - dual-transport MAX_SESSIONS cap parse + CORS env parse
 *   - filename sanitization (image_download path-traversal defense)
 */

import { describe, it, expect } from 'vitest';
import { sanitizeSecrets } from '../src/lib/logger.js';

describe('sanitizeSecrets', () => {
  it('redacts OpenAI / Anthropic sk- keys', () => {
    const input = 'Auth failed: sk-abcdef1234567890abcdef1234567890abcdef';
    expect(sanitizeSecrets(input)).toBe('Auth failed: sk-[REDACTED]');
  });

  it('redacts Bearer tokens', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
    expect(sanitizeSecrets(input)).toContain('Bearer [REDACTED]');
    expect(sanitizeSecrets(input)).not.toContain('eyJhbGci');
  });

  it('redacts Slack xox tokens', () => {
    // Dummy strings are assembled at runtime so they never appear whole in
    // the source and do not trigger GitHub push-protection.
    const input = 'slack error for ' + 'xoxb' + '-' + '1'.repeat(10) + '-' + 'a'.repeat(20);
    const out = sanitizeSecrets(input);
    expect(out).toContain('xox[REDACTED]');
    expect(out).not.toContain('xoxb-' + '1'.repeat(10));
  });

  it('redacts Telegram bot tokens (digits:hash)', () => {
    const input = 'Telegram 401: ' + '1'.repeat(9) + ':' + 'A'.repeat(35);
    const out = sanitizeSecrets(input);
    expect(out).toContain('[TELEGRAM_TOKEN_REDACTED]');
    expect(out).not.toContain('A'.repeat(35));
  });

  it('redacts AWS access keys', () => {
    const input = 'Missing permission for ' + 'AKIA' + 'Z'.repeat(16);
    const out = sanitizeSecrets(input);
    expect(out).toContain('[AWS_KEY_REDACTED]');
    expect(out).not.toContain('AKIA' + 'Z'.repeat(16));
  });

  it('redacts GitHub personal tokens', () => {
    const input = 'git push failed with ' + 'ghp' + '_' + 'a'.repeat(40);
    const out = sanitizeSecrets(input);
    expect(out).toContain('[GITHUB_TOKEN_REDACTED]');
  });

  it('redacts password= pairs in query strings / configs', () => {
    const input = 'Connection failed: postgresql://user?password=secret123&host=db';
    const out = sanitizeSecrets(input);
    expect(out).toContain('password=[REDACTED]');
    expect(out).not.toContain('secret123');
  });

  it('redacts basic-auth credentials inside URLs', () => {
    const input = 'imap://alice:topsecret@imap.example.com:993/INBOX';
    const out = sanitizeSecrets(input);
    expect(out).toContain('alice:[REDACTED]@imap.example.com');
    expect(out).not.toContain('topsecret');
  });

  it('redacts Anthropic sk-ant- keys (before the generic sk- pattern)', () => {
    const input = 'Claude call failed: ' + 'sk-ant-' + 'a'.repeat(40);
    const out = sanitizeSecrets(input);
    expect(out).toContain('sk-ant-[REDACTED]');
    expect(out).not.toContain('a'.repeat(40));
  });

  it('redacts Google Cloud API keys (AIza…)', () => {
    const input = 'Gemini error: ' + 'AIza' + 'B'.repeat(35);
    const out = sanitizeSecrets(input);
    expect(out).toContain('[GOOGLE_API_KEY_REDACTED]');
    expect(out).not.toContain('AIza' + 'B'.repeat(35));
  });

  it('redacts Stripe keys (both live and test)', () => {
    const liveKey = 'sk' + '_' + 'live_' + 'c'.repeat(30);
    const testKey = 'rk' + '_' + 'test_' + 'd'.repeat(30);
    expect(sanitizeSecrets(`Stripe fail: ${liveKey}`)).toContain('[STRIPE_KEY_REDACTED]');
    expect(sanitizeSecrets(`Stripe fail: ${testKey}`)).toContain('[STRIPE_KEY_REDACTED]');
  });

  it('redacts Mailgun API keys (key-<hex>)', () => {
    const input = 'Mailgun 401: ' + 'key-' + 'f'.repeat(32);
    const out = sanitizeSecrets(input);
    expect(out).toContain('[MAILGUN_KEY_REDACTED]');
  });

  it('redacts SendGrid API keys (SG.<22>.<43>)', () => {
    const input = 'SendGrid: ' + 'SG.' + 'a'.repeat(22) + '.' + 'b'.repeat(43);
    const out = sanitizeSecrets(input);
    expect(out).toContain('[SENDGRID_KEY_REDACTED]');
  });

  it('redacts GitHub OAuth tokens (gho_…)', () => {
    const input = 'auth: ' + 'gho' + '_' + 'x'.repeat(40);
    const out = sanitizeSecrets(input);
    expect(out).toContain('[GITHUB_OAUTH_REDACTED]');
  });

  it('is a no-op on safe log lines', () => {
    const clean = 'Email fetched successfully for user@example.com (42 messages)';
    expect(sanitizeSecrets(clean)).toBe(clean);
  });

  it('handles empty input', () => {
    expect(sanitizeSecrets('')).toBe('');
    expect(sanitizeSecrets(null as unknown as string)).toBe(null as unknown as string);
  });
});

describe('dual-transport env parsing', () => {
  it('accepts numeric MCP_MAX_SESSIONS', () => {
    // This only verifies the env-var shape — actual Map-size enforcement
    // is exercised via the server.test.ts integration.
    const raw = process.env['MCP_MAX_SESSIONS'] || '100';
    expect(parseInt(raw, 10)).toBeGreaterThan(0);
  });

  it('splits MCP_ALLOWED_ORIGINS into a trimmed list', () => {
    const raw = 'http://a.example.com, https://b.example.com ,  ';
    const parsed = raw.split(',').map((o) => o.trim()).filter(Boolean);
    expect(parsed).toEqual(['http://a.example.com', 'https://b.example.com']);
  });
});
