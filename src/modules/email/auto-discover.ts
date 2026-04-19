/**
 * Email Auto-Discovery — find IMAP/SMTP settings from just an email address.
 *
 * Strategy (in order):
 * 1. Well-known providers (Gmail, Outlook, Yahoo, iCloud, etc.)
 * 2. Mozilla ISPDB (Thunderbird autoconfig database, 30K+ providers)
 * 3. Common hostname patterns (mail.domain, imap.domain, smtp.domain)
 *
 * KMU-friendly: User enters email + password → we find everything else.
 */

import { logger } from '../../lib/logger.js';

export interface DiscoveredSettings {
  provider: 'gmail' | 'outlook' | 'imap';
  imap: { host: string; port: number; tls: boolean };
  smtp: { host: string; port: number; tls: boolean };
  displayName: string;
  requiresOAuth: boolean;
  oauthNote?: string;
}

// ─── Well-Known Providers ────────────────────────

const WELL_KNOWN: Record<string, DiscoveredSettings> = {
  'gmail.com': {
    provider: 'gmail',
    imap: { host: 'imap.gmail.com', port: 993, tls: true },
    smtp: { host: 'smtp.gmail.com', port: 465, tls: true },
    displayName: 'Gmail',
    requiresOAuth: true,
    oauthNote: 'Gmail requires OAuth2 or an App Password. Run suite_setup(module: "email", email_provider: "gmail") for OAuth flow, or use an App Password with IMAP.',
  },
  'googlemail.com': {
    provider: 'gmail',
    imap: { host: 'imap.gmail.com', port: 993, tls: true },
    smtp: { host: 'smtp.gmail.com', port: 465, tls: true },
    displayName: 'Gmail',
    requiresOAuth: true,
    oauthNote: 'Gmail requires OAuth2 or an App Password.',
  },
  'outlook.com': {
    provider: 'outlook',
    imap: { host: 'outlook.office365.com', port: 993, tls: true },
    smtp: { host: 'smtp.office365.com', port: 587, tls: true },
    displayName: 'Outlook',
    requiresOAuth: true,
    oauthNote: 'Outlook requires OAuth2. Run suite_setup(module: "email", email_provider: "outlook") for OAuth flow.',
  },
  'hotmail.com': {
    provider: 'outlook',
    imap: { host: 'outlook.office365.com', port: 993, tls: true },
    smtp: { host: 'smtp.office365.com', port: 587, tls: true },
    displayName: 'Outlook (Hotmail)',
    requiresOAuth: true,
    oauthNote: 'Outlook requires OAuth2.',
  },
  'live.com': {
    provider: 'outlook',
    imap: { host: 'outlook.office365.com', port: 993, tls: true },
    smtp: { host: 'smtp.office365.com', port: 587, tls: true },
    displayName: 'Outlook (Live)',
    requiresOAuth: true,
    oauthNote: 'Outlook requires OAuth2.',
  },
  'yahoo.com': {
    provider: 'imap',
    imap: { host: 'imap.mail.yahoo.com', port: 993, tls: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, tls: true },
    displayName: 'Yahoo Mail',
    requiresOAuth: false,
    oauthNote: 'Yahoo requires an App Password (not your regular password). Go to Account Security → Generate App Password.',
  },
  'icloud.com': {
    provider: 'imap',
    imap: { host: 'imap.mail.me.com', port: 993, tls: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, tls: true },
    displayName: 'iCloud Mail',
    requiresOAuth: false,
    oauthNote: 'iCloud requires an App-Specific Password. Go to appleid.apple.com → Sign-In and Security → App-Specific Passwords.',
  },
  'me.com': {
    provider: 'imap',
    imap: { host: 'imap.mail.me.com', port: 993, tls: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, tls: true },
    displayName: 'iCloud Mail',
    requiresOAuth: false,
  },
  // Deutsche Provider
  'web.de': {
    provider: 'imap',
    imap: { host: 'imap.web.de', port: 993, tls: true },
    smtp: { host: 'smtp.web.de', port: 587, tls: true },
    displayName: 'WEB.DE',
    requiresOAuth: false,
    oauthNote: 'WEB.DE: Aktiviere IMAP in den Einstellungen unter E-Mail → Postfach → POP3/IMAP.',
  },
  'gmx.de': {
    provider: 'imap',
    imap: { host: 'imap.gmx.net', port: 993, tls: true },
    smtp: { host: 'mail.gmx.net', port: 587, tls: true },
    displayName: 'GMX',
    requiresOAuth: false,
    oauthNote: 'GMX: Aktiviere IMAP in den Einstellungen unter E-Mail → Postfach → POP3/IMAP.',
  },
  'gmx.net': {
    provider: 'imap',
    imap: { host: 'imap.gmx.net', port: 993, tls: true },
    smtp: { host: 'mail.gmx.net', port: 587, tls: true },
    displayName: 'GMX',
    requiresOAuth: false,
  },
  't-online.de': {
    provider: 'imap',
    imap: { host: 'secureimap.t-online.de', port: 993, tls: true },
    smtp: { host: 'securesmtp.t-online.de', port: 465, tls: true },
    displayName: 'T-Online',
    requiresOAuth: false,
    oauthNote: 'T-Online: Erstelle ein E-Mail-Passwort im Kundencenter unter Dienste → E-Mail → Passwort.',
  },
  'mailbox.org': {
    provider: 'imap',
    imap: { host: 'imap.mailbox.org', port: 993, tls: true },
    smtp: { host: 'smtp.mailbox.org', port: 465, tls: true },
    displayName: 'mailbox.org',
    requiresOAuth: false,
  },
  'posteo.de': {
    provider: 'imap',
    imap: { host: 'posteo.de', port: 993, tls: true },
    smtp: { host: 'posteo.de', port: 465, tls: true },
    displayName: 'Posteo',
    requiresOAuth: false,
  },
  'protonmail.com': {
    provider: 'imap',
    imap: { host: '127.0.0.1', port: 1143, tls: false },
    smtp: { host: '127.0.0.1', port: 1025, tls: false },
    displayName: 'ProtonMail (Bridge)',
    requiresOAuth: false,
    oauthNote: 'ProtonMail requires Proton Bridge running locally. Download from proton.me/mail/bridge.',
  },
};

