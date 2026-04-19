/**
 * CalDAV Calendar Client
 *
 * Supports any CalDAV-compliant server:
 * Apple iCloud, Nextcloud, mailbox.org, Posteo, Radicale, Baikal, Synology, etc.
 *
 * Uses basic auth (URL + username + password) via ts-caldav library.
 */

import { logger } from '../../lib/logger.js';
import { loadConfig, type CalDAVConfig } from '../../lib/config.js';

// Lazy import ts-caldav to avoid ESM/CJS crash on Node 22
// (ts-caldav uses `import { encode } from 'base-64'` which fails as named CJS export)
type CaldavCalendar = import('ts-caldav').Calendar;
type CaldavEvent = import('ts-caldav').Event;
type CalDAVClient = import('ts-caldav').CalDAVClient;

// ─── Re-export shared types from google-calendar ───
// Keep the same interface so the router in index.ts can be transparent.

import type {
  CalendarEvent,
  CalendarInfo,
  TimeSlot,
  CreateEventInput,
  ConflictWarning,
  UpdateEventInput,
  ListEventsInput,
  DailySummary,
} from './google-calendar.js';

// ─── Well-Known CalDAV URLs ─────────────────────────

export const WELL_KNOWN_CALDAV_URLS: Record<string, { url: string; notes: string }> = {
  'icloud': {
    url: 'https://caldav.icloud.com',
    notes: 'Apple iCloud. Use your Apple ID email + app-specific password (appleid.apple.com/account/manage → App-Specific Passwords).',
  },
  'nextcloud': {
    url: '/remote.php/dav',
    notes: 'Append to your Nextcloud base URL, e.g. https://cloud.example.com/remote.php/dav. Use Nextcloud username + password or app password.',
  },
  'mailbox.org': {
    url: 'https://dav.mailbox.org',
    notes: 'mailbox.org. Use your full email + password.',
  },
  'posteo': {
    url: 'https://posteo.de:8443',
    notes: 'Posteo. Use your full email + password. CalDAV must be enabled in Posteo settings.',
  },
  'radicale': {
    url: 'http://localhost:5232',
    notes: 'Self-hosted Radicale. Default port 5232. Use configured username + password.',
  },
  'baikal': {
    url: '/dav.php',
    notes: 'Append to your Baikal URL, e.g. https://baikal.example.com/dav.php. Use Baikal username + password.',
  },
  'synology': {
    url: '/caldav',
    notes: 'Append to your Synology NAS URL, e.g. https://your-nas:5001/caldav. Use DSM username + password.',
  },
  'fastmail': {
    url: 'https://caldav.fastmail.com/dav/calendars',
    notes: 'Fastmail. Use your Fastmail email + app-specific password.',
  },
  'google': {
    url: 'https://apidata.googleusercontent.com/caldav/v2',
    notes: 'Google Calendar via CalDAV (limited). Prefer the native Google provider for full features.',
  },
  'yahoo': {
    url: 'https://caldav.calendar.yahoo.com',
    notes: 'Yahoo Calendar. Use Yahoo email + app password.',
  },
  'zoho': {
    url: 'https://calendar.zoho.com/caldav',
    notes: 'Zoho Calendar. Use Zoho email + app-specific password.',
  },
};

// ─── Client Factory ─────────────────────────────────

async function getCalDAVConfig(): Promise<CalDAVConfig> {
  const suiteConfig = await loadConfig();
  const caldav = suiteConfig.calendar?.caldav;
  if (!caldav?.url || !caldav?.username || !caldav?.password) {
    throw new Error(
      'CalDAV is not configured. Run suite_setup(module: "calendar", calendar_provider: "caldav", ' +
      'calendar_caldav_url: "https://...", calendar_caldav_username: "user", calendar_caldav_password: "pass") to set up.',
    );
  }
  return caldav;
}

async function createClient(config?: CalDAVConfig): Promise<import('ts-caldav').CalDAVClient> {
  const { CalDAVClient } = await import('ts-caldav');
  const caldav = config ?? await getCalDAVConfig();
  return CalDAVClient.create({
    baseUrl: caldav.url,
    auth: {
      type: 'basic',
      username: caldav.username,
      password: caldav.password,
    },
    requestTimeout: 15_000,
  });
}

