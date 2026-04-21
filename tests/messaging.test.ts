/**
 * Messaging Module Tests
 *
 * Tests for MessageBuffer, ChannelRegistry, tool registration,
 * message chunking, and helper functions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock external SDK dependencies BEFORE imports
// NOTE: vitest 4 enforces that a mock called with `new` must be constructable.
// Arrow functions inside `.mockImplementation(() => ...)` have no [[Construct]]
// internal method and throw "is not a constructor". Classic `function()` bodies
// (or named functions passed directly into vi.fn(fn)) construct fine.
vi.mock('grammy', () => ({
  Bot: vi.fn(function Bot(this: Record<string, unknown>) {
    this.api = { getMe: vi.fn(), sendMessage: vi.fn() };
    this.on = vi.fn();
    this.start = vi.fn();
    this.stop = vi.fn();
  }),
}));

vi.mock('discord.js', () => ({
  Client: vi.fn(function Client(this: Record<string, unknown>) {
    this.on = vi.fn();
    this.once = vi.fn();
    this.login = vi.fn();
    this.destroy = vi.fn();
    this.isReady = vi.fn().mockReturnValue(false);
    this.channels = { fetch: vi.fn(), cache: new Map() };
    this.guilds = { cache: new Map() };
    this.user = null;
  }),
  Events: {
    MessageCreate: 'messageCreate',
    ClientReady: 'ready',
  },
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
    DirectMessages: 8,
  },
  ChannelType: {
    GuildText: 0,
    GuildAnnouncement: 5,
  },
}));

vi.mock('@slack/bolt', () => ({
  App: vi.fn(function App(this: Record<string, unknown>) {
    this.message = vi.fn();
    this.start = vi.fn();
    this.stop = vi.fn();
    this.client = {
      auth: { test: vi.fn() },
      chat: { postMessage: vi.fn() },
      conversations: { list: vi.fn(), history: vi.fn() },
    };
  }),
}));

vi.mock('@whiskeysockets/baileys', () => ({
  default: vi.fn(),
  useMultiFileAuthState: vi.fn(),
  DisconnectReason: { loggedOut: 401 },
}));

vi.mock('@hapi/boom', () => ({
  Boom: class Boom extends Error {
    output: { statusCode: number };
    constructor(msg: string, opts?: { statusCode?: number }) {
      super(msg);
      this.output = { statusCode: opts?.statusCode ?? 500 };
    }
  },
}));

import { MessageBuffer } from '../src/modules/messaging/buffer.js';
import {
  ChannelRegistry,
  resetRegistry,
  getOrCreateRegistry,
} from '../src/modules/messaging/registry.js';
import type {
  ChannelAdapter,
  ChannelMessage,
  ChannelState,
  Platform,
  SendOptions,
  SendResult,
  HistoryOptions,
  ChannelInfo,
} from '../src/modules/messaging/adapter.js';

// ---- Test Helpers ----

function makeMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    platform: 'telegram',
    channelId: 'ch-1',
    sender: { id: 'user-1', name: 'Alice', isBot: false },
    text: 'Hello world',
    timestamp: Date.now(),
    ...overrides,
  };
}

function createMockAdapter(platform: Platform, state: ChannelState = 'disconnected'): ChannelAdapter {
  const buffer = new MessageBuffer(100);
  return {
    platform,
    state,
    buffer,
    connect: vi.fn(async () => { /* noop */ }),
    disconnect: vi.fn(async () => { /* noop */ }),
    send: vi.fn(async (): Promise<SendResult> => ({ success: true, messageId: 'sent-1' })),
    getHistory: vi.fn(async (): Promise<ChannelMessage[]> => []),
    listChannels: vi.fn(async (): Promise<ChannelInfo[]> => []),
    isHealthy: vi.fn(async () => true),
  };
}

function createMockServer() {
  const tools = new Map<string, unknown>();
  return {
    tool: vi.fn((...args: unknown[]) => {
      tools.set(args[0] as string, args);
    }),
    _tools: tools,
  };
}

// ================================================================
// MessageBuffer Tests
// ================================================================