// Hosting providers — custom domains map to these
const HOSTING_PROVIDERS: Record<string, { imap: string; smtp: string; display: string }> = {
  'ionos.de': { imap: 'imap.ionos.de', smtp: 'smtp.ionos.de', display: '1&1 IONOS' },
  '1und1.de': { imap: 'imap.1und1.de', smtp: 'smtp.1und1.de', display: '1&1' },
  'strato.de': { imap: 'imap.strato.de', smtp: 'smtp.strato.de', display: 'Strato' },
  'hetzner.com': { imap: 'imap.your-server.de', smtp: 'smtp.your-server.de', display: 'Hetzner' },
  'hosteurope.de': { imap: 'imap.hosteurope.de', smtp: 'smtp.hosteurope.de', display: 'Host Europe' },
  'all-inkl.com': { imap: 'imap.all-inkl.com', smtp: 'smtp.all-inkl.com', display: 'All-Inkl' },
  'df.eu': { imap: 'sslin.df.eu', smtp: 'sslout.df.eu', display: 'DomainFactory' },
};

// ─── Mozilla ISPDB Lookup ───────────────────────

interface ISPDBConfig {
  imap?: { host: string; port: number; tls: boolean };
  smtp?: { host: string; port: number; tls: boolean };
  displayName?: string;
}

