/**
 * Channel Registry — Singleton that manages all adapter instances.
 *
 * Bot connections are expensive and stateful — shared across MCP sessions.
 * Each adapter is created based on env vars, connected on demand or auto-connect.
 */

import { logger } from '../../lib/logger.js';
import type { ChannelAdapter, ChannelState, Platform } from './adapter.js';
import { TelegramAdapter } from './adapters/telegram.js';
import { DiscordAdapter } from './adapters/discord.js';
import { SlackAdapter } from './adapters/slack.js';
import { WhatsAppAdapter } from './adapters/whatsapp.js';

export class ChannelRegistry {
  private adapters = new Map<Platform, ChannelAdapter>();

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.platform, adapter);
    logger.info(`Registered channel: ${adapter.platform}`);
  }

  get(platform: Platform): ChannelAdapter | undefined {
    return this.adapters.get(platform);
  }

  getAll(): ChannelAdapter[] {
    return Array.from(this.adapters.values());
  }

  /** Connect all registered adapters. Returns error map (null = success). */
  async connectAll(): Promise<Map<Platform, Error | null>> {
    const results = new Map<Platform, Error | null>();

    const promises = this.getAll().map(async (adapter) => {
      try {
        await adapter.connect();
        results.set(adapter.platform, null);
      } catch (err) {
        results.set(adapter.platform, err instanceof Error ? err : new Error(String(err)));
      }
    });

    await Promise.allSettled(promises);
    return results;
  }

  async disconnectAll(): Promise<void> {
    const promises = this.getAll().map(async (adapter) => {
      try {
        await adapter.disconnect();
      } catch (err) {
        logger.logError(`Failed to disconnect ${adapter.platform}`, err);
      }
    });

    await Promise.allSettled(promises);
  }

  getStatus(): Array<{ platform: Platform; state: ChannelState; bufferedMessages: number }> {
    return this.getAll().map((adapter) => ({
      platform: adapter.platform,
      state: adapter.state,
      bufferedMessages: adapter.buffer.size,
    }));
  }

  get size(): number {
    return this.adapters.size;
  }
}

// ---- Singleton ----

let _registry: ChannelRegistry | null = null;

export function getOrCreateRegistry(): ChannelRegistry {
  if (_registry) return _registry;

  _registry = new ChannelRegistry();
  const bufferSize = parseInt(process.env['MULTI_CHANNEL_BUFFER_SIZE'] ?? '100', 10) || 100;

  if (process.env['TELEGRAM_BOT_TOKEN']) {
    _registry.register(new TelegramAdapter(process.env['TELEGRAM_BOT_TOKEN'], bufferSize));
  }

  if (process.env['DISCORD_BOT_TOKEN']) {
    _registry.register(new DiscordAdapter(process.env['DISCORD_BOT_TOKEN'], bufferSize));
  }

  if (process.env['SLACK_BOT_TOKEN'] && process.env['SLACK_APP_TOKEN']) {
    _registry.register(new SlackAdapter(
      process.env['SLACK_BOT_TOKEN'],
      process.env['SLACK_APP_TOKEN'],
      bufferSize,
    ));
  }

  if (process.env['WHATSAPP_AUTH_DIR']) {
    _registry.register(new WhatsAppAdapter(process.env['WHATSAPP_AUTH_DIR'], bufferSize));
  }

  if (_registry.size === 0) {
    logger.warn('No messaging channels configured. Set TELEGRAM_BOT_TOKEN, DISCORD_BOT_TOKEN, SLACK_BOT_TOKEN+SLACK_APP_TOKEN, or WHATSAPP_AUTH_DIR.');
  }

  return _registry;
}

/** Reset singleton (for testing). */
export function resetRegistry(): void {
  _registry = null;
}
