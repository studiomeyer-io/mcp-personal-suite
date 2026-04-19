/**
 * Email Module — 15 MCP tools for full email management
 *
 * Gmail OAuth2 + Outlook OAuth2 + Generic IMAP/SMTP.
 * Send, receive, search, threads, attachments, folders.
 * Zero database required — uses IMAP directly.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  listEmails,
  readEmail,
  searchEmails,
  listFolders,
  sendEmail,
  replyToEmail,
  moveEmail,
  setEmailFlags,
  deleteEmail,
  forwardEmail,
  invalidateTransporterCache,
} from './email-client.js';
import {
  loadConfig,
  saveConfig,
  generateAuthUrl,
  exchangeCode,
  type OAuthConfig,
} from './oauth2.js';

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
  if (!code && /no .+ credentials|not configured|missing credentials|no email (provider|config)/i.test(message)) {
    code = 'NOT_CONFIGURED';
  }
  return jsonResponse({ error: message, code: code ?? 'INTERNAL_ERROR' }, true);
}

// ─── Tool Registration ──────────────────────────

export function registerEmailTools(server: McpServer): void {
  // ═══════════════════════════════════════════════
  // SETUP TOOLS (3)
  // ═══════════════════════════════════════════════

  // 1. email_status
  server.tool(
    'email_status',
    'Check email configuration status. Call this first to see if email is set up.',
    {},
    async () => {
const config = loadConfig();
      if (!config) {
        return jsonResponse({
          configured: false,
          message: 'Email not configured. Use email_setup to configure Gmail, Outlook, or IMAP.',
          providers: ['gmail', 'outlook', 'imap'],
        });
      }

      return jsonResponse({
        configured: true,
        provider: config.provider,
        email: config.email,
        hasOAuth: config.provider !== 'imap',
        hasAccessToken: !!config.accessToken,
        capabilities: {
          send: true,
          receive: true,
          search: true,
          threads: true,
          attachments: true,
          folders: true,
          move: true,
        },
      });
    },
  );

  // 2. email_setup
  server.tool(
    'email_setup',
    'Configure email provider. For Gmail/Outlook: provide clientId + clientSecret + refreshToken (from OAuth2 flow). For IMAP: provide host + user + password.',
    {
      provider: z.enum(['gmail', 'outlook', 'imap']).describe('Email provider'),
      email: z.string().email().describe('Email address'),
      clientId: z.string().optional().describe('OAuth2 Client ID (Gmail/Outlook)'),
      clientSecret: z.string().optional().describe('OAuth2 Client Secret (Gmail/Outlook)'),
      refreshToken: z.string().optional().describe('OAuth2 Refresh Token (Gmail/Outlook)'),
      imapHost: z.string().optional().describe('IMAP host (for generic IMAP)'),
      imapPort: z.number().optional().describe('IMAP port (default 993)'),
      imapUser: z.string().optional().describe('IMAP username'),
      imapPass: z.string().optional().describe('IMAP password'),
      smtpHost: z.string().optional().describe('SMTP host'),
      smtpPort: z.number().optional().describe('SMTP port (default 587)'),
      smtpUser: z.string().optional().describe('SMTP username'),
      smtpPass: z.string().optional().describe('SMTP password'),
    },
    async (args) => {
      const config: OAuthConfig = {
        provider: args.provider,
        email: args.email,
        clientId: args.clientId,
        clientSecret: args.clientSecret,
        refreshToken: args.refreshToken,
        imapHost: args.imapHost,
        imapPort: args.imapPort,
        imapUser: args.imapUser,
        imapPass: args.imapPass,
        smtpHost: args.smtpHost,
        smtpPort: args.smtpPort,
        smtpUser: args.smtpUser,
        smtpPass: args.smtpPass,
      };

      saveConfig(config);
      invalidateTransporterCache();

      return jsonResponse({
        success: true,
        provider: args.provider,
        email: args.email,
        message: `Email configured for ${args.provider}. Use email_status to verify.`,
      });
    },
  );

  // 3. email_auth
  server.tool(
    'email_auth',
    'Generate OAuth2 authorization URL or exchange authorization code for tokens. Step 1: action="url" to get the auth URL. Step 2: action="exchange" with the code from the redirect.',
    {
      action: z.enum(['url', 'exchange']).describe('"url" to generate auth URL, "exchange" to trade code for tokens'),
      provider: z.enum(['gmail', 'outlook']).describe('OAuth2 provider'),
      clientId: z.string().describe('OAuth2 Client ID'),
      clientSecret: z.string().optional().describe('OAuth2 Client Secret (required for exchange)'),
      redirectUri: z.string().optional().describe('Redirect URI (default: http://localhost:3000/oauth/callback)'),
      code: z.string().optional().describe('Authorization code (for exchange action)'),
    },
    async (args) => {
      const redirectUri = args.redirectUri ?? 'http://localhost:3000/oauth/callback';

      if (args.action === 'url') {
        const url = generateAuthUrl(args.provider, args.clientId, redirectUri);
        return jsonResponse({
          url,
          provider: args.provider,
          instructions: 'Open this URL in a browser, authorize access, then call email_auth with action="exchange" and the code from the redirect.',
        });
      }

      // Exchange
      if (!args.code) return errorResponse('Authorization code is required for exchange', 'MISSING_CODE');
      if (!args.clientSecret) return errorResponse('Client secret is required for exchange', 'MISSING_SECRET');

      try {
        const tokens = await exchangeCode(args.provider, args.code, args.clientId, args.clientSecret, redirectUri);

        // Auto-save tokens to config file (never leak to LLM context)
    const existingConfig = loadConfig();
        if (existingConfig) {
          existingConfig.accessToken = tokens.access_token;
          existingConfig.accessTokenExpiry = Date.now() + tokens.expires_in * 1000;
          if (tokens.refresh_token) existingConfig.refreshToken = tokens.refresh_token;
          saveConfig(existingConfig);
        }

        return jsonResponse({
          success: true,
          tokensSaved: true,
          expiresIn: tokens.expires_in,
          message: existingConfig
            ? 'Tokens saved to config automatically. Email is ready to use.'
            : 'Tokens obtained. Call email_setup first with provider + email + clientId + clientSecret, then exchange again.',
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResponse(`Token exchange failed: ${msg}`, 'EXCHANGE_FAILED');
      }
    },
  );

  // ═══════════════════════════════════════════════
  // READ TOOLS (5)
  // ═══════════════════════════════════════════════

  // 4. email_list
  server.tool(
    'email_list',
    'List emails from a folder. Returns subject, from, date, flags. Use email_read for full body.',
    {
      folder: z.string().optional().describe('Folder name (default: INBOX)'),
      limit: z.coerce.number().min(1).max(100).optional().describe('Max emails to return (default 20)'),
      unseen: z.boolean().optional().describe('Only unread emails'),
      search: z.string().optional().describe('Search in subject and sender'),
    },
    async (args) => {
      try {
        const result = await listEmails(args.folder ?? 'INBOX', {
          limit: args.limit ?? 20,
          unseen: args.unseen,
          search: args.search,
        });

        const summary = result.emails.map(e => ({
          uid: e.uid,
          from: e.fromName !== e.from ? `${e.fromName} <${e.from}>` : e.from,
          subject: e.subject,
          date: e.date,
          hasAttachments: e.attachments.length > 0,
          flags: e.flags,
        }));

        return jsonResponse({ emails: summary, total: result.total, folder: args.folder ?? 'INBOX', returned: summary.length });
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : String(err), 'LIST_FAILED');
      }
    },
  );

  // 5. email_read
  server.tool(
    'email_read',
    'Read a single email by UID. Returns full body, headers, and attachment info. Get UIDs from email_list first.',
    {
      uid: z.coerce.number().describe('Email UID (from email_list)'),
      folder: z.string().optional().describe('Folder name (default: INBOX)'),
    },
    async (args) => {
      try {
        const email = await readEmail(args.uid, args.folder ?? 'INBOX');
        if (!email) return errorResponse(`Email UID ${args.uid} not found`, 'NOT_FOUND');
        return jsonResponse(email);
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : String(err), 'READ_FAILED');
      }
    },
  );

  // 6. email_search
  server.tool(
    'email_search',
    'Search emails by subject or sender. Uses IMAP SEARCH — works with any provider.',
    {
      query: z.string().describe('Search term (matches subject and sender)'),
      folder: z.string().optional().describe('Folder to search (default: INBOX)'),
      limit: z.coerce.number().min(1).max(100).optional().describe('Max results (default 20)'),
    },
    async (args) => {
      try {
        const emails = await searchEmails(args.query, args.folder ?? 'INBOX', args.limit ?? 20);
        const summary = emails.map(e => ({
          uid: e.uid,
          from: e.fromName !== e.from ? `${e.fromName} <${e.from}>` : e.from,
          subject: e.subject,
          date: e.date,
          hasAttachments: e.attachments.length > 0,
        }));
        return jsonResponse({ results: summary, count: summary.length, query: args.query });
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : String(err), 'SEARCH_FAILED');
      }
    },
  );

  // 7. email_threads
  server.tool(
    'email_threads',
    'Get email threads — groups related emails by References/In-Reply-To headers. Shows conversation flow.',
    {
      folder: z.string().optional().describe('Folder (default: INBOX)'),
      limit: z.coerce.number().min(1).max(50).optional().describe('Max threads (default 10)'),
    },
    async (args) => {
      try {
        const result = await listEmails(args.folder ?? 'INBOX', { limit: 100 });

        // Group by thread (using In-Reply-To / References)
        const threads = new Map<string, typeof result.emails>();

        for (const email of result.emails) {
          const threadKey = email.inReplyTo ?? email.references?.[0] ?? email.messageId;
          if (!threads.has(threadKey)) threads.set(threadKey, []);
          threads.get(threadKey)!.push(email);
        }

        // Sort threads by latest message, take top N
        const sorted = Array.from(threads.entries())
          .map(([key, msgs]) => ({
            threadId: key,
            subject: msgs[0].subject,
            participants: [...new Set(msgs.map(m => m.from))],
            messageCount: msgs.length,
            latestDate: msgs[0].date,
            latestFrom: msgs[0].from,
            uids: msgs.map(m => m.uid),
          }))
          .sort((a, b) => new Date(b.latestDate).getTime() - new Date(a.latestDate).getTime())
          .slice(0, args.limit ?? 10);

        return jsonResponse({ threads: sorted, count: sorted.length });
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : String(err), 'THREADS_FAILED');
      }
    },
  );

  // 8. email_folders
  server.tool(
    'email_folders',
    'List all email folders/labels. Use folder names in other tools.',
    {},
    async () => {
      try {
        const folders = await listFolders();
        return jsonResponse({ folders, count: folders.length });
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : String(err), 'FOLDERS_FAILED');
      }
    },
  );

  // ═══════════════════════════════════════════════
  // WRITE TOOLS (7)
  // ═══════════════════════════════════════════════

  // 9. email_send
  server.tool(
    'email_send',
    'Send an email. Supports Gmail OAuth2, Outlook OAuth2, and SMTP. Can include attachments (file paths on disk, up to 25MB total).',
    {
      to: z.string().describe('Recipient email address'),
      subject: z.string().describe('Email subject'),
      text: z.string().describe('Plain text body'),
      html: z.string().optional().describe('HTML body (optional, overrides text in rich clients)'),
      cc: z.string().optional().describe('CC recipients (comma-separated)'),
      bcc: z.string().optional().describe('BCC recipients (comma-separated)'),
      replyTo: z.string().optional().describe('Reply-To address'),
      attachments: z.array(z.object({
        path: z.string().describe('Absolute file path on disk'),
        filename: z.string().optional().describe('Override filename in email'),
      })).optional().describe('File attachments (paths on disk)'),
    },
    async (args) => {
      const result = await sendEmail({
        to: args.to,
        subject: args.subject,
        text: args.text,
        html: args.html,
        cc: args.cc,
        bcc: args.bcc,
        replyTo: args.replyTo,
        attachments: args.attachments,
      });

      if (!result.success) return errorResponse(result.error ?? 'Send failed', 'SEND_FAILED');
      return jsonResponse({ success: true, messageId: result.messageId, to: args.to, subject: args.subject });
    },
  );

  // 10. email_reply
  server.tool(
    'email_reply',
    'Reply to an email by UID. Automatically sets In-Reply-To, References headers, and "Re:" subject prefix. Get UIDs from email_list.',
    {
      uid: z.coerce.number().describe('UID of the email to reply to (from email_list)'),
      text: z.string().describe('Reply text'),
      html: z.string().optional().describe('Reply HTML body'),
      folder: z.string().optional().describe('Folder where the original email is (default: INBOX)'),
      attachments: z.array(z.object({
        path: z.string(),
        filename: z.string().optional(),
      })).optional().describe('File attachments'),
    },
    async (args) => {
      const result = await replyToEmail(args.uid, args.text, {
        html: args.html,
        folder: args.folder,
        attachments: args.attachments,
      });

      if (!result.success) return errorResponse(result.error ?? 'Reply failed', 'REPLY_FAILED');
      return jsonResponse({ success: true, messageId: result.messageId, inReplyTo: args.uid });
    },
  );

  // 11. email_move
  server.tool(
    'email_move',
    'Move an email to a different folder (e.g., Archive, Trash, custom label). Use email_folders to discover available folders.',
    {
      uid: z.coerce.number().describe('Email UID to move'),
      from: z.string().optional().describe('Source folder (default: INBOX)'),
      to: z.string().describe('Destination folder (e.g., "[Gmail]/Trash", "Archive", "Important")'),
    },
    async (args) => {
      try {
        await moveEmail(args.uid, args.from ?? 'INBOX', args.to);
        return jsonResponse({ success: true, uid: args.uid, movedTo: args.to });
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : String(err), 'MOVE_FAILED');
      }
    },
  );

  // 12. email_mark_read
  server.tool(
    'email_mark_read',
    'Mark an email as read (sets \\Seen IMAP flag). Get UIDs from email_list.',
    {
      uid: z.coerce.number().describe('Email UID to mark as read'),
      folder: z.string().optional().describe('Folder (default: INBOX)'),
    },
    async (args) => {
      try {
        await setEmailFlags(args.uid, args.folder ?? 'INBOX', ['\\Seen'], true);
        return jsonResponse({ success: true, uid: args.uid, marked: 'read' });
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : String(err), 'FLAG_FAILED');
      }
    },
  );

  // 13. email_mark_unread
  server.tool(
    'email_mark_unread',
    'Mark an email as unread (removes \\Seen IMAP flag). Get UIDs from email_list.',
    {
      uid: z.coerce.number().describe('Email UID to mark as unread'),
      folder: z.string().optional().describe('Folder (default: INBOX)'),
    },
    async (args) => {
      try {
        await setEmailFlags(args.uid, args.folder ?? 'INBOX', ['\\Seen'], false);
        return jsonResponse({ success: true, uid: args.uid, marked: 'unread' });
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : String(err), 'FLAG_FAILED');
      }
    },
  );

  // 14. email_delete
  server.tool(
    'email_delete',
    'Delete an email (moves to Trash). Provider-aware: uses correct Trash folder for Gmail/Outlook/IMAP. Get UIDs from email_list.',
    {
      uid: z.coerce.number().describe('Email UID to delete'),
      folder: z.string().optional().describe('Source folder (default: INBOX)'),
    },
    async (args) => {
      try {
        await deleteEmail(args.uid, args.folder ?? 'INBOX');
        return jsonResponse({ success: true, uid: args.uid, action: 'moved to trash' });
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : String(err), 'DELETE_FAILED');
      }
    },
  );

  // 15. email_forward
  server.tool(
    'email_forward',
    'Forward an email to another address. Includes original message as quoted text. Get UIDs from email_list.',
    {
      uid: z.coerce.number().describe('Email UID to forward'),
      to: z.string().describe('Recipient email address'),
      text: z.string().optional().describe('Optional message to prepend before the forwarded content'),
      folder: z.string().optional().describe('Folder of the original email (default: INBOX)'),
      attachments: z.array(z.object({
        path: z.string().describe('Absolute file path on disk'),
        filename: z.string().optional().describe('Override filename'),
      })).optional().describe('Additional file attachments'),
    },
    async (args) => {
      const result = await forwardEmail(args.uid, args.to, {
        folder: args.folder,
        text: args.text,
        attachments: args.attachments,
      });
      if (!result.success) return errorResponse(result.error ?? 'Forward failed', 'FORWARD_FAILED');
      return jsonResponse({ success: true, messageId: result.messageId, forwardedTo: args.to });
    },
  );
}