function getDefaultCalendarUrl(config: CalDAVConfig): string | undefined {
  return config.defaultCalendarId ?? undefined;
}

// ─── Event Mapping ──────────────────────────────────

function mapCaldavEvent(event: CaldavEvent): CalendarEvent {
  const isAllDay = event.wholeDay ?? false;

  return {
    id: event.uid,
    summary: event.summary || '(no title)',
    description: event.description ?? null,
    location: event.location ?? null,
    start: isAllDay
      ? event.start.toISOString().split('T')[0]
      : event.start.toISOString(),
    end: isAllDay
      ? event.end.toISOString().split('T')[0]
      : event.end.toISOString(),
    allDay: isAllDay,
    status: (event.status ?? 'confirmed').toLowerCase(),
    htmlLink: null,
    creator: null,
    organizer: null,
    attendees: [],
    recurringEventId: null,
    created: null,
    updated: null,
  };
}

function mapCaldavCalendar(cal: CaldavCalendar): CalendarInfo {
  return {
    id: cal.url,
    summary: cal.displayName || '(unnamed)',
    description: null,
    primary: false,
    timeZone: null,
    backgroundColor: cal.color ?? null,
    accessRole: cal.supportedComponents.includes('VEVENT') ? 'writer' : 'reader',
  };
}

// ─── Resolve calendar URL ───────────────────────────

async function resolveCalendarUrl(
  client: import('ts-caldav').CalDAVClient,
  calendarId?: string,
  config?: CalDAVConfig,
): Promise<string> {
  // If calendarId is provided, use it directly (it's a full URL for CalDAV)
  if (calendarId) return calendarId;

  // Try default from config
  const caldav = config ?? await getCalDAVConfig();
  const defaultUrl = getDefaultCalendarUrl(caldav);
  if (defaultUrl) return defaultUrl;

  // Fall back to first available calendar
  const calendars = await client.getCalendars();
  const eventCalendars = calendars.filter(c => c.supportedComponents.includes('VEVENT'));
  if (eventCalendars.length === 0) {
    throw new Error('No calendars found on CalDAV server. Check your configuration.');
  }
  return eventCalendars[0].url;
}

// ─── Public API ─────────────────────────────────────

export async function caldavListEvents(input: ListEventsInput): Promise<CalendarEvent[]> {
  const config = await getCalDAVConfig();
  const client = await createClient(config);
  const calUrl = await resolveCalendarUrl(client, input.calendarId, config);

  const now = new Date();
  const start = input.timeMin ? new Date(input.timeMin) : now;
  const defaultMax = new Date(now);
  defaultMax.setDate(defaultMax.getDate() + 7);
  const end = input.timeMax ? new Date(input.timeMax) : defaultMax;

  logger.debug('caldavListEvents', { calUrl, start: start.toISOString(), end: end.toISOString() });

  const events = await client.getEvents(calUrl, { start, end });

  let mapped = events.map(mapCaldavEvent);

  // Apply text filter if query is provided
  if (input.query) {
    const q = input.query.toLowerCase();
    mapped = mapped.filter(e =>
      e.summary.toLowerCase().includes(q) ||
      (e.description?.toLowerCase().includes(q)) ||
      (e.location?.toLowerCase().includes(q)),
    );
  }

  // Sort by start time
  mapped.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  // Apply maxResults
  const limit = input.maxResults ?? 50;
  return mapped.slice(0, limit);
}

export async function caldavGetEvent(eventId: string, calendarId?: string): Promise<CalendarEvent | null> {
  const config = await getCalDAVConfig();
  const client = await createClient(config);
  const calUrl = await resolveCalendarUrl(client, calendarId, config);

  // CalDAV doesn't have a direct "get by UID" — fetch all and filter
  const events = await client.getEvents(calUrl, { all: true });
  const found = events.find(e => e.uid === eventId);
  return found ? mapCaldavEvent(found) : null;
}

