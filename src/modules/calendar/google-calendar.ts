/**
 * Google Calendar API Client
 *
 * Supports two auth modes:
 * 1. Service Account (GOOGLE_CALENDAR_CREDENTIALS as JSON)
 * 2. OAuth2 (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN)
 *
 * Config can also be stored in ~/.personal-suite/config.json under "calendar" key.
 */

import { google, type calendar_v3 } from 'googleapis';
import { logger } from '../../lib/logger.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

// ─── Types ───────────────────────────────────────

export interface CalendarEvent {
  id: string;
  summary: string;
  description: string | null;
  location: string | null;
  start: string;
  end: string;
  allDay: boolean;
  status: string;
  htmlLink: string | null;
  creator: string | null;
  organizer: string | null;
  attendees: EventAttendee[];
  recurringEventId: string | null;
  created: string | null;
  updated: string | null;
}

export interface EventAttendee {
  email: string;
  displayName: string | null;
  responseStatus: string;
  self: boolean;
}

export interface CalendarInfo {
  id: string;
  summary: string;
  description: string | null;
  primary: boolean;
  timeZone: string | null;
  backgroundColor: string | null;
  accessRole: string;
}

export interface TimeSlot {
  start: string;
  end: string;
  durationMinutes: number;
}

export interface CreateEventInput {
  summary: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  attendees?: string[];
  timeZone?: string;
  recurrence?: string;
  addMeetLink?: boolean;
}

export interface ConflictWarning {
  eventName: string;
  eventTime: string;
}

export interface UpdateEventInput {
  eventId: string;
  summary?: string;
  start?: string;
  end?: string;
  description?: string;
  location?: string;
  attendees?: string[];
  timeZone?: string;
}

export interface ListEventsInput {
  timeMin?: string;
  timeMax?: string;
  maxResults?: number;
  calendarId?: string;
  query?: string;
}

export interface DailySummary {
  date: string;
  totalEvents: number;
  allDayEvents: CalendarEvent[];
  timedEvents: CalendarEvent[];
  busyMinutes: number;
  freeMinutes: number;
  firstEvent: string | null;
  lastEvent: string | null;
}

// ─── Config Loading ──────────────────────────────

interface CalendarConfig {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  credentials?: string;
  calendarId?: string;
}

function loadCalendarConfig(): CalendarConfig {
  const configDir = process.env['PERSONAL_SUITE_CONFIG_DIR'] || resolve(homedir(), '.personal-suite');
  const configPath = resolve(configDir, 'config.json');

  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      const cal = raw['calendar'] as CalendarConfig | undefined;
      if (cal) return cal;
    } catch { /* ignore parse errors */ }
  }
  return {};
}

// ─── Auth ────────────────────────────────────────

function getAuth(): ReturnType<typeof google.auth.GoogleAuth.prototype.getClient> | Promise<InstanceType<typeof google.auth.OAuth2>> {
  const credentials = process.env['GOOGLE_CALENDAR_CREDENTIALS'];
  const fileConfig = loadCalendarConfig();

  const credentialsJson = credentials || fileConfig.credentials;

  if (credentialsJson) {
    try {
      const parsed = JSON.parse(credentialsJson) as Record<string, unknown>;

      if (parsed['type'] === 'service_account') {
        const auth = new google.auth.GoogleAuth({
          credentials: parsed,
          scopes: ['https://www.googleapis.com/auth/calendar'],
        });
        return auth.getClient();
      }
    } catch (err) {
      logger.logError('Failed to parse GOOGLE_CALENDAR_CREDENTIALS', err);
    }
  }

  const clientId = process.env['GOOGLE_CLIENT_ID'] || fileConfig.clientId;
  const clientSecret = process.env['GOOGLE_CLIENT_SECRET'] || fileConfig.clientSecret;
  const refreshToken = process.env['GOOGLE_REFRESH_TOKEN'] || fileConfig.refreshToken;

  if (clientId && clientSecret && refreshToken) {
    const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
    oauth2.setCredentials({ refresh_token: refreshToken });
    return Promise.resolve(oauth2);
  }

  throw new Error(
    'No Google Calendar credentials configured. Set GOOGLE_CALENDAR_CREDENTIALS (service account JSON) or GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN (OAuth2). Alternatively, add calendar config to ~/.personal-suite/config.json.',
  );
}

async function getCalendarClient(): Promise<calendar_v3.Calendar> {
  const auth = await getAuth();
  return google.calendar({ version: 'v3', auth: auth as never });
}