async function lookupISPDB(domain: string): Promise<ISPDBConfig | null> {
  try {
    const url = `https://autoconfig.thunderbird.net/v1.1/${domain}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return null;

    const xml = await res.text();

    // Simple XML parsing (no dependency needed)
    const imapMatch = xml.match(/<incomingServer[^>]*type="imap"[^>]*>[\s\S]*?<hostname>(.*?)<\/hostname>[\s\S]*?<port>(\d+)<\/port>[\s\S]*?<socketType>(SSL|STARTTLS)<\/socketType>/);
    const smtpMatch = xml.match(/<outgoingServer[^>]*>[\s\S]*?<hostname>(.*?)<\/hostname>[\s\S]*?<port>(\d+)<\/port>[\s\S]*?<socketType>(SSL|STARTTLS)<\/socketType>/);
    const nameMatch = xml.match(/<displayName>(.*?)<\/displayName>/);

    if (!imapMatch && !smtpMatch) return null;

    return {
      imap: imapMatch ? {
        host: imapMatch[1].replace('%EMAILDOMAIN%', domain),
        port: parseInt(imapMatch[2]),
        tls: true,
      } : undefined,
      smtp: smtpMatch ? {
        host: smtpMatch[1].replace('%EMAILDOMAIN%', domain),
        port: parseInt(smtpMatch[2]),
        tls: true,
      } : undefined,
      displayName: nameMatch?.[1],
    };
  } catch {
    return null;
  }
}

// ─── MX Record Heuristik ────────────────────────

const MX_PROVIDER_MAP: Array<{ pattern: RegExp; settings: DiscoveredSettings }> = [
  {
    pattern: /google\.com$|googlemail\.com$/i,
    settings: {
      provider: 'gmail', imap: { host: 'imap.gmail.com', port: 993, tls: true },
      smtp: { host: 'smtp.gmail.com', port: 465, tls: true },
      displayName: 'Google Workspace', requiresOAuth: true,
      oauthNote: 'This domain uses Google Workspace. Run suite_setup with email_provider: "gmail" for OAuth flow, or use an App Password.',
    },
  },
  {
    pattern: /outlook\.com$|protection\.outlook\.com$/i,
    settings: {
      provider: 'outlook', imap: { host: 'outlook.office365.com', port: 993, tls: true },
      smtp: { host: 'smtp.office365.com', port: 587, tls: true },
      displayName: 'Microsoft 365', requiresOAuth: true,
      oauthNote: 'This domain uses Microsoft 365. Run suite_setup with email_provider: "outlook" for OAuth flow.',
    },
  },
  {
    pattern: /yahoodns\.net$/i,
    settings: {
      provider: 'imap', imap: { host: 'imap.mail.yahoo.com', port: 993, tls: true },
      smtp: { host: 'smtp.mail.yahoo.com', port: 465, tls: true },
      displayName: 'Yahoo Mail (Business)', requiresOAuth: false,
    },
  },
  {
    pattern: /ionos\.(de|com)$|1und1\.(de|com)$/i,
    settings: {
      provider: 'imap', imap: { host: 'imap.ionos.de', port: 993, tls: true },
      smtp: { host: 'smtp.ionos.de', port: 587, tls: true },
      displayName: '1&1 IONOS', requiresOAuth: false,
    },
  },
  {
    pattern: /strato\.(de|com)$/i,
    settings: {
      provider: 'imap', imap: { host: 'imap.strato.de', port: 993, tls: true },
      smtp: { host: 'smtp.strato.de', port: 465, tls: true },
      displayName: 'Strato', requiresOAuth: false,
    },
  },
  {
    pattern: /your-server\.de$|hetzner\.(de|com)$/i,
    settings: {
      provider: 'imap', imap: { host: 'imap.your-server.de', port: 993, tls: true },
      smtp: { host: 'smtp.your-server.de', port: 587, tls: true },
      displayName: 'Hetzner', requiresOAuth: false,
    },
  },
];

async function lookupMxRecord(domain: string): Promise<DiscoveredSettings | null> {
  try {
    const { resolveMx } = await import('node:dns/promises');
    const records = await resolveMx(domain);
    if (!records || records.length === 0) return null;

    // Sort by priority (lowest = highest priority)
    records.sort((a, b) => a.priority - b.priority);
    const mxHost = records[0].exchange.toLowerCase();

    for (const entry of MX_PROVIDER_MAP) {
      if (entry.pattern.test(mxHost)) {
        return entry.settings;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Common Pattern Probe ───────────────────────

function generateCommonHosts(domain: string): { imap: string[]; smtp: string[] } {
  return {
    imap: [
      `imap.${domain}`,
      `mail.${domain}`,
      `mx.${domain}`,
      domain,
    ],
    smtp: [
      `smtp.${domain}`,
      `mail.${domain}`,
      `mx.${domain}`,
      domain,
    ],
  };
}

// ─── Main Discovery Function ────────────────────

export async function discoverEmailSettings(email: string): Promise<{
  found: boolean;
  settings?: DiscoveredSettings;
  method?: 'well-known' | 'ispdb' | 'mx-heuristic' | 'common-pattern';
  suggestions?: string[];
}> {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) {
    return { found: false, suggestions: ['Invalid email address — missing @ domain.'] };
  }

  // 1. Well-known providers (instant, no network)
  if (WELL_KNOWN[domain]) {
    logger.info(`Auto-discovery: ${domain} → well-known provider (${WELL_KNOWN[domain].displayName})`);
    return { found: true, settings: WELL_KNOWN[domain], method: 'well-known' };
  }

  // 2. Mozilla ISPDB (30K+ providers, covers most hosting companies)
  const ispdb = await lookupISPDB(domain);
  if (ispdb?.imap && ispdb?.smtp) {
    logger.info(`Auto-discovery: ${domain} → Mozilla ISPDB (${ispdb.displayName || domain})`);
    return {
      found: true,
      settings: {
        provider: 'imap',
        imap: ispdb.imap,
        smtp: ispdb.smtp,
        displayName: ispdb.displayName || domain,
        requiresOAuth: false,
      },
      method: 'ispdb',
    };
  }

  // 3. MX Record heuristic (catches Google Workspace, M365 custom domains)
  const mxResult = await lookupMxRecord(domain);
  if (mxResult) {
    logger.info(`Auto-discovery: ${domain} → MX record heuristic (${mxResult.displayName})`);
    return { found: true, settings: mxResult, method: 'mx-heuristic' };
  }

  // 4. Common patterns as suggestions (don't auto-connect, too risky)
  const patterns = generateCommonHosts(domain);
  const suggestions = [
    `Could not auto-detect settings for ${domain}.`,
    '',
    'Common IMAP hosts to try:',
    ...patterns.imap.map(h => `  - ${h}:993 (TLS)`),
    '',
    'Common SMTP hosts to try:',
    ...patterns.smtp.map(h => `  - ${h}:587 (STARTTLS) or ${h}:465 (TLS)`),
    '',
    'You can also check your email provider\'s help page for IMAP/SMTP settings.',
  ];

  logger.info(`Auto-discovery: ${domain} → not found, suggesting common patterns`);
  return { found: false, suggestions };
}

/**
 * Format discovery result as human-readable text for suite_setup response.
 */
export function formatDiscoveryResult(email: string, result: Awaited<ReturnType<typeof discoverEmailSettings>>): string {
  if (!result.found || !result.settings) {
    return result.suggestions?.join('\n') || 'Could not auto-detect email settings.';
  }

  const s = result.settings;
  const lines = [
    `Detected: **${s.displayName}** (via ${result.method})`,
    '',
    `IMAP: ${s.imap.host}:${s.imap.port} (${s.imap.tls ? 'TLS' : 'plain'})`,
    `SMTP: ${s.smtp.host}:${s.smtp.port} (${s.smtp.tls ? 'TLS' : 'plain'})`,
  ];

  if (s.requiresOAuth) {
    lines.push('');
    lines.push(`⚠ ${s.oauthNote || 'This provider requires OAuth2 authentication.'}`);
  } else if (s.oauthNote) {
    lines.push('');
    lines.push(`ℹ ${s.oauthNote}`);
  }

  return lines.join('\n');
}