export async function caldavCreateEvent(
  input: CreateEventInput,
  calendarId?: string,
): Promise<{ event: CalendarEvent; conflicts: ConflictWarning[] }> {
  const config = await getCalDAVConfig();
  const client = await createClient(config);
  const calUrl = await resolveCalendarUrl(client, calendarId, config);

  // Check for conflicts
  const conflicts = await caldavCheckConflicts(client, calUrl, input.start, input.end);

  logger.info('caldavCreateEvent', { summary: input.summary, start: input.start, conflicts: conflicts.length });

  const result = await client.createEvent(calUrl, {
    summary: input.summary,
    start: new Date(input.start),
    end: new Date(input.end),
    description: input.description,
    location: input.location,
  });

  // Construct the event object from what we know
  const event: CalendarEvent = {
    id: result.uid,
    summary: input.summary,
    description: input.description ?? null,
    location: input.location ?? null,
    start: input.start,
    end: input.end,
    allDay: false,
    status: 'confirmed',
    htmlLink: null,
    creator: null,
    organizer: null,
    attendees: [],
    recurringEventId: null,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
  };

  return { event, conflicts };
}

export async function caldavUpdateEvent(
  input: UpdateEventInput,
  calendarId?: string,
): Promise<CalendarEvent> {
  const config = await getCalDAVConfig();
  const client = await createClient(config);
  const calUrl = await resolveCalendarUrl(client, calendarId, config);

  // Fetch existing event to get full data + etag + href
  const events = await client.getEvents(calUrl, { all: true });
  const existing = events.find(e => e.uid === input.eventId);
  if (!existing) {
    throw new Error(`Event not found: ${input.eventId}`);
  }

  // Apply updates
  const updated: CaldavEvent = {
    ...existing,
    summary: input.summary ?? existing.summary,
    description: input.description ?? existing.description,
    location: input.location ?? existing.location,
    start: input.start ? new Date(input.start) : existing.start,
    end: input.end ? new Date(input.end) : existing.end,
  };

  logger.info('caldavUpdateEvent', { eventId: input.eventId, fields: Object.keys(input).filter(k => k !== 'eventId' && input[k as keyof UpdateEventInput] !== undefined) });

  await client.updateEvent(calUrl, updated);

  return mapCaldavEvent(updated);
}

export async function caldavDeleteEvent(eventId: string, calendarId?: string): Promise<void> {
  const config = await getCalDAVConfig();
  const client = await createClient(config);
  const calUrl = await resolveCalendarUrl(client, calendarId, config);

  logger.info('caldavDeleteEvent', { eventId });

  await client.deleteEvent(calUrl, eventId);
}

export async function caldavSearchEvents(query: string, maxResults?: number, calendarId?: string): Promise<CalendarEvent[]> {
  const config = await getCalDAVConfig();
  const client = await createClient(config);
  const calUrl = await resolveCalendarUrl(client, calendarId, config);

  // CalDAV doesn't have native text search — fetch all events within +/- 1 year and filter
  const now = new Date();
  const start = new Date(now);
  start.setFullYear(start.getFullYear() - 1);
  const end = new Date(now);
  end.setFullYear(end.getFullYear() + 1);

  logger.debug('caldavSearchEvents', { query, maxResults });

  const events = await client.getEvents(calUrl, { start, end });
  const q = query.toLowerCase();

  const matched = events
    .filter(e =>
      e.summary?.toLowerCase().includes(q) ||
      e.description?.toLowerCase().includes(q) ||
      e.location?.toLowerCase().includes(q),
    )
    .map(mapCaldavEvent)
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  return matched.slice(0, maxResults ?? 20);
}

export async function caldavListCalendars(): Promise<CalendarInfo[]> {
  const client = await createClient();
  const calendars = await client.getCalendars();
  return calendars.map(mapCaldavCalendar);
}