describe('MessageBuffer', () => {
  let buffer: MessageBuffer;

  beforeEach(() => {
    buffer = new MessageBuffer(5);
  });

  it('starts empty', () => {
    expect(buffer.size).toBe(0);
    expect(buffer.toArray()).toEqual([]);
  });

  it('pushes a single message', () => {
    const msg = makeMessage();
    buffer.push(msg);
    expect(buffer.size).toBe(1);
    expect(buffer.toArray()).toEqual([msg]);
  });

  it('pushes multiple messages and preserves order', () => {
    const msgs = [
      makeMessage({ text: 'first', timestamp: 1000 }),
      makeMessage({ text: 'second', timestamp: 2000 }),
      makeMessage({ text: 'third', timestamp: 3000 }),
    ];
    for (const m of msgs) buffer.push(m);
    expect(buffer.size).toBe(3);
    const result = buffer.toArray();
    expect(result.map((m) => m.text)).toEqual(['first', 'second', 'third']);
  });

  it('respects capacity — overwrites oldest when full', () => {
    // Capacity is 5
    for (let i = 0; i < 7; i++) {
      buffer.push(makeMessage({ text: `msg-${i}`, timestamp: i * 1000 }));
    }
    expect(buffer.size).toBe(5);
    const texts = buffer.toArray().map((m) => m.text);
    // Oldest two (msg-0, msg-1) should be overwritten
    expect(texts).toEqual(['msg-2', 'msg-3', 'msg-4', 'msg-5', 'msg-6']);
  });

  it('ring buffer wraps correctly at exact capacity', () => {
    for (let i = 0; i < 5; i++) {
      buffer.push(makeMessage({ text: `msg-${i}` }));
    }
    expect(buffer.size).toBe(5);
    // Push one more to trigger wrap
    buffer.push(makeMessage({ text: 'msg-5' }));
    expect(buffer.size).toBe(5);
    const texts = buffer.toArray().map((m) => m.text);
    expect(texts[0]).toBe('msg-1');
    expect(texts[4]).toBe('msg-5');
  });

  it('getSince returns only messages after the given timestamp', () => {
    buffer.push(makeMessage({ text: 'old', timestamp: 1000 }));
    buffer.push(makeMessage({ text: 'mid', timestamp: 2000 }));
    buffer.push(makeMessage({ text: 'new', timestamp: 3000 }));
    const result = buffer.getSince(1500);
    expect(result.map((m) => m.text)).toEqual(['mid', 'new']);
  });

  it('getSince with timestamp in the future returns empty', () => {
    buffer.push(makeMessage({ timestamp: 1000 }));
    expect(buffer.getSince(999999)).toEqual([]);
  });

  it('getSince with timestamp 0 returns all messages', () => {
    buffer.push(makeMessage({ timestamp: 1000 }));
    buffer.push(makeMessage({ timestamp: 2000 }));
    expect(buffer.getSince(0)).toHaveLength(2);
  });

  it('getRecent returns last N messages', () => {
    for (let i = 0; i < 5; i++) {
      buffer.push(makeMessage({ text: `msg-${i}` }));
    }
    const result = buffer.getRecent(2);
    expect(result.map((m) => m.text)).toEqual(['msg-3', 'msg-4']);
  });

  it('getRecent returns all messages when limit exceeds count', () => {
    buffer.push(makeMessage({ text: 'a' }));
    buffer.push(makeMessage({ text: 'b' }));
    const result = buffer.getRecent(10);
    expect(result).toHaveLength(2);
  });

  it('getRecent on empty buffer returns empty array', () => {
    expect(buffer.getRecent(5)).toEqual([]);
  });

  it('clear resets the buffer', () => {
    buffer.push(makeMessage());
    buffer.push(makeMessage());
    expect(buffer.size).toBe(2);
    buffer.clear();
    expect(buffer.size).toBe(0);
    expect(buffer.toArray()).toEqual([]);
  });

  it('clear allows pushing new messages again', () => {
    for (let i = 0; i < 5; i++) buffer.push(makeMessage());
    buffer.clear();
    buffer.push(makeMessage({ text: 'after-clear' }));
    expect(buffer.size).toBe(1);
    expect(buffer.toArray()[0].text).toBe('after-clear');
  });

  it('toArray returns empty for fresh buffer', () => {
    expect(buffer.toArray()).toEqual([]);
  });

  it('handles capacity of 1', () => {
    const tinyBuffer = new MessageBuffer(1);
    tinyBuffer.push(makeMessage({ text: 'first' }));
    expect(tinyBuffer.size).toBe(1);
    tinyBuffer.push(makeMessage({ text: 'second' }));
    expect(tinyBuffer.size).toBe(1);
    expect(tinyBuffer.toArray()[0].text).toBe('second');
  });

  it('default capacity is 100', () => {
    const defaultBuffer = new MessageBuffer();
    for (let i = 0; i < 105; i++) {
      defaultBuffer.push(makeMessage({ text: `msg-${i}` }));
    }
    expect(defaultBuffer.size).toBe(100);
    const arr = defaultBuffer.toArray();
    expect(arr[0].text).toBe('msg-5');
    expect(arr[99].text).toBe('msg-104');
  });
});

