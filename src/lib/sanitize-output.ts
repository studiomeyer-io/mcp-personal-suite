/**
 * Tool-output sanitizer.
 *
 * Motivation: every module reflects upstream data — IMAP error strings,
 * OAuth exception messages, CalDAV XML, Slack webhook payloads — back to
 * the MCP client as tool output. If an upstream library leaks a Bearer
 * token or IMAP password into a `result.error`, the assistant prints it
 * verbatim to the human.
 *
 * `logger.sanitizeSecrets` already strips 15+ secret shapes from log
 * strings. This wrapper applies the same scrub to a whole tool response
 * tree (content text, error messages, deeply nested strings) before the
 * response goes back on the wire.
 *
 * Usage:
 *   return sanitizeToolOutput(jsonResponse(result, isError));
 *
 * Performance: walks the object tree once. Strings are the only type
 * mutated; numbers / booleans / null pass through unchanged.
 */

import { sanitizeSecrets } from './logger.js';

export type ToolOutput = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [k: string]: unknown;
};

export function sanitizeToolOutput<T extends ToolOutput>(output: T): T {
  if (!output || typeof output !== 'object') return output;
  // Mutate in place — MCP tool responses are one-shot and we own this object.
  if (Array.isArray(output.content)) {
    for (const part of output.content) {
      if (part && typeof part === 'object' && typeof part.text === 'string') {
        part.text = sanitizeSecrets(part.text);
      }
    }
  }
  // Walk every other top-level property; MCP spec allows custom fields.
  for (const [k, v] of Object.entries(output)) {
    if (k === 'content') continue;
    output[k as keyof T] = sanitizeValue(v) as T[keyof T];
  }
  return output;
}

function sanitizeValue(v: unknown): unknown {
  if (typeof v === 'string') return sanitizeSecrets(v);
  if (Array.isArray(v)) return v.map(sanitizeValue);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, inner] of Object.entries(v)) out[k] = sanitizeValue(inner);
    return out;
  }
  return v;
}
