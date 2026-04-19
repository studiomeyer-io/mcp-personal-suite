/**
 * Shared structured logger for mcp-personal-suite
 * Logs to stderr to not interfere with MCP protocol on stdout
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
  timestamp: string;
}

const DEBUG = process.env['DEBUG']?.includes('mcp-personal-suite') || process.env['MCP_DEBUG'] === '1';

// ─── Secret Redaction ────────────────────────────────
//
// Upstream library errors (imapflow, nodemailer, grammy, discord.js, slack bolt,
// baileys, googleapis, ts-caldav, fal, OpenAI, Gemini) can embed user credentials
// in their thrown Error.message. Strip known secret shapes before logging.

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [REDACTED]'],
  [/sk-[a-zA-Z0-9_-]{20,}/g, 'sk-[REDACTED]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, 'xox[REDACTED]'],
  [/\b\d{9,10}:[A-Za-z0-9_-]{35,}\b/g, '[TELEGRAM_TOKEN_REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[AWS_KEY_REDACTED]'],
  [/\bghp_[A-Za-z0-9]{36,}\b/g, '[GITHUB_TOKEN_REDACTED]'],
  [/\bBSA[A-Za-z0-9_-]{20,}\b/g, '[BRAVE_KEY_REDACTED]'],
  [/password=['"]?[^'"\s&]+/gi, 'password=[REDACTED]'],
  [/:\/\/([^:@/]+):([^@/]+)@/g, '://$1:[REDACTED]@'],
];

export function sanitizeSecrets(text: string): string {
  if (!text) return text;
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function sanitizeContext(ctx: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (typeof v === 'string') {
      out[k] = sanitizeSecrets(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function formatEntry(entry: LogEntry): string {
  const prefix = `[${entry.timestamp}] [${entry.level.toUpperCase()}]`;
  const safeMessage = sanitizeSecrets(entry.message);
  const ctx = entry.context ? ` ${JSON.stringify(sanitizeContext(entry.context))}` : '';
  return `${prefix} ${safeMessage}${ctx}`;
}

function log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  if (level === 'debug' && !DEBUG) return;

  const entry: LogEntry = {
    level,
    message,
    context,
    timestamp: new Date().toISOString(),
  };

  console.error(formatEntry(entry));
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => log('debug', message, context),
  info: (message: string, context?: Record<string, unknown>) => log('info', message, context),
  warn: (message: string, context?: Record<string, unknown>) => log('warn', message, context),
  error: (message: string, context?: Record<string, unknown>) => log('error', message, context),

  logError: (message: string, error: unknown, context?: Record<string, unknown>) => {
    const errorContext: Record<string, unknown> = { ...context };
    if (error instanceof Error) {
      errorContext['errorMessage'] = error.message;
      errorContext['errorName'] = error.name;
      if (DEBUG && error.stack) {
        errorContext['stack'] = error.stack;
      }
    } else {
      errorContext['error'] = String(error);
    }
    log('error', message, errorContext);
  },
};

export type Logger = typeof logger;