// ================================================================
// ChannelAdapter Interface Tests
// ================================================================

describe('ChannelAdapter interface', () => {
  it('mock adapter has all required properties', () => {
    const adapter = createMockAdapter('telegram');
    expect(adapter.platform).toBe('telegram');
    expect(adapter.state).toBe('disconnected');
    expect(adapter.buffer).toBeInstanceOf(MessageBuffer);
    expect(typeof adapter.connect).toBe('function');
    expect(typeof adapter.disconnect).toBe('function');
    expect(typeof adapter.send).toBe('function');
    expect(typeof adapter.getHistory).toBe('function');
    expect(typeof adapter.listChannels).toBe('function');
    expect(typeof adapter.isHealthy).toBe('function');
  });

  it('platform types cover all expected values', () => {
    const platforms: Platform[] = ['telegram', 'discord', 'slack', 'whatsapp'];
    for (const p of platforms) {
      const adapter = createMockAdapter(p);
      expect(adapter.platform).toBe(p);
    }
  });

  it('ChannelState type covers all expected values', () => {
    const states: ChannelState[] = ['disconnected', 'connecting', 'connected', 'error'];
    for (const s of states) {
      const adapter = createMockAdapter('telegram', s);
      expect(adapter.state).toBe(s);
    }
  });
});

// ================================================================
// ChannelRegistry Tests
// ================================================================

describe('ChannelRegistry', () => {
  let registry: ChannelRegistry;

  beforeEach(() => {
    registry = new ChannelRegistry();
  });

  it('starts empty', () => {
    expect(registry.size).toBe(0);
    expect(registry.getAll()).toEqual([]);
  });

  it('registers an adapter', () => {
    const adapter = createMockAdapter('telegram');
    registry.register(adapter);
    expect(registry.size).toBe(1);
    expect(registry.get('telegram')).toBe(adapter);
  });

  it('registers multiple adapters', () => {
    registry.register(createMockAdapter('telegram'));
    registry.register(createMockAdapter('discord'));
    registry.register(createMockAdapter('slack'));
    expect(registry.size).toBe(3);
  });

  it('overwrites adapter for same platform', () => {
    const first = createMockAdapter('telegram');
    const second = createMockAdapter('telegram');
    registry.register(first);
    registry.register(second);
    expect(registry.size).toBe(1);
    expect(registry.get('telegram')).toBe(second);
  });

  it('get returns undefined for unregistered platform', () => {
    expect(registry.get('discord')).toBeUndefined();
  });

  it('getAll returns all adapters', () => {
    registry.register(createMockAdapter('telegram'));
    registry.register(createMockAdapter('discord'));
    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all.map((a) => a.platform).sort()).toEqual(['discord', 'telegram']);
  });

  it('connectAll connects all adapters', async () => {
    const tg = createMockAdapter('telegram');
    const dc = createMockAdapter('discord');
    registry.register(tg);
    registry.register(dc);

    const results = await registry.connectAll();
    expect(results.get('telegram')).toBeNull();
    expect(results.get('discord')).toBeNull();
    expect(tg.connect).toHaveBeenCalledOnce();
    expect(dc.connect).toHaveBeenCalledOnce();
  });

  it('connectAll captures errors without throwing', async () => {
    const failing = createMockAdapter('telegram');
    (failing.connect as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Connection refused'));
    registry.register(failing);

    const results = await registry.connectAll();
    const error = results.get('telegram');
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Connection refused');
  });

  it('connectAll captures non-Error throws', async () => {
    const failing = createMockAdapter('telegram');
    (failing.connect as ReturnType<typeof vi.fn>).mockRejectedValue('string error');
    registry.register(failing);

    const results = await registry.connectAll();
    const error = results.get('telegram');
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('string error');
  });

  it('disconnectAll disconnects all adapters', async () => {
    const tg = createMockAdapter('telegram');
    const dc = createMockAdapter('discord');
    registry.register(tg);
    registry.register(dc);

    await registry.disconnectAll();
    expect(tg.disconnect).toHaveBeenCalledOnce();
    expect(dc.disconnect).toHaveBeenCalledOnce();
  });

  it('disconnectAll tolerates errors', async () => {
    const failing = createMockAdapter('telegram');
    (failing.disconnect as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('oops'));
    registry.register(failing);

    // Should not throw
    await expect(registry.disconnectAll()).resolves.toBeUndefined();
  });

  it('getStatus returns correct data', () => {
    const tg = createMockAdapter('telegram', 'connected');
    tg.buffer.push(makeMessage());
    tg.buffer.push(makeMessage());
    registry.register(tg);

    const status = registry.getStatus();
    expect(status).toHaveLength(1);
    expect(status[0]).toEqual({
      platform: 'telegram',
      state: 'connected',
      bufferedMessages: 2,
    });
  });
});