function getDefaultCalendarId(): string {
  const fileConfig = loadCalendarConfig();
  return process.env['GOOGLE_CALENDAR_ID'] || fileConfig.calendarId || 'primary';
}

// ─── Event Mapping ───────────────────────────────

function mapEvent(event: calendar_v3.Schema$Event): CalendarEvent {
  const isAllDay = !event.start?.dateTime;

  const attendees: EventAttendee[] = (event.attendees ?? []).map((a) => ({
    email: a.email ?? '',
    displayName: a.displayName ?? null,
    responseStatus: a.responseStatus ?? 'needsAction',
    self: a.self ?? false,
  }));

  return {
    id: event.id ?? '',
    summary: event.summary ?? '(no title)',
    description: event.description ?? null,
    location: event.location ?? null,
    start: (isAllDay ? event.start?.date : event.start?.dateTime) ?? '',
    end: (isAllDay ? event.end?.date : event.end?.dateTime) ?? '',
    allDay: isAllDay,
    status: event.status ?? 'confirmed',
    htmlLink: event.htmlLink ?? null,
    creator: event.creator?.email ?? null,
    organizer: event.organizer?.email ?? null,
    attendees,
    recurringEventId: event.recurringEventId ?? null,
    created: event.created ?? null,
    updated: event.updated ?? null,
  };
}

// ─── Recurrence RRULE Helper ────────────────────

const RECURRENCE_PRESETS: Record<string, string> = {
  daily: 'RRULE:FREQ=DAILY',
  weekly: 'RRULE:FREQ=WEEKLY',
  monthly: 'RRULE:FREQ=MONTHLY',
  yearly: 'RRULE:FREQ=YEARLY',
};

export function resolveRecurrence(input: string): string[] {
  const preset = RECURRENCE_PRESETS[input.toLowerCase()];
  if (preset) return [preset];
  // Custom RRULE string — ensure it starts with RRULE:
  if (input.startsWith('RRULE:')) return [input];
  return [`RRULE:${input}`];
}

// ─── Conflict Detection ─────────────────────────

export async function checkConflicts(
  start: string,
  end: string,
  calendarId?: string,
): Promise<ConflictWarning[]> {
  const events = await listEvents({
    calendarId: calendarId ?? getDefaultCalendarId(),
    timeMin: start,
    timeMax: end,
    maxResults: 10,
  });

  return events
    .filter((e) => !e.allDay)
    .map((e) => ({
      eventName: e.summary,
      eventTime: `${e.start} - ${e.end}`,
    }));
}

// ─── Public API ──────────────────────────────────

export async function listEvents(input: ListEventsInput): Promise<CalendarEvent[]> {
  const cal = await getCalendarClient();
  const calendarId = input.calendarId ?? getDefaultCalendarId();

  const now = new Date();
  const timeMin = input.timeMin ?? now.toISOString();

  // Default: next 7 days
  const defaultMax = new Date(now);
  defaultMax.setDate(defaultMax.getDate() + 7);
  const timeMax = input.timeMax ?? defaultMax.toISOString();

  logger.debug('listEvents', { calendarId, timeMin, timeMax, maxResults: input.maxResults });

  const response = await cal.events.list({
    calendarId,
    timeMin,
    timeMax,
    maxResults: input.maxResults ?? 50,
    singleEvents: true,
    orderBy: 'startTime',
    q: input.query,
  });

  return (response.data.items ?? []).map(mapEvent);
}

export async function getEvent(eventId: string, calendarId?: string): Promise<CalendarEvent | null> {
  const cal = await getCalendarClient();
  const cid = calendarId ?? getDefaultCalendarId();

  try {
    const response = await cal.events.get({ calendarId: cid, eventId });
    return response.data ? mapEvent(response.data) : null;
  } catch (err) {
    const error = err as { code?: number };
    if (error.code === 404) return null;
    throw err;
  }
}

