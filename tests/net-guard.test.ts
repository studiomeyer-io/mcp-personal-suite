/**
 * net-guard tests (v0.5.6 SSRF hardening)
 *
 * Locks in the private-host detection shared by validateSearxngUrl (search)
 * and validateDownloadUrl (image). The regression these guard against is the
 * IPv6-mapped-IPv4 SSRF bypass: `[::ffff:169.254.169.254]` reaches the cloud
 * metadata endpoint but the old `/^169\.254\./` regex never matched the
 * normalised hostname `[::ffff:a9fe:a9fe]`.
 */

import { describe, it, expect } from 'vitest';
import { isPrivateHostname, isPrivateIpv4, extractIpv4 } from '../src/lib/net-guard.js';

// Helper: how each guard actually sees the host — through the WHATWG URL parser.
const host = (u: string) => new URL(u).hostname;

describe('extractIpv4', () => {
  it('returns dotted-quad unchanged', () => {
    expect(extractIpv4('127.0.0.1')).toBe('127.0.0.1');
    expect(extractIpv4('169.254.169.254')).toBe('169.254.169.254');
  });

  it('decodes IPv6-mapped IPv4 in dotted form', () => {
    expect(extractIpv4('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(extractIpv4('::127.0.0.1')).toBe('127.0.0.1');
  });

  it('decodes IPv6-mapped IPv4 in hex-group form (the bypass)', () => {
    // ::ffff:7f00:1  -> 127.0.0.1
    expect(extractIpv4('::ffff:7f00:1')).toBe('127.0.0.1');
    // ::ffff:a9fe:a9fe -> 169.254.169.254 (AWS metadata)
    expect(extractIpv4('::ffff:a9fe:a9fe')).toBe('169.254.169.254');
  });

  it('unwraps bracketed IPv6 hostnames', () => {
    expect(extractIpv4('[::ffff:a9fe:a9fe]')).toBe('169.254.169.254');
  });

  it('returns undefined for real DNS names and global IPv6', () => {
    expect(extractIpv4('example.com')).toBeUndefined();
    expect(extractIpv4('2606:4700:4700::1111')).toBeUndefined();
  });
});

describe('isPrivateIpv4', () => {
  it('flags loopback, RFC1918, link-local, CGNAT, multicast, this-host', () => {
    for (const ip of [
      '0.0.0.0', '127.0.0.1', '10.1.2.3', '172.16.5.5', '172.31.255.1',
      '192.168.0.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '240.0.0.1',
    ]) {
      expect(isPrivateIpv4(ip), ip).toBe(true);
    }
  });

  it('does not flag public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '172.15.0.1']) {
      expect(isPrivateIpv4(ip), ip).toBe(false);
    }
  });
});

describe('isPrivateHostname', () => {
  it('blocks loopback / internal hostnames', () => {
    for (const h of ['localhost', 'foo.localhost', 'svc.local', 'api.internal']) {
      expect(isPrivateHostname(h), h).toBe(true);
    }
  });

  it('blocks IPv4 private ranges as seen through the URL parser', () => {
    for (const u of [
      'http://10.0.0.1/', 'http://192.168.1.1/', 'http://172.16.0.1/',
      'http://169.254.169.254/', 'http://127.0.0.1/',
      // decimal/hex/octal — the URL parser normalises these to dotted-quad
      'http://2130706433/', 'http://0x7f000001/', 'http://127.1/',
    ]) {
      expect(isPrivateHostname(host(u)), u).toBe(true);
    }
  });

  it('blocks IPv6 loopback / ULA / link-local', () => {
    for (const u of ['http://[::1]/', 'http://[fc00::1]/', 'http://[fd12::1]/', 'http://[fe80::1]/']) {
      expect(isPrivateHostname(host(u)), u).toBe(true);
    }
  });

  it('blocks IPv6-mapped IPv4 (the SSRF-to-metadata bypass)', () => {
    expect(isPrivateHostname(host('https://[::ffff:127.0.0.1]/'))).toBe(true);
    expect(isPrivateHostname(host('https://[::ffff:169.254.169.254]/latest/meta-data'))).toBe(true);
    expect(isPrivateHostname(host('https://[::ffff:a9fe:a9fe]/'))).toBe(true);
  });

  it('allows legitimate public hosts', () => {
    for (const u of [
      'https://example.com/', 'https://api.openai.com/', 'https://8.8.8.8/',
      'https://[2606:4700:4700::1111]/',
    ]) {
      expect(isPrivateHostname(host(u)), u).toBe(false);
    }
  });
});
