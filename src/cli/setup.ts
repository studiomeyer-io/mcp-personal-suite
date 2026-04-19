/**
 * CLI Setup Wizard — Browser-based OAuth for local stdio mode
 *
 * Usage: mcp-personal-suite setup
 *
 * Flow:
 * 1. Asks which service to configure (gmail, calendar, both)
 * 2. Asks for Google OAuth client_id + client_secret (user provides once)
 * 3. Starts localhost:3333 HTTP server
 * 4. Opens browser with Google OAuth URL
 * 5. User approves in browser → Google redirects to localhost:3333/callback
 * 6. We exchange code for tokens → save to ~/.personal-suite/config.json
 * 7. Server shuts down, shows success
 *
 * The user needs to create Google OAuth credentials ONCE (Desktop/Web client in
 * Google Cloud Console), then the wizard handles everything else automatically.
 *
 * Alternative: skip OAuth entirely and use an app-specific password with IMAP.
 * Gmail supports this (Google Account → Security → App passwords). Many users
 * find the IMAP route simpler than setting up a Google Cloud project.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { saveConfig, loadConfig, type SuiteConfig } from '../lib/config.js';

// ─── Constants ─────────────────────────────────────────

const CALLBACK_PORT = 3333;
const CALLBACK_PATH = '/callback';
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

const SCOPES = {
  gmail: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  calendar: [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  both: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/userinfo.email',
  ],
} as const;

type Service = keyof typeof SCOPES;

// ─── Types ────────────────────────────────────────────

interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

// ─── Utilities ────────────────────────────────────────

function openBrowser(url: string): void {
  const commands: Record<string, string> = {
    darwin: `open "${url}"`,
    win32: `start "" "${url}"`,
    linux: `xdg-open "${url}"`,
  };
  const cmd = commands[platform()];
  if (cmd) {
    // Use spawn to avoid shell injection risk with URL parameter
    const parts = cmd.split(' ');
    const bin = parts[0];
    const args = parts.slice(1).map(a => a === `"${url}"` ? url : a.replace(/"/g, ''));
    spawn(bin, args, { stdio: 'ignore', detached: true }).unref();
  }
}

function print(msg: string): void {
  process.stdout.write(msg + '\n');
}

function printHeader(): void {
  print('');
  print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  print('  Personal Suite — CLI Setup Wizard');
  print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  print('');
}

function printSuccess(service: Service, email: string | null): void {
  const label = service === 'both' ? 'Gmail + Calendar' : service === 'gmail' ? 'Gmail' : 'Google Calendar';
  print('');
  print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  print(`  ✓ ${label} connected${email ? ` (${email})` : ''}`);
  print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  print('');
  print('  Config saved to ~/.personal-suite/config.json');
  print('  Restart Claude to pick up the changes.');
  print('');
}

// ─── OAuth Flow ───────────────────────────────────────

// PKCE (RFC 7636): protects against authorization code interception
function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

function deriveCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function buildAuthUrl(clientId: string, service: Service, state: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES[service].join(' '),
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string,
  codeVerifier: string,
): Promise<GoogleTokens> {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier, // PKCE
  });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const txt = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${txt.slice(0, 200)}`);
  }

  return response.json() as Promise<GoogleTokens>;
}

async function fetchUserEmail(accessToken: string): Promise<string | null> {
  try {
    const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { email?: string };
    return data.email || null;
  } catch {
    return null;
  }
}

// ─── Local HTTP Server for Callback ───────────────────

interface CallbackResult {
  code: string;
  state: string;
}

function waitForCallback(expectedState: string): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (!req.url?.startsWith(CALLBACK_PATH)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(htmlResponse('Error', `Google rejected the connection: ${escapeHtml(error)}`, 'error'));
        server.close();
        reject(new Error(`OAuth denied: ${error}`));
        return;
      }

      if (!code || !state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(htmlResponse('Error', 'Missing code or state.', 'error'));
        server.close();
        reject(new Error('Missing code/state'));
        return;
      }

      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(htmlResponse('Error', 'State mismatch — possible CSRF attempt.', 'error'));
        server.close();
        reject(new Error('State mismatch'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlResponse('Connected!', 'You can close this tab and return to the terminal.', 'success'));

      // Delay server close to let the browser finish rendering
      setTimeout(() => server.close(), 200);
      resolve({ code, state });
    });

    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      // ready
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${CALLBACK_PORT} is already in use. Close the other process and try again.`));
      } else {
        reject(err);
      }
    });

    // Timeout after 10 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('Setup timed out after 10 minutes. Run the command again.'));
    }, 10 * 60 * 1000);
  });
}

function htmlResponse(title: string, body: string, variant: 'success' | 'error'): string {
  const iconColor = variant === 'success' ? '#22c55e' : '#ef4444';
  const icon = variant === 'success' ? '✓' : '!';
  const bg = variant === 'success' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0a;color:#fafafa;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
.card{max-width:480px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:48px;text-align:center}
.icon{width:72px;height:72px;border-radius:50%;background:${bg};border:2px solid ${iconColor}80;display:flex;align-items:center;justify-content:center;font-size:36px;color:${iconColor};margin:0 auto 24px}
h1{font-size:1.6rem;margin:0 0 12px;font-weight:700}
p{color:#b5b5b5;margin:0;line-height:1.6}
</style></head><body>
<div class="card">
  <div class="icon">${icon}</div>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(body)}</p>
</div></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[c];
  });
}

// ─── Prompts ──────────────────────────────────────────

async function prompt(rl: import('node:readline/promises').Interface, question: string, defaultValue?: string): Promise<string> {
  const hint = defaultValue ? ` [${defaultValue}]` : '';
  const answer = await rl.question(`${question}${hint}: `);
  return answer.trim() || defaultValue || '';
}

async function promptService(rl: import('node:readline/promises').Interface): Promise<Service> {
  print('Which Google service do you want to connect?');
  print('  1) Gmail only');
  print('  2) Calendar only');
  print('  3) Both (recommended)');
  print('');
  const choice = await prompt(rl, 'Enter 1, 2, or 3', '3');
  if (choice === '1') return 'gmail';
  if (choice === '2') return 'calendar';
  return 'both';
}

async function promptCredentials(rl: import('node:readline/promises').Interface): Promise<{ clientId: string; clientSecret: string }> {
  print('');
  print('You need Google OAuth 2.0 credentials. If you don\'t have them yet:');
  print('  1. Go to: https://console.cloud.google.com/apis/credentials');
  print('  2. "Create credentials" → "OAuth client ID" → "Web application"');
  print(`  3. Add authorized redirect URI: ${REDIRECT_URI}`);
  print('  4. Copy Client ID and Client Secret below');
  print('');
  print('(Tip: if OAuth is painful, use an app-specific password with IMAP instead — far simpler)');
  print('');

  const clientId = await prompt(rl, 'Client ID');
  if (!clientId) throw new Error('Client ID is required');

  const clientSecret = await prompt(rl, 'Client Secret');
  if (!clientSecret) throw new Error('Client Secret is required');

  return { clientId, clientSecret };
}

// ─── Save Config ──────────────────────────────────────

async function saveTokens(
  service: Service,
  tokens: GoogleTokens,
  clientId: string,
  clientSecret: string,
  userEmail: string | null,
): Promise<void> {
  const config: SuiteConfig = await loadConfig();
  const expiresAt = Date.now() + tokens.expires_in * 1000;

  if (service === 'gmail' || service === 'both') {
    config.email = {
      provider: 'gmail',
      fromAddress: userEmail || undefined,
      oauth: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        clientId,
        clientSecret,
        expiresAt,
      },
    };
  }

  if (service === 'calendar' || service === 'both') {
    config.calendar = {
      provider: 'google',
      oauth: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        clientId,
        clientSecret,
        expiresAt,
      },
      defaultCalendarId: 'primary',
    };
  }

  await saveConfig(config);
}

// ─── Main Wizard ──────────────────────────────────────

export async function runSetupWizard(): Promise<void> {
  printHeader();

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    const service = await promptService(rl);
    const { clientId, clientSecret } = await promptCredentials(rl);

    // Generate random state for CSRF protection + PKCE verifier
    const state = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = deriveCodeChallenge(codeVerifier);

    const authUrl = buildAuthUrl(clientId, service, state, codeChallenge);

    print('');
    print('Opening browser for Google sign-in...');
    print('If the browser doesn\'t open, copy this URL manually:');
    print('');
    print(authUrl);
    print('');

    openBrowser(authUrl);

    print(`Waiting for you to approve in the browser... (listening on ${REDIRECT_URI})`);

    const { code } = await waitForCallback(state);

    print('');
    print('Exchanging code for tokens...');

    const tokens = await exchangeCodeForTokens(code, clientId, clientSecret, codeVerifier);

    if (!tokens.refresh_token) {
      print('');
      print('WARNING: Google did not return a refresh token. This usually means');
      print('you\'ve already authorized this app. Revoke access at:');
      print('  https://myaccount.google.com/permissions');
      print('Then run this wizard again.');
      print('');
    }

    const userEmail = await fetchUserEmail(tokens.access_token);
    await saveTokens(service, tokens, clientId, clientSecret, userEmail);

    printSuccess(service, userEmail);
  } finally {
    rl.close();
  }
}

// ─── CLI Entry Point ──────────────────────────────────

// Allow direct invocation: `node dist/cli/setup.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  runSetupWizard().catch((err) => {
    process.stderr.write(`\n[setup failed] ${err instanceof Error ? err.message : String(err)}\n\n`);
    process.exit(1);
  });
}
