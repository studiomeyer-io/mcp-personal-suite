import { describe, it, expect } from 'vitest';
import { discoverEmailSettings, formatDiscoveryResult } from '../src/modules/email/auto-discover.js';

describe('auto-discover', () => {
  // Well-known providers
  it('detects Gmail', async () => {
    const r = await discoverEmailSettings('user@gmail.com');
    expect(r.found).toBe(true);
    expect(r.settings?.provider).toBe('gmail');
    expect(r.settings?.imap.host).toBe('imap.gmail.com');
    expect(r.settings?.requiresOAuth).toBe(true);
    expect(r.method).toBe('well-known');
  });

  it('detects Outlook', async () => {
    const r = await discoverEmailSettings('user@outlook.com');
    expect(r.found).toBe(true);
    expect(r.settings?.provider).toBe('outlook');
    expect(r.settings?.imap.host).toBe('outlook.office365.com');
    expect(r.settings?.requiresOAuth).toBe(true);
  });

  it('detects Hotmail as Outlook', async () => {
    const r = await discoverEmailSettings('user@hotmail.com');
    expect(r.found).toBe(true);
    expect(r.settings?.provider).toBe('outlook');
  });

  it('detects Yahoo', async () => {
    const r = await discoverEmailSettings('user@yahoo.com');
    expect(r.found).toBe(true);
    expect(r.settings?.imap.host).toBe('imap.mail.yahoo.com');
    expect(r.settings?.requiresOAuth).toBe(false);
  });

  it('detects iCloud', async () => {
    const r = await discoverEmailSettings('user@icloud.com');
    expect(r.found).toBe(true);
    expect(r.settings?.imap.host).toBe('imap.mail.me.com');
  });

  // Deutsche Provider
  it('detects WEB.DE', async () => {
    const r = await discoverEmailSettings('user@web.de');
    expect(r.found).toBe(true);
    expect(r.settings?.displayName).toBe('WEB.DE');
    expect(r.settings?.imap.host).toBe('imap.web.de');
  });

  it('detects GMX', async () => {
    const r = await discoverEmailSettings('user@gmx.de');
    expect(r.found).toBe(true);
    expect(r.settings?.displayName).toBe('GMX');
  });

  it('detects T-Online', async () => {
    const r = await discoverEmailSettings('user@t-online.de');
    expect(r.found).toBe(true);
    expect(r.settings?.imap.host).toBe('secureimap.t-online.de');
  });

  it('detects mailbox.org', async () => {
    const r = await discoverEmailSettings('user@mailbox.org');
    expect(r.found).toBe(true);
    expect(r.settings?.displayName).toBe('mailbox.org');
  });

  it('detects Posteo', async () => {
    const r = await discoverEmailSettings('user@posteo.de');
    expect(r.found).toBe(true);
  });

  it('detects ProtonMail (Bridge)', async () => {
    const r = await discoverEmailSettings('user@protonmail.com');
    expect(r.found).toBe(true);
    expect(r.settings?.imap.host).toBe('127.0.0.1');
    expect(r.settings?.oauthNote).toContain('Bridge');
  });

  // Edge cases
  it('returns not found for invalid email', async () => {
    const r = await discoverEmailSettings('invalid');
    expect(r.found).toBe(false);
    expect(r.suggestions).toBeDefined();
  });

  it('returns suggestions for unknown domain', async () => {
    const r = await discoverEmailSettings('user@totally-unknown-domain-xyz123.com');
    expect(r.found).toBe(false);
    expect(r.suggestions?.length).toBeGreaterThan(0);
    expect(r.suggestions?.join('\n')).toContain('imap.totally-unknown-domain-xyz123.com');
  });

  it('is case-insensitive for domain', async () => {
    const r = await discoverEmailSettings('User@GMAIL.COM');
    expect(r.found).toBe(true);
    expect(r.settings?.provider).toBe('gmail');
  });

  // Format
  it('formats found result', async () => {
    const r = await discoverEmailSettings('user@web.de');
    const text = formatDiscoveryResult('user@web.de', r);
    expect(text).toContain('WEB.DE');
    expect(text).toContain('imap.web.de');
  });

  it('formats not-found result', async () => {
    const r = await discoverEmailSettings('user@xyz-unknown.de');
    const text = formatDiscoveryResult('user@xyz-unknown.de', r);
    expect(text).toContain('Could not auto-detect');
  });

  // Provider-specific notes
  it('Gmail has OAuth note', async () => {
    const r = await discoverEmailSettings('user@gmail.com');
    expect(r.settings?.oauthNote).toContain('OAuth2');
  });

  it('WEB.DE has IMAP activation note', async () => {
    const r = await discoverEmailSettings('user@web.de');
    expect(r.settings?.oauthNote).toContain('IMAP');
  });
});
