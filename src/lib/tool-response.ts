/**
 * Shared tool-response helpers.
 *
 * Every module had its own copy of `jsonResponse` / `errorResponse`
 * (email, calendar, messaging, search, image, system). That's six chances
 * to forget `sanitizeToolOutput` on an error path where an upstream
 * library echoed a Bearer token into its Error.message.
 *
 * This file is the single place MCP tool responses are constructed.
 * Every outgoing response goes through `sanitizeToolOutput`.
 */

import { sanitizeToolOutput } from './sanitize-output.js';

export interface ToolResponse {
  [x: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export function jsonResponse(result: unknown, isError?: boolean): ToolResponse {
  return sanitizeToolOutput({
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    ...(isError !== undefined ? { isError } : {}),
  });
}

export function errorResponse(
  message: string,
  code = 'ERROR',
  extra: Record<string, unknown> = {},
): ToolResponse {
  return jsonResponse({ error: message, code, ...extra }, true);
}

export function textResponse(text: string, isError?: boolean): ToolResponse {
  return sanitizeToolOutput({
    content: [{ type: 'text' as const, text }],
    ...(isError !== undefined ? { isError } : {}),
  });
}
