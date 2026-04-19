/**
 * Email Core — IMAP read (ImapFlow) + SMTP send (nodemailer). Zero database.
 *
 * Supports Gmail OAuth2, Outlook OAuth2, and generic IMAP/SMTP.
 * Attachments up to 25MB. Thread-aware replies.
 * Connection pooling for IMAP with idle timeout cleanup.
 *
 * Migrated from `imap` (callback-based, unmaintained since 2017)
 * to `imapflow` (async/await, actively maintained, MIT).
 */

import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  loadConfig,
  getImapConfig,
  getSmtpConfig,
  getValidAccessToken,
  type OAuthConfig,
} from './oauth2.js';
import { logger } from '../../lib/logger.js';
import { getCurrentTenantId } from '../../lib/tenant-storage.js';

// ─── HTML-to-Text Fallback ──────────────────────

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

/** Escape HTML special characters to prevent XSS in generated HTML */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Security: Attachment Path Validation ─────────

const ALLOWED_ATTACHMENT_DIRS = ['/tmp/', '/home/', '/var/tmp/'];
const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024; // 25MB

function validateAttachmentPath(filePath: string): { valid: boolean; error?: string } {
  try {
    const resolved = realpathSync(resolve(filePath));
    const allowed = ALLOWED_ATTACHMENT_DIRS.some(dir => resolved.startsWith(dir));
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

// ─── Types ───────────────────────────────────────

export interface EmailMessage {
  uid: number;
  messageId: string;
  from: string;
  fromName: string;
  to: string;
  cc?: string;
  subject: string;
  date: string;
  textBody: string;
  htmlBody?: string;
  inReplyTo?: string;
  references?: string[];
  attachments: Array<{ filename: string; size: number; contentType: string }>;
  flags: string[];
  folder: string;
}

export interface SendInput {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: Array<{ path: string; filename?: string }>;
  from?: string;
}

export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

// ─── IMAP Connection Pool (ImapFlow) ────────────

interface PooledConnection {
  client: ImapFlow;
  lastUsed: number;
  inUse: boolean;
  tenantKey: string;
  alive: boolean;
}

const imapPool: PooledConnection[] = [];
const POOL_MAX_SIZE = 3;
const POOL_IDLE_TIMEOUT = 30_000; // 30 seconds
const MAX_RECONNECT_RETRIES = 3;
const RECONNECT_BASE_DELAY = 1000; // 1s, 2s, 4s exponential backoff

function removeFromPool(client: ImapFlow): void {
  const idx = imapPool.findIndex(c => c.client === client);
  if (idx !== -1) {
    imapPool[idx].alive = false;
    imapPool.splice(idx, 1);
  }
}

function cleanPool(): void {
  const now = Date.now();
  for (let i = imapPool.length - 1; i >= 0; i--) {
    const conn = imapPool[i];
    if (!conn.alive) {
      imapPool.splice(i, 1);
      continue;
    }
    if (!conn.inUse && now - conn.lastUsed > POOL_IDLE_TIMEOUT) {
      conn.alive = false;
      conn.client.logout().catch(() => { /* ignore */ });
      imapPool.splice(i, 1);
    }
  }
}

// Clean pool every 15 seconds
const poolCleanupInterval = setInterval(cleanPool, 15_000);
poolCleanupInterval.unref();

async function createImapFlowClient(config: OAuthConfig, accessToken?: string): Promise<ImapFlow> {
  const imapCfg = getImapConfig(config);

  const auth: { user: string; pass?: string; accessToken?: string } = { user: imapCfg.user };
  if (imapCfg.auth === 'oauth2' && accessToken) {
    auth.accessToken = accessToken;
  } else {
    auth.pass = imapCfg.password ?? '';
  }

  const client = new ImapFlow({
    host: imapCfg.host,
    port: imapCfg.port,
    secure: true,
    auth,
    logger: false as unknown as import('imapflow').Logger,
    tls: { rejectUnauthorized: true },
    connectionTimeout: 15_000,
  });

  client.on('error', (err: Error) => {
    logger.logError('IMAP connection error', err);
    removeFromPool(client);
  });

  client.on('close', () => {
    removeFromPool(client);
  });

  await client.connect();
  return client;
}

async function acquireImapConnection(
  config: OAuthConfig,
  accessToken?: string,
): Promise<{ client: ImapFlow; release: () => void }> {
  cleanPool();

  const tenantKey = getCurrentTenantId() || '_default';

  // Try to reuse an idle connection belonging to this tenant
  const idle = imapPool.find(c => !c.inUse && c.alive && c.tenantKey === tenantKey);
  if (idle) {
    idle.inUse = true;
    idle.lastUsed = Date.now();
    return {
      client: idle.client,
      release: () => { idle.inUse = false; idle.lastUsed = Date.now(); },
    };
  }

  // Create new connection with retry logic
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < MAX_RECONNECT_RETRIES; attempt++) {
    try {
      const client = await createImapFlowClient(config, accessToken);
      const poolEntry: PooledConnection = {
        client,
        lastUsed: Date.now(),
        inUse: true,
        tenantKey,
        alive: true,
      };

      if (imapPool.length < POOL_MAX_SIZE) {
        imapPool.push(poolEntry);
        return {
          client,
          release: () => { poolEntry.inUse = false; poolEntry.lastUsed = Date.now(); },
        };
      }

      // Pool full — return non-pooled connection
      return {
        client,
        release: () => { client.logout().catch(() => { /* ignore */ }); },
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RECONNECT_RETRIES - 1) {
        const delay = RECONNECT_BASE_DELAY * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw lastError ?? new Error('Failed to connect to IMAP after retries');
}

// ─── IMAP Operations (ImapFlow) ─────────────────

async function fetchMessages(client: ImapFlow, uids: number[], folder: string): Promise<EmailMessage[]> {
  if (uids.length === 0) return [];

  const messages: EmailMessage[] = [];
  const lock = await client.getMailboxLock(folder);

  try {
    for (const uid of uids) {
      try {
        const msg = await client.fetchOne(String(uid), { source: true, flags: true }, { uid: true });
        if (!msg) continue;
        if (!msg.source) continue;

        const parsed: ParsedMail = await simpleParser(msg.source);

        messages.push({
          uid,
          messageId: parsed.messageId ?? '',
          from: parsed.from?.value[0]?.address ?? '',
          fromName: parsed.from?.value[0]?.name ?? parsed.from?.value[0]?.address ?? '',
          to: parsed.to
            ? (Array.isArray(parsed.to)
              ? parsed.to.map((a: { text: string }) => a.text).join(', ')
              : parsed.to.text)
            : '',
          cc: parsed.cc
            ? (Array.isArray(parsed.cc)
              ? parsed.cc.map((a: { text: string }) => a.text).join(', ')
              : parsed.cc.text)
            : undefined,
          subject: parsed.subject ?? '(no subject)',
          date: parsed.date?.toISOString() ?? new Date().toISOString(),
          textBody: parsed.text ?? (parsed.html ? stripHtml(parsed.html) : ''),
          htmlBody: parsed.html || undefined,
          inReplyTo: parsed.inReplyTo,
          references: parsed.references
            ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references])
            : undefined,
          attachments: (parsed.attachments ?? []).map((a: { filename?: string; size: number; contentType: string }) => ({
            filename: a.filename ?? 'unnamed',
            size: a.size,
            contentType: a.contentType,
          })),
          flags: msg.flags ? [...msg.flags].map(String) : [],
          folder,
        });
      } catch (err) {
        logger.logError(`Failed to fetch/parse email UID ${uid}`, err);
      }
    }
  } finally {
    lock.release();
  }

  return messages;
}

export async function listEmails(
  folder = 'INBOX',
  options: { limit?: number; unseen?: boolean; search?: string } = {},
): Promise<{ emails: EmailMessage[]; total: number }> {
  const config = loadConfig();
  if (!config) throw new Error('Email not configured. Use email_setup first.');

  const accessToken = config.provider !== 'imap' ? await getValidAccessToken(config) : undefined;
  const { client, release } = await acquireImapConnection(config, accessToken);

  try {
    const lock = await client.getMailboxLock(folder);
    let uids: number[];

    try {
      // Build search query
      const searchQuery: Record<string, unknown> = {};
      if (options.unseen) searchQuery.seen = false;
      if (options.search) {
        searchQuery.or = [
          { subject: options.search },
          { from: options.search },
        ];
      }

      // If no criteria, search all
      const hasQuery = Object.keys(searchQuery).length > 0;
      uids = await client.search(hasQuery ? searchQuery : { all: true }, { uid: true }) as unknown as number[];
    } finally {
      lock.release();
    }

    const total = uids.length;
    const limit = options.limit ?? 20;
    const sliced = uids.slice(-limit).reverse(); // Newest first

    if (sliced.length === 0) {
      release();
      return { emails: [], total };
    }

    const emails = await fetchMessages(client, sliced, folder);
    release();
    return { emails, total };
  } catch (err) {
    release();
    throw err;
  }
}

export async function readEmail(uid: number, folder = 'INBOX'): Promise<EmailMessage | null> {
  const config = loadConfig();
  if (!config) throw new Error('Email not configured');

  const accessToken = config.provider !== 'imap' ? await getValidAccessToken(config) : undefined;
  const { client, release } = await acquireImapConnection(config, accessToken);

  try {
    const msgs = await fetchMessages(client, [uid], folder);
    release();
    return msgs[0] ?? null;
  } catch (err) {
    release();
    throw err;
  }
}

export async function searchEmails(query: string, folder = 'INBOX', limit = 20): Promise<EmailMessage[]> {
  const result = await listEmails(folder, { search: query, limit });
  return result.emails;
}

export async function listFolders(): Promise<Array<{ name: string; delimiter: string; children?: string[] }>> {
  const config = loadConfig();
  if (!config) throw new Error('Email not configured');

  const accessToken = config.provider !== 'imap' ? await getValidAccessToken(config) : undefined;
  const { client, release } = await acquireImapConnection(config, accessToken);

  try {
    const mailboxes = await client.list();
    release();

    const folders: Array<{ name: string; delimiter: string; children?: string[] }> = [];

    for (const box of mailboxes) {
      const entry: { name: string; delimiter: string; children?: string[] } = {
        name: box.path,
        delimiter: box.delimiter || '/',
      };

      // Check for child mailboxes
      const children = mailboxes.filter(
        m => m.path !== box.path && m.path.startsWith(box.path + (box.delimiter || '/'))
          && !m.path.slice(box.path.length + 1).includes(box.delimiter || '/'),
      );
      if (children.length > 0) {
        entry.children = children.map(c => c.path);
      }

      folders.push(entry);
    }

    return folders;
  } catch (err) {
    release();
    throw err;
  }
}

export async function moveEmail(uid: number, fromFolder: string, toFolder: string): Promise<boolean> {
  const config = loadConfig();
  if (!config) throw new Error('Email not configured');

  const accessToken = config.provider !== 'imap' ? await getValidAccessToken(config) : undefined;
  const { client, release } = await acquireImapConnection(config, accessToken);

  const lock = await client.getMailboxLock(fromFolder);
  try {
    await client.messageMove(String(uid), toFolder, { uid: true });
    release();
    return true;
  } catch (err) {
    release();
    throw err;
  } finally {
    lock.release();
  }
}

// ─── SMTP Operations ─────────────────────────────

// Per-tenant transporter cache (keyed by tenantId, or '_default' for stdio mode)
const transporterCache = new Map<string, Transporter>();

/** Clear cached SMTP transporter (call after config changes). */
export function invalidateTransporterCache(): void {
  const key = getCurrentTenantId() || '_default';
  transporterCache.delete(key);
}

async function getTransporter(): Promise<Transporter> {
  const config = loadConfig();
  if (!config) throw new Error('Email not configured');

  const smtpCfg = getSmtpConfig(config);

  if (smtpCfg.auth === 'oauth2') {
    const accessToken = await getValidAccessToken(config);
    return nodemailer.createTransport({
      host: smtpCfg.host,
      port: smtpCfg.port,
      secure: smtpCfg.port === 465,
      auth: {
        type: 'OAuth2',
        user: smtpCfg.user,
        accessToken,
      },
    } as nodemailer.TransportOptions);
  }

  const cacheKey = getCurrentTenantId() || '_default';
  const cached = transporterCache.get(cacheKey);
  if (cached) return cached;

  const transporter = nodemailer.createTransport({
    host: smtpCfg.host,
    port: smtpCfg.port,
    secure: smtpCfg.port === 465,
    auth: { user: smtpCfg.user, pass: smtpCfg.password ?? '' },
  });
  transporterCache.set(cacheKey, transporter);

  return transporter;
}

export async function sendEmail(input: SendInput): Promise<SendResult> {
  try {
    const config = loadConfig();
    if (!config) return { success: false, error: 'Email not configured' };

    // Validate attachment paths (prevent path traversal / exfiltration)
    if (input.attachments) {
      for (const att of input.attachments) {
        const check = validateAttachmentPath(att.path);
        if (!check.valid) return { success: false, error: `Attachment rejected: ${check.error}` };
      }
    }

    const transporter = await getTransporter();

    const mailOptions: nodemailer.SendMailOptions = {
      from: input.from ?? config.email,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      text: input.text,
      html: input.html,
      replyTo: input.replyTo,
      inReplyTo: input.inReplyTo,
      references: input.references?.join(' '),
      attachments: input.attachments?.map(a => ({
        path: realpathSync(resolve(a.path)),
        filename: a.filename,
      })),
    };

    const result = await transporter.sendMail(mailOptions);
    return { success: true, messageId: result.messageId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.logError('Send email failed', err);
    return { success: false, error: msg };
  }
}

// ─── IMAP Flag Operations (ImapFlow) ────────────

export async function setEmailFlags(uid: number, folder: string, flags: string[], add: boolean): Promise<boolean> {
  const config = loadConfig();
  if (!config) throw new Error('Email not configured');

  const accessToken = config.provider !== 'imap' ? await getValidAccessToken(config) : undefined;
  const { client, release } = await acquireImapConnection(config, accessToken);

  const lock = await client.getMailboxLock(folder);
  try {
    if (add) {
      await client.messageFlagsAdd(String(uid), flags, { uid: true });
    } else {
      await client.messageFlagsRemove(String(uid), flags, { uid: true });
    }
    release();
    return true;
  } catch (err) {
    release();
    throw err;
  } finally {
    lock.release();
  }
}

export async function deleteEmail(uid: number, folder: string): Promise<boolean> {
  const config = loadConfig();
  if (!config) throw new Error('Email not configured');

  // Provider-aware Trash folder detection
  const trashFolder = config.provider === 'gmail'
    ? '[Gmail]/Trash'
    : config.provider === 'outlook'
      ? 'Deleted Items'
      : 'Trash';

  return moveEmail(uid, folder, trashFolder);
}

export async function forwardEmail(
  uid: number,
  to: string,
  options: { folder?: string; text?: string; attachments?: Array<{ path: string; filename?: string }> } = {},
): Promise<SendResult> {
  const original = await readEmail(uid, options.folder ?? 'INBOX');
  if (!original) return { success: false, error: `Email UID ${uid} not found` };

  const fwdBody = options.text
    ? `${options.text}\n\n---------- Forwarded message ----------\nFrom: ${original.fromName} <${original.from}>\nDate: ${original.date}\nSubject: ${original.subject}\nTo: ${original.to}\n\n${original.textBody}`
    : `---------- Forwarded message ----------\nFrom: ${original.fromName} <${original.from}>\nDate: ${original.date}\nSubject: ${original.subject}\nTo: ${original.to}\n\n${original.textBody}`;

  const fwdHtml = original.htmlBody
    ? `${options.text ? `<p>${escapeHtml(options.text)}</p><hr>` : ''}<div style="padding-left:1em;border-left:2px solid #ccc"><p><b>---------- Forwarded message ----------</b><br>From: ${escapeHtml(original.fromName)} &lt;${escapeHtml(original.from)}&gt;<br>Date: ${escapeHtml(original.date)}<br>Subject: ${escapeHtml(original.subject)}<br>To: ${escapeHtml(original.to)}</p>${original.htmlBody}</div>`
    : undefined;

  return sendEmail({
    to,
    subject: original.subject.startsWith('Fwd:') ? original.subject : `Fwd: ${original.subject}`,
    text: fwdBody,
    html: fwdHtml,
    attachments: options.attachments,
  });
}

export async function replyToEmail(uid: number, text: string, options: { html?: string; folder?: string; attachments?: Array<{ path: string; filename?: string }> } = {}): Promise<SendResult> {
  const original = await readEmail(uid, options.folder ?? 'INBOX');
  if (!original) return { success: false, error: `Email UID ${uid} not found` };

  const refs = original.references ?? [];
  if (original.messageId && !refs.includes(original.messageId)) refs.push(original.messageId);

  return sendEmail({
    to: original.from,
    subject: original.subject.startsWith('Re:') ? original.subject : `Re: ${original.subject}`,
    text,
    html: options.html,
    inReplyTo: original.messageId,
    references: refs,
    attachments: options.attachments,
  });
}