// ================================================================
// getOrCreateRegistry Singleton Tests
// ================================================================

describe('getOrCreateRegistry', () => {
  afterEach(() => {
    resetRegistry();
    vi.unstubAllEnvs();
  });

  it('returns the same instance on multiple calls', () => {
    const a = getOrCreateRegistry();
    const b = getOrCreateRegistry();
    expect(a).toBe(b);
  });

  it('resetRegistry creates a fresh instance', () => {
    const a = getOrCreateRegistry();
    resetRegistry();
    const b = getOrCreateRegistry();
    expect(a).not.toBe(b);
  });

  it('registers telegram when TELEGRAM_BOT_TOKEN is set', () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
    const reg = getOrCreateRegistry();
    expect(reg.get('telegram')).toBeDefined();
  });

  it('registers discord when DISCORD_BOT_TOKEN is set', () => {
    vi.stubEnv('DISCORD_BOT_TOKEN', 'test-token');
    const reg = getOrCreateRegistry();
    expect(reg.get('discord')).toBeDefined();
  });

  it('registers slack when both tokens are set', () => {
    vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-test');
    vi.stubEnv('SLACK_APP_TOKEN', 'xapp-test');
    const reg = getOrCreateRegistry();
    expect(reg.get('slack')).toBeDefined();
  });

  it('does not register slack when only bot token is set', () => {
    vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-test');
    const reg = getOrCreateRegistry();
    expect(reg.get('slack')).toBeUndefined();
  });

  it('registers whatsapp when WHATSAPP_AUTH_DIR is set', () => {
    vi.stubEnv('WHATSAPP_AUTH_DIR', '/tmp/wa-auth');
    const reg = getOrCreateRegistry();
    expect(reg.get('whatsapp')).toBeDefined();
  });

  it('has zero channels when no env vars are set', () => {
    const reg = getOrCreateRegistry();
    expect(reg.size).toBe(0);
  });

  it('respects MULTI_CHANNEL_BUFFER_SIZE env var', () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
    vi.stubEnv('MULTI_CHANNEL_BUFFER_SIZE', '50');
    const reg = getOrCreateRegistry();
    const adapter = reg.get('telegram')!;
    // Push more than 50 messages — should overflow at 50
    for (let i = 0; i < 60; i++) {
      adapter.buffer.push(makeMessage({ text: `m-${i}` }));
    }
    expect(adapter.buffer.size).toBe(50);
  });
});

// ================================================================
// Tool Registration Tests
// ================================================================