export async function caldavCheckAvailability(
  dateStr: string,
  durationMinutes: number,
  startHour: number,
  endHour: number,
  calendarId?: string,
): Promise<TimeSlot[]> {
  // Build day boundaries
  const dayStart = new Date(`${dateStr}T${String(startHour).padStart(2, '0')}:00:00`);
  const dayEnd = new Date(`${dateStr}T${String(endHour).padStart(2, '0')}:00:00`);

  const events = await caldavListEvents({
    calendarId,
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
    maxResults: 100,
  });

  // Get busy intervals (only timed events, not all-day)
  const busy: Array<{ start: number; end: number }> = events
    .filter((e) => !e.allDay)
    .map((e) => ({
      start: new Date(e.start).getTime(),
      end: new Date(e.end).getTime(),
    }))
    .sort((a, b) => a.start - b.start);

  // Find free slots
  const freeSlots: TimeSlot[] = [];
  const slotDuration = durationMinutes * 60 * 1000;
  let cursor = dayStart.getTime();

  for (const b of busy) {
    if (b.start - cursor >= slotDuration) {
      freeSlots.push({
        start: new Date(cursor).toISOString(),
        end: new Date(b.start).toISOString(),
        durationMinutes: Math.round((b.start - cursor) / 60000),
      });
    }
    cursor = Math.max(cursor, b.end);
  }

  // After last event
  if (dayEnd.getTime() - cursor >= slotDuration) {
    freeSlots.push({
      start: new Date(cursor).toISOString(),
      end: dayEnd.toISOString(),
      durationMinutes: Math.round((dayEnd.getTime() - cursor) / 60000),
    });
  }

  return freeSlots;
}

export async function caldavGetUpcoming(count: number, calendarId?: string): Promise<CalendarEvent[]> {
  return caldavListEvents({
    calendarId,
    timeMin: new Date().toISOString(),
    maxResults: count,
  });
}

export async function caldavGetDailySummary(dateStr: string, calendarId?: string): Promise<DailySummary> {
  const dayStart = new Date(`${dateStr}T00:00:00`);
  const dayEnd = new Date(`${dateStr}T23:59:59`);

  const events = await caldavListEvents({
    calendarId,
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
    maxResults: 100,
  });

  const allDayEvents = events.filter((e) => e.allDay);
  const timedEvents = events.filter((e) => !e.allDay);

  // Calculate busy minutes
  let busyMinutes = 0;
  for (const e of timedEvents) {
    const start = new Date(e.start).getTime();
    const end = new Date(e.end).getTime();
    busyMinutes += Math.round((end - start) / 60000);
  }

  // Working day = 8h (480 min)
  const freeMinutes = Math.max(0, 480 - busyMinutes);

  const sortedTimed = [...timedEvents].sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
  );

  return {
    date: dateStr,
    totalEvents: events.length,
    allDayEvents,
    timedEvents: sortedTimed,
    busyMinutes,
    freeMinutes,
    firstEvent: sortedTimed.length > 0 ? sortedTimed[0].start : null,
    lastEvent: sortedTimed.length > 0 ? sortedTimed[sortedTimed.length - 1].end : null,
  };
}

// ─── Health Check ───────────────────────────────────

export async function caldavHealthCheck(): Promise<string> {
  try {
    const config = await getCalDAVConfig();
    const client = await createClient(config);
    const calendars = await client.getCalendars();
    const eventCalendars = calendars.filter(c => c.supportedComponents.includes('VEVENT'));
    return `[OK] CalDAV connected to ${config.url} — ${eventCalendars.length} calendar(s) found: ${eventCalendars.map(c => c.displayName).join(', ')}`;
  } catch (err) {
    return `[FAIL] CalDAV: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ─── Internal Helpers ───────────────────────────────

async function caldavCheckConflicts(
  client: import('ts-caldav').CalDAVClient,
  calUrl: string,
  start: string,
  end: string,
): Promise<ConflictWarning[]> {
  try {
    const events = await client.getEvents(calUrl, {
      start: new Date(start),
      end: new Date(end),
    });

    return events
      .filter(e => !e.wholeDay)
      .map(e => ({
        eventName: e.summary || '(no title)',
        eventTime: `${e.start.toISOString()} - ${e.end.toISOString()}`,
      }));
  } catch {
    // Non-critical — if conflict check fails, still create the event
    return [];
  }
}
