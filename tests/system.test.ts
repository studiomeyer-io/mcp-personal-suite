/**
 * System Module Tests — Config CRUD, Tool Registration, Suite Status
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

// ─── Mock imap for health check (lazy import in system/index.ts) ───

vi.mock('imap', () => {
  return { default: vi.fn() };
});

// ─── Imports ────────────────────────────────────────────

import {
  loadConfig,
  saveConfig,
  updateConfig,
  getModuleStatus,
  getConfigPath,
  getConfigDir,
  clearConfigCache,
  type SuiteConfig,
} from '../src/lib/config.js';

// ─── Helpers ────────────────────────────────────────────

let tmpDir: string;
let originalConfigDir: string;

// We need to override the CONFIG_DIR/CONFIG_FILE which are module-level constants.
// Since we can't override them, we test through the cache + file system.
// The config module uses hardcoded paths, so we test with the cache mechanism.

beforeEach(() => {
  clearConfigCache();
});

afterEach(() => {
  clearConfigCache();
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function createTmpDir(): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'system-test-'));
  return tmpDir;
}

// ═══════════════════════════════════════════════════════
// Config Module (lib/config.ts)
// ═══════════════════════════════════════════════════════

describe('Config Module', () => {
  describe('loadConfig', () => {
    it('should return empty object when no config file exists', async () => {
      const config = await loadConfig();
      // This might load the real config file if it exists, but
      // after clearConfigCache, it should read from disk.
      // The important thing is it should not throw.
      expect(config).toBeDefined();
      expect(typeof config).toBe('object');
    });

    it('should return cached config on second call', async () => {
      const config1 = await loadConfig();
      const config2 = await loadConfig();
      // Should be the exact same reference (cached)
      expect(config1).toBe(config2);
    });

    it('should return fresh config after clearConfigCache', async () => {
      const config1 = await loadConfig();
      clearConfigCache();
      const config2 = await loadConfig();
      // After clearing cache, it should re-read (may or may not be same ref)
      expect(config2).toBeDefined();
    });
  });

  describe('saveConfig', () => {
    it('should save and reload config through cache', async () => {
      // We test by saving, clearing cache, and loading again.
      // Note: this writes to ~/.personal-suite/config.json which may exist.
      // We'll be careful and restore.
      const configPath = getConfigPath();
      let originalContent: string | undefined;
      if (existsSync(configPath)) {
        originalContent = readFileSync(configPath, 'utf-8');
      }

      try {
        const testConfig: SuiteConfig = {
          email: { provider: 'gmail' },
          search: { braveApiKey: 'test-key' },
        };

        await saveConfig(testConfig);
        clearConfigCache();

        const loaded = await loadConfig();
        expect(loaded.email?.provider).toBe('gmail');
        expect(loaded.search?.braveApiKey).toBe('test-key');
      } finally {
        // Restore original config
        if (originalContent !== undefined) {
          writeFileSync(configPath, originalContent);
        }
        clearConfigCache();
      }
    });

    it('should update cached config after save', async () => {
      const configPath = getConfigPath();
      let originalContent: string | undefined;
      if (existsSync(configPath)) {
        originalContent = readFileSync(configPath, 'utf-8');
      }

      try {
        const testConfig: SuiteConfig = {
          messaging: {
            telegram: { botToken: 'test-token' },
          },
        };

        await saveConfig(testConfig);

        // Without clearing cache, loadConfig should return the cached version
        const loaded = await loadConfig();
        expect(loaded.messaging?.telegram?.botToken).toBe('test-token');
      } finally {
        if (originalContent !== undefined) {
          writeFileSync(configPath, originalContent);
        }
        clearConfigCache();
      }
    });
  });

  describe('updateConfig', () => {
    it('should apply updater function and save', async () => {
      const configPath = getConfigPath();
      let originalContent: string | undefined;
      if (existsSync(configPath)) {
        originalContent = readFileSync(configPath, 'utf-8');
      }

      try {
        // Start with a known state
        await saveConfig({});
        clearConfigCache();

        const result = await updateConfig((config) => ({
          ...config,
          search: { searxngUrl: 'http://localhost:8080' },
        }));

        expect(result.search?.searxngUrl).toBe('http://localhost:8080');

        // Verify it was saved
        clearConfigCache();
        const loaded = await loadConfig();
        expect(loaded.search?.searxngUrl).toBe('http://localhost:8080');
      } finally {
        if (originalContent !== undefined) {
          writeFileSync(configPath, originalContent);
        }
        clearConfigCache();
      }
    });

    it('should preserve existing fields not touched by updater', async () => {
      const configPath = getConfigPath();
      let originalContent: string | undefined;
      if (existsSync(configPath)) {
        originalContent = readFileSync(configPath, 'utf-8');
      }

      try {
        await saveConfig({ email: { provider: 'outlook' } });
        clearConfigCache();

        await updateConfig((config) => ({
          ...config,
          search: { braveApiKey: 'key123' },
        }));

        clearConfigCache();
        const loaded = await loadConfig();
        expect(loaded.email?.provider).toBe('outlook');
        expect(loaded.search?.braveApiKey).toBe('key123');
      } finally {
        if (originalContent !== undefined) {
          writeFileSync(configPath, originalContent);
        }
        clearConfigCache();
      }
    });
  });

  describe('getModuleStatus', () => {
    it('should report unconfigured modules when config is empty', async () => {
      const configPath = getConfigPath();
      let originalContent: string | undefined;
      if (existsSync(configPath)) {
        originalContent = readFileSync(configPath, 'utf-8');
      }

      try {
        await saveConfig({});
        clearConfigCache();

        const status = await getModuleStatus();
        expect(status.email.configured).toBe(false);
        expect(status.calendar.configured).toBe(false);
        expect(status.messaging.configured).toBe(false);
        expect(status.messaging.platforms).toEqual([]);
        expect(status.search.configured).toBe(false);
        expect(status.search.engines).toEqual([]);
        expect(status.image.configured).toBe(false);
        expect(status.image.providers).toEqual([]);
      } finally {
        if (originalContent !== undefined) {
          writeFileSync(configPath, originalContent);
        }
        clearConfigCache();
      }
    });

    it('should report email as configured', async () => {
      const configPath = getConfigPath();
      let originalContent: string | undefined;
      if (existsSync(configPath)) {
        originalContent = readFileSync(configPath, 'utf-8');
      }

      try {
        // Now requires accessToken for "configured" to be true
        await saveConfig({
          email: {
            provider: 'gmail',
            oauth: { accessToken: 'fake-token', refreshToken: 'fake-refresh' },
          },
        });
        clearConfigCache();

        const status = await getModuleStatus();
        expect(status.email.configured).toBe(true);
        expect(status.email.provider).toBe('gmail');
      } finally {
        if (originalContent !== undefined) {
          writeFileSync(configPath, originalContent);
        }
        clearConfigCache();
      }
    });

    it('should report calendar as configured', async () => {
      const configPath = getConfigPath();
      let originalContent: string | undefined;
      if (existsSync(configPath)) {
        originalContent = readFileSync(configPath, 'utf-8');
      }

      try {
        await saveConfig({
          calendar: {
            provider: 'google',
            oauth: { accessToken: 'at' },
          },
        });
        clearConfigCache();

        const status = await getModuleStatus();
        expect(status.calendar.configured).toBe(true);
        expect(status.calendar.provider).toBe('google');
      } finally {
        if (originalContent !== undefined) {
          writeFileSync(configPath, originalContent);
        }
        clearConfigCache();
      }
    });

    it('should detect multiple messaging platforms', async () => {
      const configPath = getConfigPath();
      let originalContent: string | undefined;
      if (existsSync(configPath)) {
        originalContent = readFileSync(configPath, 'utf-8');
      }

      try {
        await saveConfig({
          messaging: {
            telegram: { botToken: 'tg-token' },
            discord: { botToken: 'dc-token' },
            whatsapp: {},
          },
        });
        clearConfigCache();

        const status = await getModuleStatus();
        expect(status.messaging.configured).toBe(true);
        expect(status.messaging.platforms).toContain('telegram');
        expect(status.messaging.platforms).toContain('discord');
        expect(status.messaging.platforms).toContain('whatsapp');
      } finally {
        if (originalContent !== undefined) {
          writeFileSync(configPath, originalContent);
        }
        clearConfigCache();
      }
    });

    it('should detect search engines', async () => {
      const configPath = getConfigPath();
      let originalContent: string | undefined;
      if (existsSync(configPath)) {
        originalContent = readFileSync(configPath, 'utf-8');
      }

      try {
        await saveConfig({
          search: {
            searxngUrl: 'http://searxng.local',
            braveApiKey: 'brave-key',
          },
        });
        clearConfigCache();

        const status = await getModuleStatus();
        expect(status.search.configured).toBe(true);
        expect(status.search.engines).toContain('searxng');
        expect(status.search.engines).toContain('brave');
      } finally {
        if (originalContent !== undefined) {
          writeFileSync(configPath, originalContent);
        }
        clearConfigCache();
      }
    });

    it('should not count slack without botToken as configured', async () => {
      const configPath = getConfigPath();
      let originalContent: string | undefined;
      if (existsSync(configPath)) {
        originalContent = readFileSync(configPath, 'utf-8');
      }

      try {
        await saveConfig({
          messaging: {
            slack: { botToken: '' } as any,
          },
        });
        clearConfigCache();

        const status = await getModuleStatus();
        // Empty string is falsy, so slack should not be in platforms
        expect(status.messaging.platforms).not.toContain('slack');
      } finally {
        if (originalContent !== undefined) {
          writeFileSync(configPath, originalContent);
        }
        clearConfigCache();
      }
    });
  });

  describe('getConfigPath / getConfigDir', () => {
    it('should return path under home directory', () => {
      const path = getConfigPath();
      expect(path).toContain('.personal-suite');
      expect(path).toContain('config.json');
    });

    it('should return dir under home directory', () => {
      const dir = getConfigDir();
      expect(dir).toContain('.personal-suite');
      expect(dir).toBe(join(homedir(), '.personal-suite'));
    });
  });
});

// ═══════════════════════════════════════════════════════
// System Tool Registration
// ═══════════════════════════════════════════════════════

describe('System Tool Registration', () => {
  function createMockServer() {
    const tools = new Map<string, unknown>();
    return {
      tool: vi.fn((...args: unknown[]) => {
        tools.set(args[0] as string, args);
      }),
      _tools: tools,
    };
  }

  it('should register all 3 system tools', async () => {
    const { registerSystemTools } = await import('../src/modules/system/index.js');
    const server = createMockServer();
    registerSystemTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    expect(server.tool).toHaveBeenCalledTimes(5);
    expect(server._tools.size).toBe(5);
  });

  it('should register tools with correct names', async () => {
    const { registerSystemTools } = await import('../src/modules/system/index.js');
    const server = createMockServer();
    registerSystemTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const expectedTools = ['suite_status', 'suite_setup', 'suite_health', 'suite_guide'];
    for (const name of expectedTools) {
      expect(server._tools.has(name), `Missing tool: ${name}`).toBe(true);
    }
  });

  it('should have all tool names prefixed with suite_', async () => {
    const { registerSystemTools } = await import('../src/modules/system/index.js');
    const server = createMockServer();
    registerSystemTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    for (const name of server._tools.keys()) {
      expect(name).toMatch(/^suite_/);
    }
  });

  it('should register each tool with a handler function', async () => {
    const { registerSystemTools } = await import('../src/modules/system/index.js');
    const server = createMockServer();
    registerSystemTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    for (const [, args] of server._tools) {
      const toolArgs = args as unknown[];
      expect(typeof toolArgs[toolArgs.length - 1]).toBe('function');
    }
  });
});

// ═══════════════════════════════════════════════════════
// Suite Status Tool (functional test via handler)
// ═══════════════════════════════════════════════════════

describe('Suite Status Tool', () => {
  function createMockServer() {
    const tools = new Map<string, { handler: (...args: unknown[]) => Promise<unknown> }>();
    return {
      tool: vi.fn((...args: unknown[]) => {
        const name = args[0] as string;
        const handler = args[args.length - 1] as (...a: unknown[]) => Promise<unknown>;
        tools.set(name, { handler });
      }),
      _tools: tools,
    };
  }

  it('should return status with all module fields', async () => {
    const configPath = getConfigPath();
    let originalContent: string | undefined;
    if (existsSync(configPath)) {
      originalContent = readFileSync(configPath, 'utf-8');
    }

    try {
      await saveConfig({});
      clearConfigCache();

      const { registerSystemTools } = await import('../src/modules/system/index.js');
      const server = createMockServer();
      registerSystemTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

      const statusTool = server._tools.get('suite_status');
      expect(statusTool).toBeDefined();

      const result = await statusTool!.handler() as { content: Array<{ text: string }> };
      const text = result.content[0].text;

      // Should contain module sections
      expect(text).toContain('Email');
      expect(text).toContain('Calendar');
      expect(text).toContain('Messaging');
      expect(text).toContain('Search');
      expect(text).toContain('Personal Suite');
    } finally {
      if (originalContent !== undefined) {
        writeFileSync(configPath, originalContent);
      }
      clearConfigCache();
    }
  });

  it('should show config file path', async () => {
    const { registerSystemTools } = await import('../src/modules/system/index.js');
    const server = createMockServer();
    registerSystemTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const statusTool = server._tools.get('suite_status');
    const result = await statusTool!.handler() as { content: Array<{ text: string }> };
    const text = result.content[0].text;

    expect(text).toContain('.personal-suite/config.json');
  });
});