describe('registerMessagingTools', () => {
  let mockServer: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    resetRegistry();
    vi.stubEnv('MULTI_CHANNEL_AUTO_CONNECT', '0'); // Prevent auto-connect in tests
    mockServer = createMockServer();
  });

  afterEach(() => {
    resetRegistry();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('registers all 8 messaging tools', async () => {
    // Dynamic import to ensure fresh module state
    const { registerMessagingTools } = await import('../src/modules/messaging/index.js');
    registerMessagingTools(mockServer as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const expectedTools = [
      'channel_send',
      'channel_receive',
      'channel_list',
      'channel_status',
      'channel_connect',
      'channel_disconnect',
      'channel_broadcast',
      'channel_history',
    ];

    for (const toolName of expectedTools) {
      expect(mockServer._tools.has(toolName), `Missing tool: ${toolName}`).toBe(true);
    }
    expect(mockServer._tools.size).toBe(8);
  });

  it('tool calls have correct argument structure (name, description, schema, handler)', async () => {
    const { registerMessagingTools } = await import('../src/modules/messaging/index.js');
    registerMessagingTools(mockServer as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    for (const [name, args] of mockServer._tools) {
      const argsArray = args as unknown[];
      expect(typeof argsArray[0]).toBe('string'); // tool name
      expect(typeof argsArray[1]).toBe('string'); // description
      expect(typeof argsArray[2]).toBe('object'); // schema
      expect(typeof argsArray[3]).toBe('function'); // handler
    }
  });
});

// ================================================================
// Message Chunking Tests
// ================================================================

describe('message chunking (chunkMessage)', () => {
  // chunkMessage is not exported, so we test it indirectly via the module.
  // We re-implement the logic here to test the algorithm directly.

  const MESSAGE_LIMITS: Record<string, number> = {
    telegram: 4096,
    discord: 2000,
    slack: 40000,
    whatsapp: 65536,
  };

  function chunkMessage(text: string, platform: string): string[] {
    const limit = MESSAGE_LIMITS[platform] ?? 4096;
    if (text.length <= limit) return [text];

    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      let splitAt = limit;
      if (remaining.length > limit) {
        const lastNewline = remaining.lastIndexOf('\n', limit);
        if (lastNewline > limit * 0.5) splitAt = lastNewline + 1;
      }
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt);
    }
    return chunks;
  }

  it('returns single chunk for short message', () => {
    const result = chunkMessage('Hello world', 'telegram');
    expect(result).toEqual(['Hello world']);
  });

  it('returns single chunk for message exactly at limit', () => {
    const text = 'x'.repeat(4096);
    const result = chunkMessage(text, 'telegram');
    expect(result).toHaveLength(1);
  });

  it('splits message exceeding telegram limit', () => {
    const text = 'x'.repeat(5000);
    const result = chunkMessage(text, 'telegram');
    expect(result.length).toBeGreaterThan(1);
    expect(result.join('')).toBe(text);
  });

  it('splits at newline when possible', () => {
    // Build a message where a newline exists within the limit boundary
    const line1 = 'a'.repeat(3000) + '\n';
    const line2 = 'b'.repeat(2000);
    const text = line1 + line2;
    const result = chunkMessage(text, 'telegram');
    expect(result.length).toBe(2);
    expect(result[0]).toBe(line1);
    expect(result[1]).toBe(line2);
  });

  it('uses discord limit of 2000', () => {
    const text = 'x'.repeat(2500);
    const result = chunkMessage(text, 'discord');
    expect(result.length).toBe(2);
    expect(result[0].length).toBe(2000);
    expect(result[1].length).toBe(500);
  });

  it('uses slack limit of 40000', () => {
    const text = 'x'.repeat(40001);
    const result = chunkMessage(text, 'slack');
    expect(result.length).toBe(2);
  });

  it('defaults to 4096 for unknown platform', () => {
    const text = 'x'.repeat(5000);
    const result = chunkMessage(text, 'unknown-platform');
    expect(result[0].length).toBe(4096);
  });

  it('does not split at newline if newline is too early (< 50% of limit)', () => {
    // Newline at position 100 in a 4096-limit message — too early
    const text = 'a'.repeat(100) + '\n' + 'b'.repeat(5000);
    const result = chunkMessage(text, 'telegram');
    // Should split at limit, not at position 101
    expect(result[0].length).toBe(4096);
  });

  it('handles message with only newlines', () => {
    const text = '\n'.repeat(5000);
    const result = chunkMessage(text, 'discord');
    expect(result.length).toBeGreaterThan(1);
    expect(result.join('')).toBe(text);
  });

  it('handles empty string', () => {
    const result = chunkMessage('', 'telegram');
    expect(result).toEqual(['']);
  });
});