export async function createEvent(
  input: CreateEventInput,
  calendarId?: string,
): Promise<{ event: CalendarEvent; conflicts: ConflictWarning[] }> {
  const cal = await getCalendarClient();
  const cid = calendarId ?? getDefaultCalendarId();
  const timeZone = input.timeZone ?? 'Europe/Berlin';

  // Check for conflicts before creating
  const conflicts = await checkConflicts(input.start, input.end, cid);

  const eventBody: calendar_v3.Schema$Event = {
    summary: input.summary,
    description: input.description,
    location: input.location,
    start: {
      dateTime: input.start,
      timeZone,
    },
    end: {
      dateTime: input.end,
      timeZone,
    },
    attendees: input.attendees?.map((email) => ({ email })),
  };

  // Add recurrence if specified
  if (input.recurrence) {
    eventBody.recurrence = resolveRecurrence(input.recurrence);
  }

  // Add Google Meet link if requested
  if (input.addMeetLink) {
    eventBody.conferenceData = {
      createRequest: {
        requestId: `meet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    };
  }

  logger.info('createEvent', { summary: input.summary, start: input.start, conflicts: conflicts.length });

  const response = await cal.events.insert({
    calendarId: cid,
    requestBody: eventBody,
    sendUpdates: input.attendees?.length ? 'all' : 'none',
    conferenceDataVersion: input.addMeetLink ? 1 : undefined,
  });

  return { event: mapEvent(response.data), conflicts };
}

export async function updateEvent(input: UpdateEventInput, calendarId?: string): Promise<CalendarEvent> {
  const cal = await getCalendarClient();
  const cid = calendarId ?? getDefaultCalendarId();
  const timeZone = input.timeZone ?? 'Europe/Berlin';

  const patch: calendar_v3.Schema$Event = {};

  if (input.summary !== undefined) patch.summary = input.summary;
  if (input.description !== undefined) patch.description = input.description;
  if (input.location !== undefined) patch.location = input.location;
  if (input.start !== undefined) patch.start = { dateTime: input.start, timeZone };
  if (input.end !== undefined) patch.end = { dateTime: input.end, timeZone };
  if (input.attendees !== undefined) patch.attendees = input.attendees.map((email) => ({ email }));

  logger.info('updateEvent', { eventId: input.eventId, fields: Object.keys(patch) });

  const response = await cal.events.patch({
    calendarId: cid,
    eventId: input.eventId,
    requestBody: patch,
    sendUpdates: input.attendees ? 'all' : 'none',
  });

  return mapEvent(response.data);
}

export async function deleteEvent(eventId: string, calendarId?: string): Promise<void> {
  const cal = await getCalendarClient();
  const cid = calendarId ?? getDefaultCalendarId();

  logger.info('deleteEvent', { eventId });

  await cal.events.delete({
    calendarId: cid,
    eventId,
    sendUpdates: 'all',
  });
}

export async function searchEvents(query: string, maxResults?: number, calendarId?: string): Promise<CalendarEvent[]> {
  const cal = await getCalendarClient();
  const cid = calendarId ?? getDefaultCalendarId();

  // Search 1 year back and 1 year forward
  const now = new Date();
  const timeMin = new Date(now);
  timeMin.setFullYear(timeMin.getFullYear() - 1);
  const timeMax = new Date(now);
  timeMax.setFullYear(timeMax.getFullYear() + 1);

  logger.debug('searchEvents', { query, maxResults });

  const response = await cal.events.list({
    calendarId: cid,
    q: query,
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    maxResults: maxResults ?? 20,
    singleEvents: true,
    orderBy: 'startTime',
  });

  return (response.data.items ?? []).map(mapEvent);
}

export async function listCalendars(): Promise<CalendarInfo[]> {
  const cal = await getCalendarClient();

  const response = await cal.calendarList.list();

  return (response.data.items ?? []).map((c) => ({
    id: c.id ?? '',
    summary: c.summary ?? '(unnamed)',
    description: c.description ?? null,
    primary: c.primary ?? false,
    timeZone: c.timeZone ?? null,
    backgroundColor: c.backgroundColor ?? null,
    accessRole: c.accessRole ?? 'reader',
  }));
}

export async function checkAvailability(
  dateStr: string,
  durationMinutes: number,
  startHour: number,
  endHour: number,
  calendarId?: string,
): Promise<TimeSlot[]> {
  const cid = calendarId ?? getDefaultCalendarId();

  // Build day boundaries
  const dayStart = new Date(`${dateStr}T${String(startHour).padStart(2, '0')}:00:00`);
  const dayEnd = new Date(`${dateStr}T${String(endHour).padStart(2, '0')}:00:00`);

  const events = await listEvents({
    calendarId: cid,
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

export async function getUpcoming(count: number, calendarId?: string): Promise<CalendarEvent[]> {
  return listEvents({
    calendarId: calendarId ?? getDefaultCalendarId(),
    timeMin: new Date().toISOString(),
    maxResults: count,
  });
}

export async function getDailySummary(dateStr: string, calendarId?: string): Promise<DailySummary> {
  const cid = calendarId ?? getDefaultCalendarId();

  const dayStart = new Date(`${dateStr}T00:00:00`);
  const dayEnd = new Date(`${dateStr}T23:59:59`);

  const events = await listEvents({
    calendarId: cid,
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
