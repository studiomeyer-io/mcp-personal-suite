/**
 * Shared Types and Helper Functions
 *
 * Common response formatters, error helpers, and shared types
 * used across all modules.
 */

// ─── MCP Response Types ──────────────────────────────

export interface ToolContent {
  type: 'text';
  text: string;
}

export interface ToolResponse {
  content: ToolContent[];
  isError?: boolean;
}

// ─── Response Helpers ────────────────────────────────

/**
 * Create a successful JSON response for an MCP tool.
 */
export function jsonResponse(data: Record<string, unknown>): ToolResponse {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

/**
 * Create a plain text response for an MCP tool.
 */
export function textResponse(text: string): ToolResponse {
  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
  };
}

/**
 * Create an error response for an MCP tool.
 */
export function errorResponse(message: string, details?: string): ToolResponse {
  const text = details ? `Error: ${message}\n\nDetails: ${details}` : `Error: ${message}`;
  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
    isError: true,
  };
}

// ─── Module Registration ─────────────────────────────

/**
 * Type for module registration functions.
 * Each module exports a function that registers its tools on the McpServer.
 */
export type ModuleRegistrar = (server: McpServerLike) => void;

/**
 * Minimal McpServer interface for module registration.
 * Avoids tight coupling to the SDK's full type.
 */
export interface McpServerLike {
  tool(
    name: string,
    description: string,
    schema: Record<string, unknown>,
    handler: (args: Record<string, unknown>) => Promise<ToolResponse>,
  ): void;
}

// ─── Common Enums ────────────────────────────────────

export const MODULE_PREFIXES = {
  email: 'email_',
  calendar: 'calendar_',
  messaging: 'channel_',
  search: 'search_',
  image: 'image_',
  system: 'suite_',
} as const;

export type ModuleName = keyof typeof MODULE_PREFIXES;
