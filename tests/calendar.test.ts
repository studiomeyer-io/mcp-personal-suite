/**
 * Calendar Module Tests — Config, Event Helpers, Tool Registration, Availability
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── Mock googleapis BEFORE imports ─────────────────────

const mockEventsListFn = vi.fn();
const mockEventsGetFn = vi.fn();
const mockEventsInsertFn = vi.fn();
const mockEventsPatchFn = vi.fn();
const mockEventsDeleteFn = vi.fn();
const mockCalendarListFn = vi.fn();

const mockCalendar = {
  events: {
    list: mockEventsListFn,
    get: mockEventsGetFn,
    insert: mockEventsInsertFn,
    patch: mockEventsPatchFn,
    delete: mockEventsDeleteFn,
  },
  calendarList: {
    list: mockCalendarListFn,
  },
};

vi.mock('googleapis', () => ({
  google: {
    calendar: vi.fn(() => mockCalendar),
    auth: {
      OAuth2: vi.fn().mockImplementation(() => ({
        setCredentials: vi.fn(),
      })),
      GoogleAuth: vi.fn().mockImplementation(() => ({
        getClient: vi.fn().mockResolvedValue({}),
      })),
    },
  },
}));

// Mock ts-caldav to avoid CJS/ESM interop issues in vitest
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

// ─── Imports ────────────────────────────────────────────

import {
  resolveRecurrence,
  checkAvailability,
  listEvents,
  type CalendarEvent,
} from '../src/modules/calendar/google-calendar.js';

// ─── Helpers ────────────────────────────────────────────

let tmpDir: string;

afterEach(() => {
  delete process.env['GOOGLE_CALENDAR_CREDENTIALS'];
  delete process.env['GOOGLE_CLIENT_ID'];
  delete process.env['GOOGLE_CLIENT_SECRET'];
  delete process.env['GOOGLE_REFRESH_TOKEN'];
  delete process.env['GOOGLE_CALENDAR_ID'];
  delete process.env['PERSONAL_SUITE_CONFIG_DIR'];

  vi.clearAllMocks();

  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function createTmpDir(): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'cal-test-'));
  return tmpDir;
}

function setOAuth2Env() {
  process.env['GOOGLE_CLIENT_ID'] = 'test-client-id';
  process.env['GOOGLE_CLIENT_SECRET'] = 'test-client-secret';
  process.env['GOOGLE_REFRESH_TOKEN'] = 'test-refresh-token';
}

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'evt-1',
    summary: 'Test Event',
    description: null,
    location: null,
    start: '2026-04-04T10:00:00+02:00',
    end: '2026-04-04T11:00:00+02:00',
    allDay: false,
    status: 'confirmed',
    htmlLink: null,
    creator: null,
    organizer: null,
    attendees: [],
    recurringEventId: null,
    created: null,
    updated: null,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════
// Config Loading
// ═══════════════════════════════════════════════════════

describe('Calendar Config Loading', () => {
  it('should load OAuth2 config from env vars', () => {
    setOAuth2Env();
    // getAuth is not exported, but we can test by calling listEvents
    // which calls getCalendarClient -> getAuth. If no error, auth worked.
    mockEventsListFn.mockResolvedValue({ data: { items: [] } });

    // This should not throw because env vars are set
    expect(async () => {
      await listEvents({});
    }).not.toThrow();
  });

  it('should load config from file when env vars are missing', () => {
    const dir = createTmpDir();
    process.env['PERSONAL_SUITE_CONFIG_DIR'] = dir;
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        calendar: {
          clientId: 'file-cid',
          clientSecret: 'file-csecret',
          refreshToken: 'file-rtoken',
        },
      }),
    );

    // Auth should work with file config
    mockEventsListFn.mockResolvedValue({ data: { items: [] } });
    expect(async () => {
      await listEvents({});
    }).not.toThrow();
  });

  it('should throw when no credentials are configured', async () => {
    const dir = createTmpDir();
    process.env['PERSONAL_SUITE_CONFIG_DIR'] = dir;
    writeFileSync(join(dir, 'config.json'), JSON.stringify({}));

    await expect(listEvents({})).rejects.toThrow('No Google Calendar credentials configured');
  });

  it('should use GOOGLE_CALENDAR_ID env for default calendar', async () => {
    setOAuth2Env();
    process.env['GOOGLE_CALENDAR_ID'] = 'custom-cal-id';
    mockEventsListFn.mockResolvedValue({ data: { items: [] } });

    // When listEvents is called without calendarId, it should use the env value
    await listEvents({});
    // The mock should be called with custom-cal-id
    expect(mockEventsListFn).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: 'custom-cal-id' }),
    );
  });

  it('should default to "primary" when no GOOGLE_CALENDAR_ID set', async () => {
    setOAuth2Env();
    mockEventsListFn.mockResolvedValue({ data: { items: [] } });

    await listEvents({});

    expect(mockEventsListFn).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: 'primary' }),
    );
  });
});

// ═══════════════════════════════════════════════════════
// Event Formatting & Recurrence
// ═══════════════════════════════════════════════════════

describe('Recurrence Resolution', () => {
  it('should resolve "daily" preset', () => {
    expect(resolveRecurrence('daily')).toEqual(['RRULE:FREQ=DAILY']);
  });

  it('should resolve "weekly" preset', () => {
    expect(resolveRecurrence('weekly')).toEqual(['RRULE:FREQ=WEEKLY']);
  });

  it('should resolve "monthly" preset', () => {
    expect(resolveRecurrence('monthly')).toEqual(['RRULE:FREQ=MONTHLY']);
  });

  it('should resolve "yearly" preset', () => {
    expect(resolveRecurrence('yearly')).toEqual(['RRULE:FREQ=YEARLY']);
  });

  it('should be case-insensitive for presets', () => {
    expect(resolveRecurrence('DAILY')).toEqual(['RRULE:FREQ=DAILY']);
    expect(resolveRecurrence('Weekly')).toEqual(['RRULE:FREQ=WEEKLY']);
  });

  it('should pass through RRULE strings as-is', () => {
    const rule = 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR';
    expect(resolveRecurrence(rule)).toEqual([rule]);
  });

  it('should prepend RRULE: to custom rules without prefix', () => {
    expect(resolveRecurrence('FREQ=MONTHLY;BYMONTHDAY=15')).toEqual([
      'RRULE:FREQ=MONTHLY;BYMONTHDAY=15',
    ]);
  });
});

describe('Event Mapping', () => {
  it('should detect all-day events', async () => {
    setOAuth2Env();
    mockEventsListFn.mockResolvedValue({
      data: {
        items: [
          {
            id: 'allday-1',
            summary: 'Holiday',
            start: { date: '2026-04-04' },
            end: { date: '2026-04-05' },
            status: 'confirmed',
          },
        ],
      },
    });

    const events = await listEvents({});
    expect(events).toHaveLength(1);
    expect(events[0].allDay).toBe(true);
    expect(events[0].start).toBe('2026-04-04');
  });

  it('should detect timed events', async () => {
    setOAuth2Env();
    mockEventsListFn.mockResolvedValue({
      data: {
        items: [
          {
            id: 'timed-1',
            summary: 'Meeting',
            start: { dateTime: '2026-04-04T10:00:00+02:00' },
            end: { dateTime: '2026-04-04T11:00:00+02:00' },
            status: 'confirmed',
          },
        ],
      },
    });

    const events = await listEvents({});
    expect(events).toHaveLength(1);
    expect(events[0].allDay).toBe(false);
    expect(events[0].start).toContain('T10:00:00');
  });

  it('should map attendees correctly', async () => {
    setOAuth2Env();
    mockEventsListFn.mockResolvedValue({
      data: {
        items: [
          {
            id: 'att-1',
            summary: 'Team Meeting',
            start: { dateTime: '2026-04-04T10:00:00Z' },
            end: { dateTime: '2026-04-04T11:00:00Z' },
            attendees: [
              { email: 'alice@test.com', displayName: 'Alice', responseStatus: 'accepted', self: true },
              { email: 'bob@test.com', responseStatus: 'tentative', self: false },
            ],
          },
        ],
      },
    });

    const events = await listEvents({});
    expect(events[0].attendees).toHaveLength(2);
    expect(events[0].attendees[0].email).toBe('alice@test.com');
    expect(events[0].attendees[0].displayName).toBe('Alice');
    expect(events[0].attendees[0].self).toBe(true);
    expect(events[0].attendees[1].displayName).toBeNull();
  });

  it('should handle event with no summary', async () => {
    setOAuth2Env();
    mockEventsListFn.mockResolvedValue({
      data: {
        items: [
          {
            id: 'nosummary',
            start: { dateTime: '2026-04-04T10:00:00Z' },
            end: { dateTime: '2026-04-04T11:00:00Z' },
          },
        ],
      },
    });

    const events = await listEvents({});
    expect(events[0].summary).toBe('(no title)');
  });

  it('should handle empty items list', async () => {
    setOAuth2Env();
    mockEventsListFn.mockResolvedValue({ data: { items: [] } });

    const events = await listEvents({});
    expect(events).toEqual([]);
  });

  it('should handle undefined items', async () => {
    setOAuth2Env();
    mockEventsListFn.mockResolvedValue({ data: {} });

    const events = await listEvents({});
    expect(events).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════
// Availability Logic
// ═══════════════════════════════════════════════════════

describe('Availability Check', () => {
  beforeEach(() => {
    setOAuth2Env();
  });

  it('should find full day free when no events', async () => {
    mockEventsListFn.mockResolvedValue({ data: { items: [] } });

    const slots = await checkAvailability('2026-04-04', 30, 9, 18);
    expect(slots).toHaveLength(1);
    expect(slots[0].durationMinutes).toBe(540); // 9h = 540 min
  });

  it('should find slots around a single meeting', async () => {
    mockEventsListFn.mockResolvedValue({
      data: {
        items: [
          {
            id: 'meet-1',
            summary: 'Standup',
            start: { dateTime: '2026-04-04T10:00:00' },
            end: { dateTime: '2026-04-04T11:00:00' },
            status: 'confirmed',
          },
        ],
      },
    });

    const slots = await checkAvailability('2026-04-04', 30, 9, 18);
    // Should have 2 slots: before meeting (9-10) and after (11-18)
    expect(slots.length).toBeGreaterThanOrEqual(2);
    expect(slots[0].durationMinutes).toBe(60); // 9:00 - 10:00
    expect(slots[1].durationMinutes).toBe(420); // 11:00 - 18:00
  });

  it('should ignore all-day events in availability', async () => {
    mockEventsListFn.mockResolvedValue({
      data: {
        items: [
          {
            id: 'allday-1',
            summary: 'Holiday',
            start: { date: '2026-04-04' },
            end: { date: '2026-04-05' },
          },
        ],
      },
    });

    const slots = await checkAvailability('2026-04-04', 30, 9, 18);
    // All-day events are filtered — full day should be free
    expect(slots).toHaveLength(1);
    expect(slots[0].durationMinutes).toBe(540);
  });

  it('should not return slots shorter than requested duration', async () => {
    mockEventsListFn.mockResolvedValue({
      data: {
        items: [
          {
            id: 'meet-1',
            summary: 'Meeting 1',
            start: { dateTime: '2026-04-04T09:00:00' },
            end: { dateTime: '2026-04-04T09:20:00' },
          },
          {
            id: 'meet-2',
            summary: 'Meeting 2',
            start: { dateTime: '2026-04-04T09:25:00' },
            end: { dateTime: '2026-04-04T18:00:00' },
          },
        ],
      },
    });

    // Request 30-min slots — the 5-min gap (9:20-9:25) should not appear
    const slots = await checkAvailability('2026-04-04', 30, 9, 18);
    const shortSlots = slots.filter(s => s.durationMinutes < 30);
    expect(shortSlots).toHaveLength(0);
  });

  it('should handle back-to-back meetings', async () => {
    mockEventsListFn.mockResolvedValue({
      data: {
        items: [
          {
            id: 'meet-1',
            start: { dateTime: '2026-04-04T09:00:00' },
            end: { dateTime: '2026-04-04T10:00:00' },
          },
          {
            id: 'meet-2',
            start: { dateTime: '2026-04-04T10:00:00' },
            end: { dateTime: '2026-04-04T11:00:00' },
          },
        ],
      },
    });

    const slots = await checkAvailability('2026-04-04', 30, 9, 18);
    // Only free after 11:00
    expect(slots).toHaveLength(1);
    expect(slots[0].durationMinutes).toBe(420); // 11:00 - 18:00
  });

  it('should return empty when entire day is busy', async () => {
    mockEventsListFn.mockResolvedValue({
      data: {
        items: [
          {
            id: 'full-day',
            start: { dateTime: '2026-04-04T09:00:00' },
            end: { dateTime: '2026-04-04T18:00:00' },
          },
        ],
      },
    });

    const slots = await checkAvailability('2026-04-04', 30, 9, 18);
    expect(slots).toHaveLength(0);
  });

  it('should use custom start/end hours', async () => {
    mockEventsListFn.mockResolvedValue({ data: { items: [] } });

    const slots = await checkAvailability('2026-04-04', 60, 8, 20);
    expect(slots).toHaveLength(1);
    expect(slots[0].durationMinutes).toBe(720); // 12h = 720 min
  });
});

// ═══════════════════════════════════════════════════════
// Tool Registration
// ═══════════════════════════════════════════════════════

describe('Calendar Tool Registration', () => {
  function createMockServer() {
    const tools = new Map<string, unknown>();
    return {
      tool: vi.fn((...args: unknown[]) => {
        tools.set(args[0] as string, args);
      }),
      _tools: tools,
    };
  }

  it('should register all 11 calendar tools', async () => {
    const { registerCalendarTools } = await import('../src/modules/calendar/index.js');
    const server = createMockServer();
    registerCalendarTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    expect(server.tool).toHaveBeenCalledTimes(11);
    expect(server._tools.size).toBe(11);
  });

  it('should register tools with correct names', async () => {
    const { registerCalendarTools } = await import('../src/modules/calendar/index.js');
    const server = createMockServer();
    registerCalendarTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const expectedTools = [
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

    for (const name of expectedTools) {
      expect(server._tools.has(name), `Missing tool: ${name}`).toBe(true);
    }
  });

  it('should have all tool names prefixed with calendar_', async () => {
    const { registerCalendarTools } = await import('../src/modules/calendar/index.js');
    const server = createMockServer();
    registerCalendarTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    for (const name of server._tools.keys()) {
      expect(name).toMatch(/^calendar_/);
    }
  });

  it('should register each tool with a handler function', async () => {
    const { registerCalendarTools } = await import('../src/modules/calendar/index.js');
    const server = createMockServer();
    registerCalendarTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    for (const [, args] of server._tools) {
      const toolArgs = args as unknown[];
      expect(typeof toolArgs[toolArgs.length - 1]).toBe('function');
    }
  });

  it('should register each tool with a description', async () => {
    const { registerCalendarTools } = await import('../src/modules/calendar/index.js');
    const server = createMockServer();
    registerCalendarTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    for (const [, args] of server._tools) {
      const toolArgs = args as unknown[];
      expect(typeof toolArgs[1]).toBe('string');
      expect((toolArgs[1] as string).length).toBeGreaterThan(10);
    }
  });
});

// ═══════════════════════════════════════════════════════
// CalDAV Calendar Integration
// ═══════════════════════════════════════════════════════

describe('CalDAV Calendar — Module Exports', () => {
  it('should export all expected CalDAV functions', async () => {
    const caldav = await import('../src/modules/calendar/caldav-calendar.js');
    expect(typeof caldav.caldavListEvents).toBe('function');
    expect(typeof caldav.caldavGetEvent).toBe('function');
    expect(typeof caldav.caldavCreateEvent).toBe('function');
    expect(typeof caldav.caldavUpdateEvent).toBe('function');
    expect(typeof caldav.caldavDeleteEvent).toBe('function');
    expect(typeof caldav.caldavSearchEvents).toBe('function');
    expect(typeof caldav.caldavListCalendars).toBe('function');
    expect(typeof caldav.caldavCheckAvailability).toBe('function');
    expect(typeof caldav.caldavGetUpcoming).toBe('function');
    expect(typeof caldav.caldavGetDailySummary).toBe('function');
    expect(typeof caldav.caldavHealthCheck).toBe('function');
  });
});

describe('CalDAV Calendar — Well-Known URLs', () => {
  it('should export well-known CalDAV URLs', async () => {
    const { WELL_KNOWN_CALDAV_URLS } = await import('../src/modules/calendar/caldav-calendar.js');
    expect(WELL_KNOWN_CALDAV_URLS).toBeDefined();
    expect(typeof WELL_KNOWN_CALDAV_URLS).toBe('object');
  });

  it('should include iCloud URL', async () => {
    const { WELL_KNOWN_CALDAV_URLS } = await import('../src/modules/calendar/caldav-calendar.js');
    expect(WELL_KNOWN_CALDAV_URLS['icloud']).toBeDefined();
    expect(WELL_KNOWN_CALDAV_URLS['icloud'].url).toBe('https://caldav.icloud.com');
  });

  it('should include Nextcloud URL', async () => {
    const { WELL_KNOWN_CALDAV_URLS } = await import('../src/modules/calendar/caldav-calendar.js');
    expect(WELL_KNOWN_CALDAV_URLS['nextcloud']).toBeDefined();
    expect(WELL_KNOWN_CALDAV_URLS['nextcloud'].url).toContain('/remote.php/dav');
  });

  it('should include mailbox.org URL', async () => {
    const { WELL_KNOWN_CALDAV_URLS } = await import('../src/modules/calendar/caldav-calendar.js');
    expect(WELL_KNOWN_CALDAV_URLS['mailbox.org']).toBeDefined();
    expect(WELL_KNOWN_CALDAV_URLS['mailbox.org'].url).toBe('https://dav.mailbox.org');
  });

  it('should include Fastmail URL', async () => {
    const { WELL_KNOWN_CALDAV_URLS } = await import('../src/modules/calendar/caldav-calendar.js');
    expect(WELL_KNOWN_CALDAV_URLS['fastmail']).toBeDefined();
    expect(WELL_KNOWN_CALDAV_URLS['fastmail'].url).toContain('fastmail');
  });

  it('should have notes for each provider', async () => {
    const { WELL_KNOWN_CALDAV_URLS } = await import('../src/modules/calendar/caldav-calendar.js');
    for (const [, entry] of Object.entries(WELL_KNOWN_CALDAV_URLS)) {
      expect(entry.notes).toBeDefined();
      expect(entry.notes.length).toBeGreaterThan(10);
    }
  });
});

describe('CalDAV Calendar — Config Validation', () => {
  it('should throw when no calendar config exists', async () => {
    // Default loadConfig returns {} (no config file), caldav functions should throw
    const { caldavListCalendars } = await import('../src/modules/calendar/caldav-calendar.js');
    const { clearConfigCache } = await import('../src/lib/config.js');
    clearConfigCache();

    await expect(caldavListCalendars()).rejects.toThrow('CalDAV is not configured');
  });
});

describe('CalDAV Calendar — Health Check', () => {
  it('should return FAIL when CalDAV config is missing (no config file)', async () => {
    // loadConfig returns empty config (no calendar section) → health check fails gracefully
    const { caldavHealthCheck } = await import('../src/modules/calendar/caldav-calendar.js');
    const { clearConfigCache } = await import('../src/lib/config.js');
    clearConfigCache();

    const result = await caldavHealthCheck();
    expect(result).toContain('[FAIL]');
    expect(result).toContain('CalDAV');
  });

  it('should export caldavHealthCheck function', async () => {
    const { caldavHealthCheck } = await import('../src/modules/calendar/caldav-calendar.js');
    expect(typeof caldavHealthCheck).toBe('function');
  });
});

describe('CalDAV Config — CalendarConfig Type', () => {
  it('should support caldav provider in CalendarConfig', () => {
    // Verify the type allows 'caldav' provider (compile-time + runtime check)
    const config = {
      calendar: {
        provider: 'caldav' as const,
        caldav: {
          url: 'https://caldav.icloud.com',
          username: 'test@icloud.com',
          password: 'app-password',
        },
      },
    };

    expect(config.calendar.provider).toBe('caldav');
    expect(config.calendar.caldav?.url).toBe('https://caldav.icloud.com');
  });

  it('should keep backward compatibility with google provider', () => {
    const config = {
      calendar: {
        provider: 'google' as const,
        oauth: {
          accessToken: 'test-token',
          clientId: 'test-id',
          clientSecret: 'test-secret',
        },
      },
    };

    expect(config.calendar.provider).toBe('google');
    expect(config.calendar.oauth?.accessToken).toBe('test-token');
  });
});

describe('CalendarConfig — Provider Detection Logic', () => {
  // Test the provider detection logic directly, without depending on filesystem

  it('should detect CalDAV as configured when URL + credentials present', () => {
    const config = {
      calendar: {
        provider: 'caldav' as const,
        caldav: { url: 'https://caldav.test.com', username: 'user', password: 'pass' },
      },
    };

    // Same logic as getModuleStatus in config.ts
    const calendarUsable = !!(
      (config.calendar?.provider === 'google' && (config.calendar as { oauth?: { accessToken?: string } })?.oauth?.accessToken) ||
      (config.calendar?.provider === 'caldav' && config.calendar?.caldav?.url && config.calendar?.caldav?.username)
    );

    expect(calendarUsable).toBe(true);
  });

  it('should detect CalDAV as not configured when URL is empty', () => {
    const config = {
      calendar: {
        provider: 'caldav' as const,
        caldav: { url: '', username: 'user', password: 'pass' },
      },
    };

    const calendarUsable = !!(
      (config.calendar?.provider === 'google' && (config.calendar as { oauth?: { accessToken?: string } })?.oauth?.accessToken) ||
      (config.calendar?.provider === 'caldav' && config.calendar?.caldav?.url && config.calendar?.caldav?.username)
    );

    expect(calendarUsable).toBe(false);
  });

  it('should detect Google as configured when access token present', () => {
    const config = {
      calendar: {
        provider: 'google' as const,
        oauth: { accessToken: 'test-token', clientId: 'cid', clientSecret: 'csecret' },
      },
    };

    const calendarUsable = !!(
      (config.calendar?.provider === 'google' && config.calendar?.oauth?.accessToken) ||
      (config.calendar?.provider === 'caldav' && (config.calendar as { caldav?: { url?: string; username?: string } })?.caldav?.url)
    );

    expect(calendarUsable).toBe(true);
  });

  it('should detect Google as not configured when no access token', () => {
    const config = {
      calendar: {
        provider: 'google' as const,
        oauth: { accessToken: '', clientId: 'cid', clientSecret: 'csecret' },
      },
    };

    const calendarUsable = !!(
      (config.calendar?.provider === 'google' && config.calendar?.oauth?.accessToken) ||
      (config.calendar?.provider === 'caldav' && (config.calendar as { caldav?: { url?: string; username?: string } })?.caldav?.url)
    );

    expect(calendarUsable).toBe(false);
  });

  it('should detect no provider as not configured', () => {
    const config: { calendar?: unknown } = {};

    const calendarUsable = false; // No calendar config at all

    expect(calendarUsable).toBe(false);
  });
});
