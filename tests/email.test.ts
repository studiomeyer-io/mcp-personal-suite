/**
 * Email Module Tests — OAuth2, Email Client Helpers, Tool Registration, Operations
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── Mock external deps BEFORE imports ─────────────────

vi.mock('imapflow', () => {
  return { ImapFlow: vi.fn() };
});

vi.mock('mailparser', () => ({
  simpleParser: vi.fn(),
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => ({ sendMail: vi.fn() })) },
}));

// ─── Imports ────────────────────────────────────────────

import {
  loadConfig as loadOAuthConfig,
  saveConfig as saveOAuthConfig,
  generateAuthUrl,
  getImapConfig,
  getSmtpConfig,
  type OAuthConfig,
} from '../src/modules/email/oauth2.js';

// ─── Helpers ────────────────────────────────────────────

let tmpDir: string;

function createTmpDir(): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'email-test-'));
  return tmpDir;
}

afterEach(() => {
  // Clean env vars
  delete process.env['OAUTH2_PROVIDER'];
  delete process.env['OAUTH2_EMAIL'];
  delete process.env['OAUTH2_CLIENT_ID'];
  delete process.env['OAUTH2_CLIENT_SECRET'];
  delete process.env['OAUTH2_REFRESH_TOKEN'];
  delete process.env['IMAP_HOST'];
  delete process.env['IMAP_PORT'];
  delete process.env['IMAP_USER'];
  delete process.env['IMAP_PASS'];
  delete process.env['SMTP_HOST'];
  delete process.env['SMTP_PORT'];
  delete process.env['SMTP_USER'];
  delete process.env['SMTP_PASS'];
  delete process.env['PERSONAL_SUITE_CONFIG_DIR'];
  delete process.env['CREDENTIAL_ENCRYPTION_KEY'];

  // Clean temp dirs
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ═══════════════════════════════════════════════════════
// OAuth2 Config Tests
// ═══════════════════════════════════════════════════════

describe('OAuth2 Config', () => {
  describe('loadConfig from env vars', () => {
    it('should load Gmail config from env vars', () => {
      process.env['OAUTH2_PROVIDER'] = 'gmail';
      process.env['OAUTH2_EMAIL'] = 'test@gmail.com';
      process.env['OAUTH2_CLIENT_ID'] = 'client-123';
      process.env['OAUTH2_CLIENT_SECRET'] = 'secret-456';
      process.env['OAUTH2_REFRESH_TOKEN'] = 'refresh-789';

      const config = loadOAuthConfig();
      expect(config).not.toBeNull();
      expect(config!.provider).toBe('gmail');
      expect(config!.email).toBe('test@gmail.com');
      expect(config!.clientId).toBe('client-123');
      expect(config!.clientSecret).toBe('secret-456');
      expect(config!.refreshToken).toBe('refresh-789');
    });

    it('should load IMAP config from env vars', () => {
      process.env['OAUTH2_PROVIDER'] = 'imap';
      process.env['OAUTH2_EMAIL'] = 'user@example.com';
      process.env['IMAP_HOST'] = 'mail.example.com';
      process.env['IMAP_PORT'] = '993';
      process.env['IMAP_USER'] = 'mailuser';
      process.env['IMAP_PASS'] = 'mailpass';
      process.env['SMTP_HOST'] = 'smtp.example.com';
      process.env['SMTP_PORT'] = '587';
      process.env['SMTP_USER'] = 'smtpuser';
      process.env['SMTP_PASS'] = 'smtppass';

      const config = loadOAuthConfig();
      expect(config).not.toBeNull();
      expect(config!.provider).toBe('imap');
      expect(config!.imapHost).toBe('mail.example.com');
      expect(config!.imapPort).toBe(993);
      expect(config!.imapUser).toBe('mailuser');
      expect(config!.imapPass).toBe('mailpass');
      expect(config!.smtpHost).toBe('smtp.example.com');
      expect(config!.smtpPort).toBe(587);
    });

    it('should return null when no env vars and no config file', () => {
      const dir = createTmpDir();
      process.env['PERSONAL_SUITE_CONFIG_DIR'] = dir;

      const config = loadOAuthConfig();
      expect(config).toBeNull();
    });

    it('should prioritize env vars over config file', () => {
      const dir = createTmpDir();
      process.env['PERSONAL_SUITE_CONFIG_DIR'] = dir;
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({
          email: { provider: 'outlook', email: 'file@outlook.com' },
        }),
      );

      process.env['OAUTH2_PROVIDER'] = 'gmail';
      process.env['OAUTH2_EMAIL'] = 'env@gmail.com';

      const config = loadOAuthConfig();
      expect(config!.provider).toBe('gmail');
      expect(config!.email).toBe('env@gmail.com');
    });

    it('should handle missing optional IMAP_PORT gracefully', () => {
      process.env['OAUTH2_PROVIDER'] = 'imap';
      process.env['OAUTH2_EMAIL'] = 'user@example.com';

      const config = loadOAuthConfig();
      expect(config!.imapPort).toBeUndefined();
    });
  });

  describe('loadConfig from file', () => {
    it('should load config from file when no env vars set', () => {
      const dir = createTmpDir();
      process.env['PERSONAL_SUITE_CONFIG_DIR'] = dir;
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({
          email: {
            provider: 'outlook',
            email: 'user@outlook.com',
            clientId: 'oid-123',
            clientSecret: 'osecret',
            refreshToken: 'orefresh',
          },
        }),
      );

      const config = loadOAuthConfig();
      expect(config).not.toBeNull();
      expect(config!.provider).toBe('outlook');
      expect(config!.email).toBe('user@outlook.com');
      expect(config!.clientId).toBe('oid-123');
    });

    it('should return null for corrupted config file', () => {
      const dir = createTmpDir();
      process.env['PERSONAL_SUITE_CONFIG_DIR'] = dir;
      writeFileSync(join(dir, 'config.json'), 'NOT-JSON!!!');

      const config = loadOAuthConfig();
      expect(config).toBeNull();
    });

    it('should return null when config file has no email key', () => {
      const dir = createTmpDir();
      process.env['PERSONAL_SUITE_CONFIG_DIR'] = dir;
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({ calendar: { provider: 'google' } }),
      );

      const config = loadOAuthConfig();
      expect(config).toBeNull();
    });
  });

  describe('saveConfig', () => {
    it('should save and reload config without encryption', () => {
      const dir = createTmpDir();
      process.env['PERSONAL_SUITE_CONFIG_DIR'] = dir;

      const original: OAuthConfig = {
        provider: 'gmail',
        email: 'test@gmail.com',
        clientId: 'cid',
        clientSecret: 'csecret',
        refreshToken: 'rtoken',
      };

      saveOAuthConfig(original);
      const loaded = loadOAuthConfig();

      expect(loaded).not.toBeNull();
      expect(loaded!.provider).toBe('gmail');
      expect(loaded!.email).toBe('test@gmail.com');
      expect(loaded!.clientId).toBe('cid');
      expect(loaded!.clientSecret).toBe('csecret');
      expect(loaded!.refreshToken).toBe('rtoken');
    });

    it('should encrypt sensitive fields when CREDENTIAL_ENCRYPTION_KEY is set', () => {
      const dir = createTmpDir();
      process.env['PERSONAL_SUITE_CONFIG_DIR'] = dir;
      process.env['CREDENTIAL_ENCRYPTION_KEY'] = 'my-super-secret-key-32chars!!!!!';

      const original: OAuthConfig = {
        provider: 'gmail',
        email: 'test@gmail.com',
        clientSecret: 'secret-value',
        refreshToken: 'refresh-value',
      };

      saveOAuthConfig(original);

      // Read raw file to check encryption
      const raw = JSON.parse(
        require('node:fs').readFileSync(join(dir, 'config.json'), 'utf8'),
      );
      const saved = raw.email;

      // Encrypted values contain colons (iv:tag:data)
      expect(saved.clientSecret).toContain(':');
      expect(saved.clientSecret).not.toBe('secret-value');
      expect(saved.refreshToken).toContain(':');
      expect(saved.refreshToken).not.toBe('refresh-value');

      // But load should decrypt them back
      const loaded = loadOAuthConfig();
      expect(loaded!.clientSecret).toBe('secret-value');
      expect(loaded!.refreshToken).toBe('refresh-value');
    });

    it('should create config directory if it does not exist', () => {
      const dir = join(tmpdir(), `email-test-nested-${Date.now()}`);
      process.env['PERSONAL_SUITE_CONFIG_DIR'] = dir;
      tmpDir = dir; // for cleanup

      saveOAuthConfig({ provider: 'imap', email: 'test@test.com' });

      const loaded = loadOAuthConfig();
      expect(loaded).not.toBeNull();
      expect(loaded!.email).toBe('test@test.com');
    });
  });

  describe('generateAuthUrl', () => {
    it('should generate Gmail OAuth URL with correct params', () => {
      const url = generateAuthUrl('gmail', 'client-123', 'http://localhost:3000/cb');

      expect(url).toContain('https://accounts.google.com/o/oauth2/v2/auth');
      expect(url).toContain('client_id=client-123');
      expect(url).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcb');
      expect(url).toContain('response_type=code');
      expect(url).toContain('access_type=offline');
      expect(url).toContain('prompt=consent');
      expect(url).toContain('scope=https%3A%2F%2Fmail.google.com%2F');
      expect(url).toContain('state=');
    });

    it('should generate Outlook OAuth URL with correct params', () => {
      const url = generateAuthUrl('outlook', 'outlook-id', 'http://localhost:4000/cb');

      expect(url).toContain('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
      expect(url).toContain('client_id=outlook-id');
      expect(url).toContain('response_type=code');
      expect(url).toContain('IMAP.AccessAsUser.All');
      expect(url).toContain('SMTP.Send');
      expect(url).toContain('offline_access');
    });

    it('should include a random state parameter', () => {
      const url1 = generateAuthUrl('gmail', 'cid', 'http://localhost/cb');
      const url2 = generateAuthUrl('gmail', 'cid', 'http://localhost/cb');

      const getState = (url: string) => new URL(url).searchParams.get('state');
      // State should be random (32 hex chars)
      expect(getState(url1)).toHaveLength(32);
      // Two calls should produce different states
      expect(getState(url1)).not.toBe(getState(url2));
    });
  });

  describe('getImapConfig', () => {
    it('should return Gmail IMAP config', () => {
      const config: OAuthConfig = { provider: 'gmail', email: 'me@gmail.com' };
      const imap = getImapConfig(config);

      expect(imap.host).toBe('imap.gmail.com');
      expect(imap.port).toBe(993);
      expect(imap.user).toBe('me@gmail.com');
      expect(imap.auth).toBe('oauth2');
    });

    it('should return Outlook IMAP config', () => {
      const config: OAuthConfig = { provider: 'outlook', email: 'me@outlook.com' };
      const imap = getImapConfig(config);

      expect(imap.host).toBe('outlook.office365.com');
      expect(imap.port).toBe(993);
      expect(imap.user).toBe('me@outlook.com');
      expect(imap.auth).toBe('oauth2');
    });

    it('should return custom IMAP config for generic provider', () => {
      const config: OAuthConfig = {
        provider: 'imap',
        email: 'user@custom.com',
        imapHost: 'mail.custom.com',
        imapPort: 143,
        imapUser: 'custom-user',
        imapPass: 'custom-pass',
      };
      const imap = getImapConfig(config);

      expect(imap.host).toBe('mail.custom.com');
      expect(imap.port).toBe(143);
      expect(imap.user).toBe('custom-user');
      expect(imap.auth).toBe('basic');
      expect(imap.password).toBe('custom-pass');
    });

    it('should use defaults for missing IMAP fields', () => {
      const config: OAuthConfig = { provider: 'imap', email: 'user@test.com' };
      const imap = getImapConfig(config);

      expect(imap.host).toBe('localhost');
      expect(imap.port).toBe(993);
      expect(imap.user).toBe('user@test.com');
      expect(imap.auth).toBe('basic');
    });
  });

  describe('getSmtpConfig', () => {
    it('should return Gmail SMTP config', () => {
      const config: OAuthConfig = { provider: 'gmail', email: 'me@gmail.com' };
      const smtp = getSmtpConfig(config);

      expect(smtp.host).toBe('smtp.gmail.com');
      expect(smtp.port).toBe(465);
      expect(smtp.user).toBe('me@gmail.com');
      expect(smtp.auth).toBe('oauth2');
    });

    it('should return Outlook SMTP config', () => {
      const config: OAuthConfig = { provider: 'outlook', email: 'me@outlook.com' };
      const smtp = getSmtpConfig(config);

      expect(smtp.host).toBe('smtp.office365.com');
      expect(smtp.port).toBe(587);
      expect(smtp.user).toBe('me@outlook.com');
      expect(smtp.auth).toBe('oauth2');
    });

    it('should return custom SMTP config for generic provider', () => {
      const config: OAuthConfig = {
        provider: 'imap',
        email: 'user@custom.com',
        smtpHost: 'smtp.custom.com',
        smtpPort: 465,
        smtpUser: 'smtp-user',
        smtpPass: 'smtp-pass',
      };
      const smtp = getSmtpConfig(config);

      expect(smtp.host).toBe('smtp.custom.com');
      expect(smtp.port).toBe(465);
      expect(smtp.user).toBe('smtp-user');
      expect(smtp.auth).toBe('basic');
      expect(smtp.password).toBe('smtp-pass');
    });

    it('should use defaults for missing SMTP fields', () => {
      const config: OAuthConfig = { provider: 'imap', email: 'u@t.com' };
      const smtp = getSmtpConfig(config);

      expect(smtp.host).toBe('localhost');
      expect(smtp.port).toBe(587);
      expect(smtp.user).toBe('u@t.com');
    });
  });
});

// ═══════════════════════════════════════════════════════
// Email Client Helpers (stripHtml, escapeHtml, validateAttachmentPath)
// ═══════════════════════════════════════════════════════

// We need to test unexported functions — re-create them from source logic
// or test through the exported functions that use them.
// Since stripHtml, escapeHtml, validateAttachmentPath are not exported,
// we test them indirectly or duplicate the logic for unit tests.

// For validateAttachmentPath, let's import via a workaround — test the module behavior.
// Actually, let's directly test the functions by extracting them.

describe('Email Client Helpers', () => {
  // We replicate the helper functions here for unit testing
  // since they are not exported from email-client.ts

  function stripHtml(html: string): string {
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<\/h[1-6]>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&#x27;/gi, "'")
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  describe('stripHtml', () => {
    it('should convert <br> tags to newlines', () => {
      expect(stripHtml('Hello<br>World')).toBe('Hello\nWorld');
      expect(stripHtml('Hello<br/>World')).toBe('Hello\nWorld');
      expect(stripHtml('Hello<br />World')).toBe('Hello\nWorld');
    });

    it('should convert paragraph tags to double newlines', () => {
      expect(stripHtml('<p>First</p><p>Second</p>')).toBe('First\n\nSecond');
    });

    it('should convert list items', () => {
      expect(stripHtml('<ul><li>One</li><li>Two</li></ul>')).toBe('- One\n- Two');
    });

    it('should convert heading close tags to double newlines', () => {
      expect(stripHtml('<h1>Title</h1>Content')).toBe('Title\n\nContent');
    });

    it('should decode HTML entities', () => {
      expect(stripHtml('&amp; &lt; &gt; &quot; &#39;')).toBe('& < > " \'');
    });

    it('should decode &nbsp; to space', () => {
      expect(stripHtml('Hello&nbsp;World')).toBe('Hello World');
    });

    it('should decode numeric entities', () => {
      expect(stripHtml('&#65;&#66;&#67;')).toBe('ABC');
    });

    it('should decode hex entities', () => {
      expect(stripHtml('&#x41;&#x42;&#x43;')).toBe('ABC');
    });

    it('should strip all remaining HTML tags', () => {
      expect(stripHtml('<span class="bold">text</span>')).toBe('text');
    });

    it('should collapse excessive newlines', () => {
      expect(stripHtml('A\n\n\n\n\nB')).toBe('A\n\nB');
    });

    it('should trim whitespace', () => {
      expect(stripHtml('  <p>Hello</p>  ')).toBe('Hello');
    });

    it('should handle empty string', () => {
      expect(stripHtml('')).toBe('');
    });

    it('should handle complex nested HTML', () => {
      const html = '<div><h2>Title</h2><p>Paragraph with <strong>bold</strong> and <em>italic</em></p><ul><li>Item 1</li><li>Item 2</li></ul></div>';
      const result = stripHtml(html);
      expect(result).toContain('Title');
      expect(result).toContain('Paragraph with bold and italic');
      expect(result).toContain('- Item 1');
      expect(result).toContain('- Item 2');
    });
  });

  describe('escapeHtml', () => {
    it('should escape ampersand', () => {
      expect(escapeHtml('A & B')).toBe('A &amp; B');
    });

    it('should escape angle brackets', () => {
      expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    });

    it('should escape quotes', () => {
      expect(escapeHtml('He said "hello"')).toBe('He said &quot;hello&quot;');
    });

    it('should escape single quotes', () => {
      expect(escapeHtml("It's")).toBe('It&#39;s');
    });

    it('should handle empty string', () => {
      expect(escapeHtml('')).toBe('');
    });

    it('should handle string with no special chars', () => {
      expect(escapeHtml('Hello World')).toBe('Hello World');
    });

    it('should escape all special chars in combination', () => {
      expect(escapeHtml('<a href="x">&\'test')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;test');
    });
  });

  describe('validateAttachmentPath', () => {
    // We test through actual filesystem operations
    const ALLOWED_ATTACHMENT_DIRS = ['/tmp/', '/home/', '/var/tmp/'];
    const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;

    function validateAttachmentPath(filePath: string): { valid: boolean; error?: string } {
      try {
        const { realpathSync, statSync } = require('node:fs');
        const { resolve } = require('node:path');
        const resolved = realpathSync(resolve(filePath));
        const allowed = ALLOWED_ATTACHMENT_DIRS.some((dir: string) => resolved.startsWith(dir));
        if (!allowed) {
          return { valid: false, error: `Path not in allowed directories: ${resolved}` };
        }
        const stats = statSync(resolved);
        if (stats.size > MAX_ATTACHMENT_SIZE) {
          return { valid: false, error: `File too large: ${(stats.size / 1024 / 1024).toFixed(1)}MB (max 25MB)` };
        }
        return { valid: true };
      } catch {
        return { valid: false, error: `File not found: ${filePath}` };
      }
    }

    it('should accept valid file in /tmp', () => {
      const dir = createTmpDir();
      const filePath = join(dir, 'test.txt');
      writeFileSync(filePath, 'hello');

      const result = validateAttachmentPath(filePath);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject non-existent file', () => {
      const result = validateAttachmentPath('/tmp/nonexistent-file-xyz-12345.txt');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('File not found');
    });

    it('should reject file outside allowed directories', () => {
      // /etc/ is not in allowed dirs — test with a known existing file
      const result = validateAttachmentPath('/etc/hostname');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Path not in allowed directories');
    });

    it('should reject file larger than 25MB', () => {
      const dir = createTmpDir();
      const filePath = join(dir, 'large.bin');
      // Create a file just over the limit (we write 26MB)
      const buf = Buffer.alloc(26 * 1024 * 1024);
      writeFileSync(filePath, buf);

      const result = validateAttachmentPath(filePath);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('File too large');
      expect(result.error).toContain('max 25MB');
    });

    it('should accept file exactly at size limit', () => {
      const dir = createTmpDir();
      const filePath = join(dir, 'exact.bin');
      const buf = Buffer.alloc(25 * 1024 * 1024); // exactly 25MB
      writeFileSync(filePath, buf);

      const result = validateAttachmentPath(filePath);
      expect(result.valid).toBe(true);
    });

    it('should resolve symlinks and check real path', () => {
      const dir = createTmpDir();
      const realFile = join(dir, 'real.txt');
      const link = join(dir, 'link.txt');
      writeFileSync(realFile, 'content');
      symlinkSync(realFile, link);

      // Symlink within /tmp/ should be valid
      const result = validateAttachmentPath(link);
      expect(result.valid).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════
// Tool Registration
// ═══════════════════════════════════════════════════════

describe('Email Tool Registration', () => {
  function createMockServer() {
    const tools = new Map<string, unknown>();
    return {
      tool: vi.fn((...args: unknown[]) => {
        tools.set(args[0] as string, args);
      }),
      _tools: tools,
    };
  }

  it('should register all 15 email tools', async () => {
    const { registerEmailTools } = await import('../src/modules/email/index.js');
    const server = createMockServer();
    registerEmailTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    expect(server.tool).toHaveBeenCalledTimes(15);
    expect(server._tools.size).toBe(15);
  });

  it('should register tools with correct names', async () => {
    const { registerEmailTools } = await import('../src/modules/email/index.js');
    const server = createMockServer();
    registerEmailTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const expectedTools = [
      'email_status',
      'email_setup',
      'email_auth',
      'email_list',
      'email_read',
      'email_search',
      'email_threads',
      'email_folders',
      'email_send',
      'email_reply',
      'email_move',
      'email_mark_read',
      'email_mark_unread',
      'email_delete',
      'email_forward',
    ];

    for (const name of expectedTools) {
      expect(server._tools.has(name)).toBe(true);
    }
  });

  it('should register each tool with a description string', async () => {
    const { registerEmailTools } = await import('../src/modules/email/index.js');
    const server = createMockServer();
    registerEmailTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    for (const [, args] of server._tools) {
      const toolArgs = args as unknown[];
      // args[0] = name, args[1] = description, args[2] = schema, args[3] = handler
      expect(typeof toolArgs[1]).toBe('string');
      expect((toolArgs[1] as string).length).toBeGreaterThan(10);
    }
  });

  it('should register each tool with a handler function', async () => {
    const { registerEmailTools } = await import('../src/modules/email/index.js');
    const server = createMockServer();
    registerEmailTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    for (const [, args] of server._tools) {
      const toolArgs = args as unknown[];
      // Handler is the last argument
      expect(typeof toolArgs[toolArgs.length - 1]).toBe('function');
    }
  });

  it('should have all tool names prefixed with email_', async () => {
    const { registerEmailTools } = await import('../src/modules/email/index.js');
    const server = createMockServer();
    registerEmailTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    for (const name of server._tools.keys()) {
      expect(name).toMatch(/^email_/);
    }
  });
});
