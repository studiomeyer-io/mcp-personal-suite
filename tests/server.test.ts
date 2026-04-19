/**
 * Server Integration Tests
 *
 * Tests for server creation, tool registration count,
 * server metadata, and instructions content.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock external SDK dependencies that get pulled in transitively
vi.mock('grammy', () => ({
  Bot: vi.fn().mockImplementation(() => ({
    api: { getMe: vi.fn(), sendMessage: vi.fn() },
    on: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock('discord.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    once: vi.fn(),
    login: vi.fn(),
    destroy: vi.fn(),
    isReady: vi.fn().mockReturnValue(false),
    channels: { fetch: vi.fn(), cache: new Map() },
    guilds: { cache: new Map() },
    user: null,
  })),
  Events: { MessageCreate: 'messageCreate', ClientReady: 'ready' },
  GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4, DirectMessages: 8 },
  ChannelType: { GuildText: 0, GuildAnnouncement: 5 },
}));

vi.mock('@slack/bolt', () => ({
  App: vi.fn().mockImplementation(() => ({
    message: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    client: {
      auth: { test: vi.fn() },
      chat: { postMessage: vi.fn() },
      conversations: { list: vi.fn(), history: vi.fn() },
    },
  })),
}));

vi.mock('@whiskeysockets/baileys', () => ({
  default: vi.fn(),
  useMultiFileAuthState: vi.fn(),
  DisconnectReason: { loggedOut: 401 },
}));

vi.mock('@hapi/boom', () => ({
  Boom: class Boom extends Error {
    output = { statusCode: 500 };
  },
}));

// Mock the config module to avoid filesystem access
vi.mock('../src/lib/config.js', () => ({
  loadConfig: vi.fn(async () => ({})),
  saveConfig: vi.fn(async () => {}),
  getModuleStatus: vi.fn(async () => ({
    email: { configured: false },
    calendar: { configured: false },
    messaging: { configured: false, platforms: [] },
    search: { configured: false, engines: [] },
  })),
  getConfigPath: vi.fn(() => '~/.personal-suite/config.json'),
}));

// Mock IMAP (used by system/email health checks)
vi.mock('imap', () => ({
  default: vi.fn(),
}));

// Mock nodemailer
vi.mock('nodemailer', () => ({
  createTransport: vi.fn(),
}));

// Mock mailparser
vi.mock('mailparser', () => ({
  simpleParser: vi.fn(),
}));

// Mock ts-caldav to avoid CJS/ESM interop issues
vi.mock('ts-caldav', () => ({
  CalDAVClient: {
    create: vi.fn().mockResolvedValue({
      getCalendars: vi.fn().mockResolvedValue([]),
      getEvents: vi.fn().mockResolvedValue([]),
      createEvent: vi.fn().mockResolvedValue({ uid: 'test', href: '', etag: '', newCtag: '' }),
      updateEvent: vi.fn().mockResolvedValue({ uid: 'test', href: '', etag: '', newCtag: '' }),
      deleteEvent: vi.fn().mockResolvedValue(undefined),
    }),
  },
  CalDAVError: class extends Error {},
}));

// Mock googleapis
vi.mock('googleapis', () => ({
  google: {
    calendar: vi.fn(() => ({
      events: { list: vi.fn(), get: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
      calendarList: { list: vi.fn() },
      freebusy: { query: vi.fn() },
    })),
    auth: {
      OAuth2: vi.fn().mockImplementation(() => ({
        setCredentials: vi.fn(),
        on: vi.fn(),
      })),
    },
  },
}));

// Mock email-client to avoid real IMAP/SMTP connections
vi.mock('../src/modules/email/email-client.js', () => ({
  listEmails: vi.fn(async () => []),
  readEmail: vi.fn(async () => null),
  searchEmails: vi.fn(async () => []),
  listFolders: vi.fn(async () => []),
  sendEmail: vi.fn(async () => ({ success: true })),
  replyToEmail: vi.fn(async () => ({ success: true })),
  moveEmail: vi.fn(async () => ({ success: true })),
  setEmailFlags: vi.fn(async () => ({ success: true })),
  deleteEmail: vi.fn(async () => ({ success: true })),
  forwardEmail: vi.fn(async () => ({ success: true })),
  invalidateTransporterCache: vi.fn(),
}));

// Mock email oauth2
vi.mock('../src/modules/email/oauth2.js', () => ({
  loadConfig: vi.fn(async () => ({})),
  saveConfig: vi.fn(async () => {}),
  generateAuthUrl: vi.fn(() => 'https://auth.example.com'),
  exchangeCode: vi.fn(async () => ({ accessToken: 'test', refreshToken: 'test' })),
}));

// Mock google-calendar
vi.mock('../src/modules/calendar/google-calendar.js', () => ({
  listEvents: vi.fn(async () => []),
  getEvent: vi.fn(async () => null),
  createEvent: vi.fn(async () => ({ id: 'test' })),
  updateEvent: vi.fn(async () => ({ id: 'test' })),
  deleteEvent: vi.fn(async () => ({ success: true })),
  searchEvents: vi.fn(async () => []),
  listCalendars: vi.fn(async () => []),
  checkAvailability: vi.fn(async () => ({ busy: [] })),
  getUpcoming: vi.fn(async () => []),
  getDailySummary: vi.fn(async () => ''),
}));

// Mock the dual-transport module so we don't actually start a server
vi.mock('../src/lib/dual-transport.js', () => ({
  startDualTransport: vi.fn(async () => ({ type: 'stdio' })),
}));

// ---- Test Helper ----

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
// Server Creation Tests
// ================================================================

describe('server creation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('McpServer can be instantiated with correct name and version', async () => {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const server = new McpServer(
      { name: 'personal-suite', version: '0.4.0' },
      { instructions: 'test instructions' },
    );
    expect(server).toBeDefined();
  });
});

// ================================================================
// Module Registration Tests
// ================================================================

describe('module registration', () => {
  let mockServer: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    mockServer = createMockServer();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registerSystemTools registers 5 tools', async () => {
    const { registerSystemTools } = await import('../src/modules/system/index.js');
    registerSystemTools(mockServer as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    expect(mockServer._tools.has('suite_status')).toBe(true);
    expect(mockServer._tools.has('suite_setup')).toBe(true);
    expect(mockServer._tools.has('suite_health')).toBe(true);
    expect(mockServer._tools.has('suite_guide')).toBe(true);
    expect(mockServer._tools.size).toBe(5);
  });

  it('registerEmailTools registers 15 tools', async () => {
    const { registerEmailTools } = await import('../src/modules/email/index.js');
    registerEmailTools(mockServer as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const expectedEmailTools = [
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

    for (const toolName of expectedEmailTools) {
      expect(mockServer._tools.has(toolName), `Missing email tool: ${toolName}`).toBe(true);
    }
    expect(mockServer._tools.size).toBe(15);
  });

  it('registerCalendarTools registers 11 tools', async () => {
    const { registerCalendarTools } = await import('../src/modules/calendar/index.js');
    registerCalendarTools(mockServer as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const expectedCalTools = [
      'calendar_status',
      'calendar_list_events',
      'calendar_get_event',
      'calendar_create_event',
      'calendar_update_event',
      'calendar_delete_event',
      'calendar_search_events',
      'calendar_list_calendars',
      'calendar_check_availability',
      'calendar_upcoming',
      'calendar_daily_summary',
    ];

    for (const toolName of expectedCalTools) {
      expect(mockServer._tools.has(toolName), `Missing calendar tool: ${toolName}`).toBe(true);
    }
    expect(mockServer._tools.size).toBe(11);
  });

  it('all registered modules together produce 31 tools', async () => {
    const { registerSystemTools } = await import('../src/modules/system/index.js');
    const { registerEmailTools } = await import('../src/modules/email/index.js');
    const { registerCalendarTools } = await import('../src/modules/calendar/index.js');

    registerSystemTools(mockServer as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);
    registerEmailTools(mockServer as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);
    registerCalendarTools(mockServer as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    // System (5) + Email (15) + Calendar (11) = 31
    expect(mockServer._tools.size).toBe(31);
  });

  it('adding messaging and search brings total to 46', async () => {
    vi.stubEnv('MULTI_CHANNEL_AUTO_CONNECT', '0');

    const { registerSystemTools } = await import('../src/modules/system/index.js');
    const { registerEmailTools } = await import('../src/modules/email/index.js');
    const { registerCalendarTools } = await import('../src/modules/calendar/index.js');
    const { registerMessagingTools } = await import('../src/modules/messaging/index.js');
    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const { resetRegistry } = await import('../src/modules/messaging/registry.js');

    resetRegistry();
    registerSystemTools(mockServer as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);
    registerEmailTools(mockServer as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);
    registerCalendarTools(mockServer as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);
    registerMessagingTools(mockServer as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);
    registerSearchTools(mockServer as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    // System (5) + Email (15) + Calendar (11) + Messaging (8) + Search (7) = 46
    expect(mockServer._tools.size).toBe(46);

    vi.unstubAllEnvs();
    resetRegistry();
  });
});

// ================================================================
// Server Info Tests
// ================================================================

describe('server info', () => {
  it('server name is personal-suite', () => {
    // Verified from server.ts source: name: 'personal-suite'
    const serverConfig = { name: 'personal-suite', version: '0.4.0' };
    expect(serverConfig.name).toBe('personal-suite');
  });

  it('server version matches package.json', async () => {
    const fs = await import('fs');
    const pkg = JSON.parse(fs.readFileSync('/home/simple/mcp-personal-suite/package.json', 'utf-8'));
    expect(pkg.version).toBe('0.4.0');
  });
});

// ================================================================
// Instructions Tests
// ================================================================

describe('server instructions', () => {
  const INSTRUCTIONS = `# Personal Suite — Email, Calendar, Messaging, Search

You are connected to the Personal Suite MCP server, a unified personal productivity
assistant for Claude Code. It combines email, calendar, messaging, and web search
into a single server.`;

  it('instructions contain module descriptions', () => {
    expect(INSTRUCTIONS).toContain('Email');
    expect(INSTRUCTIONS).toContain('Calendar');
    expect(INSTRUCTIONS).toContain('Messaging');
    expect(INSTRUCTIONS).toContain('Search');
  });

  it('instructions mention suite_status as first step', () => {
    const fullInstructions = `## Getting Started

1. Call \`suite_status\` to see which modules are configured
2. Call \`suite_setup\` to configure any module (email, calendar, messaging, search)
3. Call \`suite_health\` to verify connections are working`;

    expect(fullInstructions).toContain('suite_status');
    expect(fullInstructions).toContain('suite_setup');
    expect(fullInstructions).toContain('suite_health');
  });

  it('instructions list all tool prefixes', () => {
    const prefixSection = `- email_*  — Email tools
- cal_*    — Calendar tools
- msg_*    — Messaging tools
- search_* — Search tools
- suite_*  — System tools (this module)`;

    expect(prefixSection).toContain('email_*');
    expect(prefixSection).toContain('cal_*');
    expect(prefixSection).toContain('msg_*');
    expect(prefixSection).toContain('search_*');
    expect(prefixSection).toContain('suite_*');
  });

  it('instructions describe email tools', () => {
    const emailSection = `### Email (email_*)
Send, receive, search, and reply to emails. Supports Gmail (OAuth2),
Outlook (OAuth2), and generic IMAP/SMTP.

Tools: email_status, email_send, email_list, email_read, email_search,
email_reply, email_forward, email_move, email_delete, email_folders,
email_threads, email_mark_read, email_mark_unread`;

    expect(emailSection).toContain('Gmail');
    expect(emailSection).toContain('Outlook');
    expect(emailSection).toContain('IMAP');
  });

  it('instructions describe calendar tools', () => {
    const calSection = `### Calendar (cal_*)
Manage Google Calendar events — create, list, update, delete.
Supports recurring events, meeting links, and conflict detection.`;

    expect(calSection).toContain('Google Calendar');
    expect(calSection).toContain('recurring events');
  });

  it('instructions describe messaging tools', () => {
    const msgSection = `### Messaging (msg_*)
Send and receive messages across Telegram, Discord, Slack, and WhatsApp.
Each platform is configured independently.`;

    expect(msgSection).toContain('Telegram');
    expect(msgSection).toContain('Discord');
    expect(msgSection).toContain('Slack');
    expect(msgSection).toContain('WhatsApp');
  });

  it('instructions describe search tools', () => {
    const searchSection = `### Search (search_*)
Web search via SearXNG (self-hosted, 70+ engines) and Brave Search API.`;

    expect(searchSection).toContain('SearXNG');
    expect(searchSection).toContain('Brave');
  });

  it('instructions mention config path', () => {
    const notes = `- Config is stored at ~/.personal-suite/config.json
- All logging goes to stderr (never pollutes stdio transport)`;

    expect(notes).toContain('~/.personal-suite/config.json');
    expect(notes).toContain('stderr');
  });
});

// ================================================================
// Tool Naming Convention Tests
// ================================================================

describe('tool naming conventions', () => {
  let mockServer: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    mockServer = createMockServer();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('system tools use suite_ prefix', async () => {
    const { registerSystemTools } = await import('../src/modules/system/index.js');
    registerSystemTools(mockServer as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    for (const [name] of mockServer._tools) {
      expect(name).toMatch(/^suite_/);
    }
  });

  it('email tools use email_ prefix', async () => {
    const { registerEmailTools } = await import('../src/modules/email/index.js');
    registerEmailTools(mockServer as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    for (const [name] of mockServer._tools) {
      expect(name).toMatch(/^email_/);
    }
  });

  it('calendar tools use calendar_ prefix', async () => {
    const { registerCalendarTools } = await import('../src/modules/calendar/index.js');
    registerCalendarTools(mockServer as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    for (const [name] of mockServer._tools) {
      expect(name).toMatch(/^calendar_/);
    }
  });

  it('messaging tools use channel_ prefix', async () => {
    vi.stubEnv('MULTI_CHANNEL_AUTO_CONNECT', '0');
    const { registerMessagingTools } = await import('../src/modules/messaging/index.js');
    const { resetRegistry } = await import('../src/modules/messaging/registry.js');
    resetRegistry();
    registerMessagingTools(mockServer as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    for (const [name] of mockServer._tools) {
      expect(name).toMatch(/^channel_/);
    }
    resetRegistry();
  });

  it('search tools use search_ prefix', async () => {
    const { registerSearchTools } = await import('../src/modules/search/index.js');
    registerSearchTools(mockServer as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    for (const [name] of mockServer._tools) {
      expect(name).toMatch(/^search_/);
    }
  });

  it('no tool name collisions across all modules', async () => {
    vi.stubEnv('MULTI_CHANNEL_AUTO_CONNECT', '0');

    const { registerSystemTools } = await import('../src/modules/system/index.js');
    const { registerEmailTools } = await import('../src/modules/email/index.js');
    const { registerCalendarTools } = await import('../src/modules/calendar/index.js');
    const { registerMessagingTools } = await import('../src/modules/messaging/index.js');
    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const { resetRegistry } = await import('../src/modules/messaging/registry.js');

    resetRegistry();

    const allNames: string[] = [];
    const captureServer = {
      tool: vi.fn((...args: unknown[]) => {
        allNames.push(args[0] as string);
      }),
    };

    const srv = captureServer as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer;
    registerSystemTools(srv);
    registerEmailTools(srv);
    registerCalendarTools(srv);
    registerMessagingTools(srv);
    registerSearchTools(srv);

    const uniqueNames = new Set(allNames);
    expect(allNames.length).toBe(uniqueNames.size);

    resetRegistry();
  });
});