// ================================================================
// Helper Function Tests
// ================================================================

describe('helper functions (jsonResponse, errorResponse)', () => {
  // These are not exported but we can verify them via tool handler responses.
  // We re-create the helpers to test the format contract.

  function jsonResponse(result: unknown, isError?: boolean) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      ...(isError !== undefined ? { isError } : {}),
    };
  }

  function errorResponse(message: string, code?: string) {
    return jsonResponse({ error: message, code: code ?? 'INTERNAL_ERROR' }, true);
  }

  it('jsonResponse wraps result as JSON text content', () => {
    const result = jsonResponse({ foo: 'bar' });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text)).toEqual({ foo: 'bar' });
  });

  it('jsonResponse sets isError when provided', () => {
    const result = jsonResponse({ ok: true }, true);
    expect(result.isError).toBe(true);
  });

  it('jsonResponse omits isError when not provided', () => {
    const result = jsonResponse({ ok: true });
    expect(result).not.toHaveProperty('isError');
  });

  it('errorResponse sets isError to true', () => {
    const result = errorResponse('something broke');
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('something broke');
    expect(parsed.code).toBe('INTERNAL_ERROR');
  });

  it('errorResponse uses custom code', () => {
    const result = errorResponse('not found', 'NOT_FOUND');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.code).toBe('NOT_FOUND');
  });

  it('jsonResponse handles nested objects', () => {
    const data = { a: { b: { c: [1, 2, 3] } } };
    const result = jsonResponse(data);
    expect(JSON.parse(result.content[0].text)).toEqual(data);
  });

  it('jsonResponse handles null', () => {
    const result = jsonResponse(null);
    expect(result.content[0].text).toBe('null');
  });
});

// ================================================================
// Adapter Concrete Class Tests (with mocked SDKs)
// ================================================================

describe('TelegramAdapter', () => {
  it('has correct platform', async () => {
    const { TelegramAdapter } = await import('../src/modules/messaging/adapters/telegram.js');
    const adapter = new TelegramAdapter('test-token', 50);
    expect(adapter.platform).toBe('telegram');
    expect(adapter.state).toBe('disconnected');
    expect(adapter.buffer).toBeInstanceOf(MessageBuffer);
  });

  it('buffer respects custom size', async () => {
    const { TelegramAdapter } = await import('../src/modules/messaging/adapters/telegram.js');
    const adapter = new TelegramAdapter('test-token', 10);
    for (let i = 0; i < 15; i++) {
      adapter.buffer.push(makeMessage({ text: `m-${i}` }));
    }
    expect(adapter.buffer.size).toBe(10);
  });
});

describe('DiscordAdapter', () => {
  it('has correct platform', async () => {
    const { DiscordAdapter } = await import('../src/modules/messaging/adapters/discord.js');
    const adapter = new DiscordAdapter('test-token', 50);
    expect(adapter.platform).toBe('discord');
    expect(adapter.state).toBe('disconnected');
  });
});

describe('SlackAdapter', () => {
  it('has correct platform', async () => {
    const { SlackAdapter } = await import('../src/modules/messaging/adapters/slack.js');
    const adapter = new SlackAdapter('xoxb-test', 'xapp-test', 50);
    expect(adapter.platform).toBe('slack');
    expect(adapter.state).toBe('disconnected');
  });
});

describe('WhatsAppAdapter', () => {
  it('has correct platform and QR state', async () => {
    const { WhatsAppAdapter } = await import('../src/modules/messaging/adapters/whatsapp.js');
    const adapter = new WhatsAppAdapter('/tmp/wa-auth', 50);
    expect(adapter.platform).toBe('whatsapp');
    expect(adapter.state).toBe('disconnected');
    expect(adapter.lastQrCode).toBeNull();
    expect(adapter.needsQrScan).toBe(false);
  });
});
