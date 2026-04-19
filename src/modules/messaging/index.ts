/**
 * Messaging Module — Multi-platform messaging (Telegram, Discord, Slack, WhatsApp).
 *
 * Registers 8 tools:
 *   channel_send, channel_receive, channel_list, channel_status,
 *   channel_broadcast, channel_history, channel_connect, channel_disconnect
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { logger } from '../../lib/logger.js';
import type { Platform } from './adapter.js';
import { WhatsAppAdapter } from './adapters/whatsapp.js';
import { getOrCreateRegistry, type ChannelRegistry } from './registry.js';

// ---- Constants ----

const PLATFORMS = ['telegram', 'discord', 'slack', 'whatsapp'] as const;
const platformEnum = z.enum(PLATFORMS).describe('Messaging platform');

/** Platform-specific message length limits */
const MESSAGE_LIMITS: Record<string, number> = {
  telegram: 4096,
  discord: 2000,
  slack: 40000,
  whatsapp: 65536,
};

// ---- Helpers ----

interface ToolResponse {
  [x: string]: unknown;
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

/** Split text into chunks respecting platform limit */
function chunkMessage(text: string, platform: string): string[] {
  const limit = MESSAGE_LIMITS[platform] ?? 4096;
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    // Try to split at last newline within limit
    let splitAt = limit;
    if (remaining.length > limit) {
      const lastNewline = remaining.lastIndexOf('\n', limit);
      if (lastNewline > limit * 0.5) splitAt = lastNewline + 1;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}

// ---- Tool Registration ----

export function registerMessagingTools(server: McpServer): void {
  const registry = getOrCreateRegistry();

  registerCoreTools(server, registry);
  registerManagementTools(server, registry);
  registerAdvancedTools(server, registry);

  // Auto-connect if configured
  if (process.env['MULTI_CHANNEL_AUTO_CONNECT'] !== '0' && registry.size > 0) {
    registry.connectAll().then((results) => {
      for (const [platform, error] of results) {
        if (error) {
          logger.error(`Auto-connect failed for ${platform}: ${error.message}`);
        } else {
          logger.info(`Auto-connected: ${platform}`);
        }
      }
    }).catch((err) => {
      logger.logError('Messaging auto-connect error', err);
    });
  }

  logger.info(`Messaging module registered (${registry.size} channels configured)`);
}

// ---- Core Tools ----

function registerCoreTools(server: McpServer, registry: ChannelRegistry): void {
  // ---- channel_send ----
  server.tool(
    'channel_send',
    'Send a message to a specific platform and channel. Use channel_list to discover channel IDs first.',
    {
      platform: platformEnum.describe('Target platform'),
      channelId: z.string().describe('Channel/chat ID on the platform'),
      text: z.string().describe('Message text to send'),
      threadId: z.string().optional().describe('Thread/topic ID for threaded replies'),
      replyToId: z.string().optional().describe('Message ID to reply to'),
    },
    async (args) => {
      const adapter = registry.get(args.platform as Platform);
      if (!adapter) return errorResponse(`Platform "${args.platform}" not configured`, 'NOT_CONFIGURED');
      if (adapter.state !== 'connected') return errorResponse(`Platform "${args.platform}" is ${adapter.state}. Call channel_connect first.`, 'NOT_CONNECTED');

      // Chunk message if it exceeds platform limit
      const chunks = chunkMessage(args.text, args.platform);
      let lastMessageId: string | undefined;

      for (const chunk of chunks) {
        const result = await adapter.send({
          channelId: args.channelId,
          text: chunk,
          threadId: args.threadId,
          replyToId: args.replyToId,
        });
        if (!result.success) return errorResponse(result.error ?? 'Send failed', 'SEND_FAILED');
        lastMessageId = result.messageId;
      }

      return jsonResponse({
        success: true,
        messageId: lastMessageId,
        platform: args.platform,
        channelId: args.channelId,
        chunks: chunks.length > 1 ? chunks.length : undefined,
      });
    },
  );

  // ---- channel_receive ----
  server.tool(
    'channel_receive',
    'Get recently received messages from the in-memory buffer. For older messages, use channel_history instead.',
    {
      platform: platformEnum.optional().describe('Filter by platform (omit for all)'),
      since: z.coerce.number().optional().describe('Unix timestamp (ms) — only messages after this time'),
      limit: z.coerce.number().min(1).max(100).optional().describe('Max messages to return (default 20)'),
    },
    async (args) => {
      const limit = args.limit ?? 20;
      let messages = [];

      if (args.platform) {
        const adapter = registry.get(args.platform as Platform);
        if (!adapter) return errorResponse(`Platform "${args.platform}" not configured`, 'NOT_CONFIGURED');
        messages = args.since ? adapter.buffer.getSince(args.since) : adapter.buffer.getRecent(limit);
      } else {
        for (const adapter of registry.getAll()) {
          const adapterMsgs = args.since
            ? adapter.buffer.getSince(args.since)
            : adapter.buffer.getRecent(limit);
          messages.push(...adapterMsgs);
        }
        // Sort by timestamp and limit
        messages.sort((a, b) => a.timestamp - b.timestamp);
      }

      if (messages.length > limit) {
        messages = messages.slice(-limit);
      }

      return jsonResponse({
        messages,
        count: messages.length,
        oldestTimestamp: messages.length > 0 ? messages[0].timestamp : null,
        newestTimestamp: messages.length > 0 ? messages[messages.length - 1].timestamp : null,
      });
    },
  );

  // ---- channel_list ----
  server.tool(
    'channel_list',
    'List available channels/groups/conversations on connected platforms.',
    {
      platform: platformEnum.optional().describe('Filter by platform (omit for all)'),
    },
    async (args) => {
      const results = [];

      const adapters = args.platform
        ? [registry.get(args.platform as Platform)].filter(Boolean)
        : registry.getAll();

      for (const adapter of adapters) {
        if (!adapter) continue;
        if (adapter.state !== 'connected') {
          results.push({ platform: adapter.platform, state: adapter.state, channels: [] });
          continue;
        }

        try {
          const channels = await adapter.listChannels();
          results.push({ platform: adapter.platform, state: adapter.state, channels });
        } catch (err) {
          results.push({ platform: adapter.platform, state: adapter.state, channels: [], error: String(err) });
        }
      }

      return jsonResponse(results);
    },
  );

  // ---- channel_status ----
  server.tool(
    'channel_status',
    'Health check for all configured messaging platforms. Call this first to see what is available.',
    {},
    async () => {
      const status = registry.getStatus();

      const healthChecks = await Promise.allSettled(
        registry.getAll().map(async (adapter) => ({
          platform: adapter.platform,
          healthy: adapter.state === 'connected' ? await adapter.isHealthy() : false,
        })),
      );

      const healthMap = new Map<string, boolean>();
      for (const result of healthChecks) {
        if (result.status === 'fulfilled') {
          healthMap.set(result.value.platform, result.value.healthy);
        }
      }

      const channels = status.map((s) => {
        const entry: Record<string, unknown> = {
          ...s,
          healthy: healthMap.get(s.platform) ?? false,
        };

        // WhatsApp: include QR scan status
        if (s.platform === 'whatsapp') {
          const wa = registry.get('whatsapp');
          if (wa instanceof WhatsAppAdapter && wa.needsQrScan) {
            entry['qrRequired'] = true;
            if (wa.lastQrCode) entry['qrRawString'] = wa.lastQrCode;
          }
        }

        return entry;
      });

      const connected = channels.filter((c) => c['state'] === 'connected').length;

      return jsonResponse({
        channels,
        summary: {
          connected,
          disconnected: channels.length - connected,
          total: channels.length,
        },
      });
    },
  );
}

// ---- Management Tools ----

function registerManagementTools(server: McpServer, registry: ChannelRegistry): void {
  // ---- channel_connect ----
  server.tool(
    'channel_connect',
    'Connect to a messaging platform. Idempotent — safe to call if already connected. For WhatsApp: if QR scan is needed, returns the raw pairing URI string.',
    {
      platform: platformEnum.describe('Platform to connect'),
    },
    async (args) => {
      const adapter = registry.get(args.platform as Platform);
      if (!adapter) {
        return errorResponse(
          `Platform "${args.platform}" not configured. Set the corresponding env var (e.g. TELEGRAM_BOT_TOKEN).`,
          'NOT_CONFIGURED',
        );
      }

      if (adapter.state === 'connected') {
        return jsonResponse({ platform: args.platform, state: 'connected', message: 'Already connected' });
      }

      try {
        await adapter.connect();

        // WhatsApp: include QR code info if scan is needed
        if (args.platform === 'whatsapp' && adapter instanceof WhatsAppAdapter) {
          if (adapter.needsQrScan && adapter.lastQrCode) {
            return jsonResponse({
              platform: args.platform,
              state: adapter.state,
              qrRequired: true,
              qrRawString: adapter.lastQrCode,
              instructions: 'QR scan required. The QR code is printed in the server terminal (stderr). The qrRawString is the raw WhatsApp pairing URI — use a QR code generator to create a scannable code from it, or scan directly from the terminal. After scanning with WhatsApp (Settings > Linked Devices > Link a Device), call channel_connect again.',
            });
          }
          if (adapter.needsQrScan) {
            return jsonResponse({
              platform: args.platform,
              state: adapter.state,
              qrRequired: true,
              instructions: 'QR code is being generated. Check the server terminal output, or call channel_connect again in a few seconds to get the QR pairing string.',
            });
          }
        }

        return jsonResponse({ platform: args.platform, state: adapter.state, message: 'Connected successfully' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        // WhatsApp timeout with QR pending
        if (args.platform === 'whatsapp' && adapter instanceof WhatsAppAdapter) {
          if (adapter.lastQrCode) {
            return jsonResponse({
              platform: args.platform,
              state: 'connecting',
              qrRequired: true,
              qrRawString: adapter.lastQrCode,
              instructions: 'Connection timed out waiting for QR scan. The QR code is in the terminal. Scan it with WhatsApp, then call channel_connect again.',
            });
          }
        }

        return errorResponse(`Failed to connect to ${args.platform}: ${message}`, 'CONNECT_FAILED');
      }
    },
  );

  // ---- channel_disconnect ----
  server.tool(
    'channel_disconnect',
    'Disconnect from a messaging platform. This stops receiving messages.',
    {
      platform: platformEnum.describe('Platform to disconnect'),
    },
    async (args) => {
      const adapter = registry.get(args.platform as Platform);
      if (!adapter) return errorResponse(`Platform "${args.platform}" not configured`, 'NOT_CONFIGURED');

      if (adapter.state === 'disconnected') {
        return jsonResponse({ platform: args.platform, state: 'disconnected', message: 'Already disconnected' });
      }

      try {
        await adapter.disconnect();
        return jsonResponse({ platform: args.platform, state: 'disconnected', message: 'Disconnected successfully' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResponse(`Failed to disconnect ${args.platform}: ${message}`, 'DISCONNECT_FAILED');
      }
    },
  );
}

// ---- Advanced Tools ----

function registerAdvancedTools(server: McpServer, registry: ChannelRegistry): void {
  // ---- channel_broadcast ----
  server.tool(
    'channel_broadcast',
    'Send the same message to multiple platforms at once. Runs in parallel.',
    {
      targets: z.array(z.object({
        platform: platformEnum,
        channelId: z.string(),
      })).min(1).describe('Array of { platform, channelId } targets'),
      text: z.string().describe('Message text to broadcast'),
    },
    async (args) => {
      const results = await Promise.allSettled(
        args.targets.map(async (target) => {
          const adapter = registry.get(target.platform as Platform);
          if (!adapter) return { platform: target.platform, success: false, error: 'Not configured' };
          if (adapter.state !== 'connected') return { platform: target.platform, success: false, error: 'Not connected' };

          const result = await adapter.send({ channelId: target.channelId, text: args.text });
          return { platform: target.platform, channelId: target.channelId, ...result };
        }),
      );

      const outcomes = results.map((r) =>
        r.status === 'fulfilled' ? r.value : { success: false, error: 'Promise rejected' },
      );

      const successCount = outcomes.filter((o) => o.success).length;

      return jsonResponse({
        results: outcomes,
        summary: { sent: successCount, failed: outcomes.length - successCount, total: outcomes.length },
      });
    },
  );

  // ---- channel_history ----
  server.tool(
    'channel_history',
    'Get conversation history from a platform API. Unlike channel_receive (which reads the local buffer), this fetches older messages directly from the platform.',
    {
      platform: platformEnum.describe('Platform to query'),
      channelId: z.string().describe('Channel/chat ID'),
      limit: z.coerce.number().min(1).max(100).optional().describe('Max messages to return (default 50)'),
      before: z.coerce.number().optional().describe('Unix timestamp (ms) — messages before this time'),
      threadId: z.string().optional().describe('Thread ID for thread-specific history'),
    },
    async (args) => {
      const adapter = registry.get(args.platform as Platform);
      if (!adapter) return errorResponse(`Platform "${args.platform}" not configured`, 'NOT_CONFIGURED');
      if (adapter.state !== 'connected') return errorResponse(`Platform "${args.platform}" is ${adapter.state}`, 'NOT_CONNECTED');

      try {
        const messages = await adapter.getHistory({
          channelId: args.channelId,
          limit: args.limit ?? 50,
          before: args.before,
          threadId: args.threadId,
        });

        return jsonResponse({
          messages,
          count: messages.length,
          platform: args.platform,
          channelId: args.channelId,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResponse(`Failed to get history: ${message}`, 'HISTORY_FAILED');
      }
    },
  );
}

// Re-export types for external use
export type { Platform, ChannelAdapter, ChannelMessage, ChannelState } from './adapter.js';
export { ChannelRegistry, getOrCreateRegistry, resetRegistry } from './registry.js';
export { MessageBuffer } from './buffer.js';
