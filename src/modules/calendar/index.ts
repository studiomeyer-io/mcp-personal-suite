/**
 * Calendar Module — 11 MCP tools for calendar management
 *
 * 1 status tool + 6 event management + 2 calendar management + 2 smart features.
 * Supports two providers:
 *   - Google Calendar (OAuth2 / Service Account)
 *   - CalDAV (any CalDAV server: iCloud, Nextcloud, mailbox.org, Posteo, Radicale, etc.)
 *
 * The provider is determined by config.calendar.provider. All 11 tools work
 * identically regardless of provider — the routing is transparent to the user.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  listEvents as googleListEvents,
  getEvent as googleGetEvent,
  createEvent as googleCreateEvent,
  updateEvent as googleUpdateEvent,
  deleteEvent as googleDeleteEvent,
  searchEvents as googleSearchEvents,
  listCalendars as googleListCalendars,
  checkAvailability as googleCheckAvailability,
  getUpcoming as googleGetUpcoming,
  getDailySummary as googleGetDailySummary,
} from './google-calendar.js';
import {
  caldavListEvents,
  caldavGetEvent,
  caldavCreateEvent,
  caldavUpdateEvent,
  caldavDeleteEvent,
  caldavSearchEvents,
  caldavListCalendars,
  caldavCheckAvailability,
  caldavGetUpcoming,
  caldavGetDailySummary,
} from './caldav-calendar.js';
import { loadConfig as loadSuiteConfig } from '../../lib/config.js';

// ─── Provider Detection ─────────────────────────

async function getProvider(): Promise<'google' | 'caldav'> {
  const config = await loadSuiteConfig();
  return config.calendar?.provider ?? 'google';
}

async function isCalDav(): Promise<boolean> {
  return (await getProvider()) === 'caldav';
}

// ─── Response Helpers ───────────────────────────

interface ToolResponse {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function jsonResponse(result: unknown, isError?: boolean): ToolResponse {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    ...(isError !== undefined ? { isError } : {}),
  };
}

function errorResponse(message: string, code?: string): ToolResponse {
  // Auto-detect NOT_CONFIGURED from credential/config error messages
  if (!code && /no .+ credentials|not configured|missing credentials/i.test(message)) {
    code = 'NOT_CONFIGURED';
  }
  return jsonResponse({ error: message, code: code ?? 'INTERNAL_ERROR' }, true);
}

// ─── Tool Registration ──────────────────────────

export function registerCalendarTools(server: McpServer): void {
  // ═══════════════════════════════════════════════
  // STATUS (1)
  // ═══════════════════════════════════════════════

  // 1. calendar_status
  server.tool(
    'calendar_status',
    'Check calendar configuration status. Supports Google Calendar and CalDAV (iCloud, Nextcloud, mailbox.org, etc.). Call this first to see if calendar is set up.',
    {},
    async () => {
      // Check tenant config first, fall back to env vars
      const suiteConfig = await loadSuiteConfig();
      const provider = suiteConfig.calendar?.provider;

      let hasCredentials = false;
      let onboardingHint = '';

      if (provider === 'caldav') {
        hasCredentials = !!(
          suiteConfig.calendar?.caldav?.url &&
          suiteConfig.calendar?.caldav?.username &&
          suiteConfig.calendar?.caldav?.password
        );
        onboardingHint = hasCredentials
          ? `CalDAV is connected (${suiteConfig.calendar!.caldav!.url}). I can show your agenda, create events, and find free time slots.`
          : 'CalDAV is not configured. Run suite_setup(module: "calendar", calendar_provider: "caldav", calendar_caldav_url: "https://...", calendar_caldav_username: "user", calendar_caldav_password: "pass").';
      } else {
        hasCredentials = !!(
          suiteConfig.calendar?.oauth?.clientId ||
          suiteConfig.calendar?.oauth?.accessToken ||
          process.env['GOOGLE_CALENDAR_CREDENTIALS'] ||
          process.env['GOOGLE_CLIENT_ID']
        );
        onboardingHint = hasCredentials
          ? 'Google Calendar is connected. I can show your agenda, create events, and find free time slots.'
          : 'Calendar is not connected yet. Choose a provider:\n' +
            '- Google: suite_setup(module: "calendar", calendar_oauth_client_id: "...", calendar_oauth_client_secret: "...")\n' +
            '- CalDAV (iCloud, Nextcloud, etc.): suite_setup(module: "calendar", calendar_provider: "caldav", calendar_caldav_url: "https://...", calendar_caldav_username: "user", calendar_caldav_password: "pass")';
      }

      const setupRequired: string[] = [];
      if (!hasCredentials) setupRequired.push(provider === 'caldav' ? 'caldav_auth' : 'google_calendar_auth');

      return jsonResponse({
        configured: hasCredentials,
        provider: provider ?? 'none',
        setupRequired,
        capabilities: [
          'List events',
          'Create events',
          'Update events',
          'Delete events',
          'Search events',
          'Check availability',
          'Daily summary',
          'List calendars',
        ],
        onboardingHint,
      });
    },
  );

  // ═══════════════════════════════════════════════
  // EVENT MANAGEMENT (6)
  // ═══════════════════════════════════════════════

  // 2. calendar_list_events
  server.tool(
    'calendar_list_events',
    'List calendar events within a date range. Defaults to next 7 days. Supports calendar filtering.',
    {
      timeMin: z.string().min(1).max(100).optional().describe('Start of time range (ISO 8601, e.g. 2026-03-17T00:00:00+01:00). Default: now'),
      timeMax: z.string().min(1).max(100).optional().describe('End of time range (ISO 8601). Default: 7 days from now'),
      maxResults: z.coerce.number().min(1).max(250).optional().describe('Max events to return (default: 50)'),
      calendarId: z.string().min(1).max(500).optional().describe('Calendar ID (default: primary)'),
      query: z.string().min(1).max(500).optional().describe('Free-text filter on event fields'),
    },
    async (args) => {
      try {
        const events = (await isCalDav()) ? await caldavListEvents(args) : await googleListEvents(args);
        const formatted = events.map((e) => {
          const time = e.allDay ? 'all-day' : `${e.start} → ${e.end}`;
          const loc = e.location ? ` @ ${e.location}` : '';
          return `${time} | ${e.summary}${loc}`;
        });
        return jsonResponse({
          success: true,
          data: { events, total: events.length },
          formatted: formatted.join('\n'),
          message: `${events.length} events found.`,
        });
      } catch (error) {
        return errorResponse(error instanceof Error ? error.message : String(error));
      }
    },
  );

  // 3. calendar_get_event
  server.tool(
    'calendar_get_event',
    'Get a single calendar event with full details (description, attendees, location, etc.).',
    {
      eventId: z.string().min(1).max(500).describe('Event ID'),
      calendarId: z.string().min(1).max(500).optional().describe('Calendar ID (default: primary)'),
    },
    async (args) => {
      try {
        const event = (await isCalDav())
          ? await caldavGetEvent(args.eventId, args.calendarId)
          : await googleGetEvent(args.eventId, args.calendarId);
        if (!event) {
          return errorResponse('Event not found', 'NOT_FOUND');
        }
        return jsonResponse({ success: true, data: event });
      } catch (error) {
        return errorResponse(error instanceof Error ? error.message : String(error));
      }
    },
  );

  // 4. calendar_create_event
  server.tool(
    'calendar_create_event',
    'Create a new calendar event. Supports title, start/end time, description, location, attendees, recurrence. Google Meet links available with Google provider. Automatically checks for conflicts before creating.',
    {
      summary: z.string().min(1).max(500).describe('Event title'),
      start: z.string().min(1).max(100).describe('Start time (ISO 8601, e.g. 2026-03-18T10:00:00+01:00)'),
      end: z.string().min(1).max(100).describe('End time (ISO 8601, e.g. 2026-03-18T11:00:00+01:00)'),
      description: z.string().max(10000).optional().describe('Event description'),
      location: z.string().max(500).optional().describe('Event location'),
      attendees: z.array(z.string().email()).max(50).optional().describe('Attendee email addresses'),
      timeZone: z.string().max(100).optional().describe('Time zone (default: Europe/Berlin)'),
      calendarId: z.string().min(1).max(500).optional().describe('Calendar ID (default: primary)'),
      recurrence: z.string().max(500).optional().describe('Recurrence rule: "daily", "weekly", "monthly", "yearly", or custom RRULE string (e.g. "RRULE:FREQ=WEEKLY;BYDAY=MO")'),
      addMeetLink: z.boolean().optional().describe('Auto-generate a Google Meet link for this event'),
    },
    async (args) => {
      try {
        const createFn = (await isCalDav()) ? caldavCreateEvent : googleCreateEvent;
        const { event, conflicts } = await createFn({
          summary: args.summary,
          start: args.start,
          end: args.end,
          description: args.description,
          location: args.location,
          attendees: args.attendees,
          timeZone: args.timeZone,
          recurrence: args.recurrence,
          addMeetLink: args.addMeetLink,
        }, args.calendarId);

        let message = `Event created: "${event.summary}" (${event.start} → ${event.end})`;
        if (conflicts.length > 0) {
          const conflictList = conflicts.map(
            (c) => `Warning: Conflict with: ${c.eventName} at ${c.eventTime}`
          ).join('\n');
          message += `\n\n${conflictList}`;
        }

        return jsonResponse({
          success: true,
          data: event,
          conflicts,
          message,
        });
      } catch (error) {
        return errorResponse(error instanceof Error ? error.message : String(error));
      }
    },
  );

  // 5. calendar_update_event
  server.tool(
    'calendar_update_event',
    'Update an existing calendar event. Only provided fields will be changed.',
    {
      eventId: z.string().min(1).max(500).describe('Event ID to update'),
      summary: z.string().min(1).max(500).optional().describe('New title'),
      start: z.string().min(1).max(100).optional().describe('New start time (ISO 8601)'),
      end: z.string().min(1).max(100).optional().describe('New end time (ISO 8601)'),
      description: z.string().max(10000).optional().describe('New description'),
      location: z.string().max(500).optional().describe('New location'),
      attendees: z.array(z.string().email()).max(50).optional().describe('New attendee list (replaces existing)'),
      timeZone: z.string().max(100).optional().describe('Time zone (default: Europe/Berlin)'),
      calendarId: z.string().min(1).max(500).optional().describe('Calendar ID (default: primary)'),
    },
    async (args) => {
      try {
        const updateFn = (await isCalDav()) ? caldavUpdateEvent : googleUpdateEvent;
        const event = await updateFn({
          eventId: args.eventId,
          summary: args.summary,
          start: args.start,
          end: args.end,
          description: args.description,
          location: args.location,
          attendees: args.attendees,
          timeZone: args.timeZone,
        }, args.calendarId);
        return jsonResponse({
          success: true,
          data: event,
          message: `Event updated: "${event.summary}"`,
        });
      } catch (error) {
        return errorResponse(error instanceof Error ? error.message : String(error));
      }
    },
  );

  // 6. calendar_delete_event
  server.tool(
    'calendar_delete_event',
    'Delete a calendar event. Sends cancellation notice to attendees.',
    {
      eventId: z.string().min(1).max(500).describe('Event ID to delete'),
      calendarId: z.string().min(1).max(500).optional().describe('Calendar ID (default: primary)'),
    },
    async (args) => {
      try {
        const deleteFn = (await isCalDav()) ? caldavDeleteEvent : googleDeleteEvent;
        await deleteFn(args.eventId, args.calendarId);
        return jsonResponse({
          success: true,
          message: `Event ${args.eventId} deleted.`,
        });
      } catch (error) {
        return errorResponse(error instanceof Error ? error.message : String(error));
      }
    },
  );

  // 7. calendar_search_events
  server.tool(
    'calendar_search_events',
    'Full-text search across event titles, descriptions, and locations. Searches 1 year back and forward.',
    {
      query: z.string().min(1).max(500).describe('Search query'),
      maxResults: z.coerce.number().min(1).max(100).optional().describe('Max results (default: 20)'),
      calendarId: z.string().min(1).max(500).optional().describe('Calendar ID (default: primary)'),
    },
    async (args) => {
      try {
        const searchFn = (await isCalDav()) ? caldavSearchEvents : googleSearchEvents;
        const events = await searchFn(args.query, args.maxResults, args.calendarId);
        const formatted = events.map((e) => {
          const time = e.allDay ? 'all-day' : `${e.start} → ${e.end}`;
          return `${time} | ${e.summary}`;
        });
        return jsonResponse({
          success: true,
          data: { events, total: events.length, query: args.query },
          formatted: formatted.join('\n'),
          message: `${events.length} events matching "${args.query}".`,
        });
      } catch (error) {
        return errorResponse(error instanceof Error ? error.message : String(error));
      }
    },
  );

  // ═══════════════════════════════════════════════
  // CALENDAR MANAGEMENT (2)
  // ═══════════════════════════════════════════════

  // 8. calendar_list_calendars
  server.tool(
    'calendar_list_calendars',
    'List all calendars accessible to the authenticated user with their IDs, names, and access roles.',
    {},
    async () => {
      try {
        const listFn = (await isCalDav()) ? caldavListCalendars : googleListCalendars;
        const calendars = await listFn();
        const formatted = calendars.map((c) => {
          const primary = c.primary ? ' [PRIMARY]' : '';
          return `${c.id} | ${c.summary}${primary} | ${c.accessRole} | tz: ${c.timeZone ?? 'n/a'}`;
        });
        return jsonResponse({
          success: true,
          data: { calendars, total: calendars.length },
          formatted: formatted.join('\n'),
          message: `${calendars.length} calendars found.`,
        });
      } catch (error) {
        return errorResponse(error instanceof Error ? error.message : String(error));
      }
    },
  );

  // 9. calendar_check_availability
  server.tool(
    'calendar_check_availability',
    'Find free time slots on a given day. Useful for meeting planning — returns available slots with minimum duration.',
    {
      date: z.string().min(1).max(20).describe('Date to check (YYYY-MM-DD)'),
      durationMinutes: z.coerce.number().min(15).max(480).optional().describe('Minimum slot duration in minutes (default: 30)'),
      startHour: z.coerce.number().min(0).max(23).optional().describe('Business day start hour (default: 9)'),
      endHour: z.coerce.number().min(1).max(24).optional().describe('Business day end hour (default: 18)'),
      calendarId: z.string().min(1).max(500).optional().describe('Calendar ID (default: primary)'),
    },
    async (args) => {
      try {
        const availFn = (await isCalDav()) ? caldavCheckAvailability : googleCheckAvailability;
        const slots = await availFn(
          args.date,
          args.durationMinutes ?? 30,
          args.startHour ?? 9,
          args.endHour ?? 18,
          args.calendarId,
        );
        const formatted = slots.map((s) => {
          const start = new Date(s.start).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
          const end = new Date(s.end).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
          return `${start} - ${end} (${s.durationMinutes} min)`;
        });
        return jsonResponse({
          success: true,
          data: { date: args.date, slots, total: slots.length },
          formatted: formatted.length > 0 ? formatted.join('\n') : 'No free slots found.',
          message: `${slots.length} free slot(s) on ${args.date}.`,
        });
      } catch (error) {
        return errorResponse(error instanceof Error ? error.message : String(error));
      }
    },
  );

  // ═══════════════════════════════════════════════
  // SMART FEATURES (2)
  // ═══════════════════════════════════════════════

  // 10. calendar_upcoming
  server.tool(
    'calendar_upcoming',
    'Quick view: next N events from now. Default: 5 events. Fast overview of what is coming up.',
    {
      count: z.coerce.number().min(1).max(25).optional().describe('Number of events (default: 5)'),
      calendarId: z.string().min(1).max(500).optional().describe('Calendar ID (default: primary)'),
    },
    async (args) => {
      try {
        const upcomingFn = (await isCalDav()) ? caldavGetUpcoming : googleGetUpcoming;
        const events = await upcomingFn(args.count ?? 5, args.calendarId);
        const formatted = events.map((e, i) => {
          const time = e.allDay ? 'all-day' : `${e.start} → ${e.end}`;
          const loc = e.location ? ` @ ${e.location}` : '';
          return `${i + 1}. ${time} | ${e.summary}${loc}`;
        });
        return jsonResponse({
          success: true,
          data: { events, total: events.length },
          formatted: formatted.length > 0 ? formatted.join('\n') : 'No upcoming events.',
          message: events.length > 0 ? `Next ${events.length} event(s):` : 'Calendar is clear!',
        });
      } catch (error) {
        return errorResponse(error instanceof Error ? error.message : String(error));
      }
    },
  );

  // 11. calendar_daily_summary
  server.tool(
    'calendar_daily_summary',
    'Full day overview with AI context: all events, busy/free time analysis, first/last event times. Great for daily planning.',
    {
      date: z.string().min(1).max(20).optional().describe('Date (YYYY-MM-DD). Default: today'),
      calendarId: z.string().min(1).max(500).optional().describe('Calendar ID (default: primary)'),
    },
    async (args) => {
      try {
        const date = args.date ?? new Date().toISOString().split('T')[0];
        const summaryFn = (await isCalDav()) ? caldavGetDailySummary : googleGetDailySummary;
        const summary = await summaryFn(date, args.calendarId);

        const lines: string[] = [
          `Date: ${summary.date}`,
          `Total events: ${summary.totalEvents}`,
          `Busy: ${summary.busyMinutes} min | Free: ${summary.freeMinutes} min (of 8h work day)`,
        ];

        if (summary.firstEvent) {
          lines.push(`First event: ${summary.firstEvent}`);
        }
        if (summary.lastEvent) {
          lines.push(`Last event: ${summary.lastEvent}`);
        }

        if (summary.allDayEvents.length > 0) {
          lines.push('', 'All-day:');
          for (const e of summary.allDayEvents) {
            lines.push(`  - ${e.summary}`);
          }
        }

        if (summary.timedEvents.length > 0) {
          lines.push('', 'Schedule:');
          for (const e of summary.timedEvents) {
            const loc = e.location ? ` @ ${e.location}` : '';
            lines.push(`  - ${e.start} → ${e.end} | ${e.summary}${loc}`);
          }
        }

        return jsonResponse({
          success: true,
          data: summary,
          formatted: lines.join('\n'),
          message: `Daily summary for ${summary.date}: ${summary.totalEvents} events, ${summary.busyMinutes} min busy.`,
        });
      } catch (error) {
        return errorResponse(error instanceof Error ? error.message : String(error));
      }
    },
  );
}
