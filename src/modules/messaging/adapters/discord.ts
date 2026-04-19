/**
 * Discord Adapter — Uses discord.js for bot communication.
 *
 * Auth: DISCORD_BOT_TOKEN from Discord Developer Portal
 * Requires: MessageContent privileged intent enabled
 */

import {
  Client,
  Events,
  GatewayIntentBits,
  type TextChannel,
  type Message as DMessage,
  ChannelType,
} from 'discord.js';
import { MessageBuffer } from '../buffer.js';
import { logger } from '../../../lib/logger.js';
import type {
  ChannelAdapter,
  ChannelInfo,
  ChannelMessage,
  ChannelState,
  HistoryOptions,
  Platform,
  SendOptions,
  SendResult,
} from '../adapter.js';

export class DiscordAdapter implements ChannelAdapter {
  readonly platform: Platform = 'discord';
  state: ChannelState = 'disconnected';
  readonly buffer: MessageBuffer;

  private client: Client;
  private token: string;

  constructor(token: string, bufferSize = 100) {
    this.token = token;
    this.buffer = new MessageBuffer(bufferSize);
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });
  }

  async connect(): Promise<void> {
    if (this.state === 'connected') return;
    this.state = 'connecting';

    try {
      // Recreate client to avoid listener stacking on reconnect
      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages,
        ],
      });

      this.client.on(Events.MessageCreate, (msg: DMessage) => {
        if (msg.author.bot) return; // Skip bot messages to avoid loops

        const channelMessage: ChannelMessage = {
          id: msg.id,
          platform: 'discord',
          channelId: msg.channelId,
          channelName: 'name' in msg.channel ? (msg.channel as TextChannel).name : 'DM',
          sender: {
            id: msg.author.id,
            name: msg.author.displayName ?? msg.author.username,
            isBot: msg.author.bot,
          },
          text: msg.content,
          timestamp: msg.createdTimestamp,
          threadId: msg.thread?.id,
          replyToId: msg.reference?.messageId ?? undefined,
        };

        this.buffer.push(channelMessage);
        logger.debug(`[discord] Message from ${channelMessage.sender.name} in ${channelMessage.channelName}`);
      });

      await this.client.login(this.token);

      await new Promise<void>((resolve) => {
        this.client.once(Events.ClientReady, () => {
          logger.info(`[discord] Bot connected as ${this.client.user?.tag}`);
          resolve();
        });
      });

      this.state = 'connected';
    } catch (err) {
      this.state = 'error';
      logger.logError('[discord] Failed to connect', err);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.state === 'disconnected') return;
    try {
      this.client.destroy();
    } catch {
      // Ignore destroy errors
    }
    this.state = 'disconnected';
    logger.info('[discord] Disconnected');
  }

  async send(options: SendOptions): Promise<SendResult> {
    try {
      const channel = await this.client.channels.fetch(options.channelId);
      if (!channel || !('send' in channel)) {
        return { success: false, error: `Channel ${options.channelId} not found or not text-based` };
      }

      const textChannel = channel as TextChannel;
      const params: Record<string, unknown> = { content: options.text };

      if (options.replyToId) {
        params['reply'] = { messageReference: options.replyToId };
      }

      const result = await textChannel.send(params);
      return { success: true, messageId: result.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.logError('[discord] Send failed', err);
      return { success: false, error: message };
    }
  }

  async getHistory(options: HistoryOptions): Promise<ChannelMessage[]> {
    try {
      const channel = await this.client.channels.fetch(options.channelId);
      if (!channel || !('messages' in channel)) return [];

      const textChannel = channel as TextChannel;
      const fetchOptions: Record<string, unknown> = { limit: options.limit ?? 50 };
      if (options.before) {
        // Discord snowflake = (timestamp_ms - DISCORD_EPOCH) << 22
        const DISCORD_EPOCH = 1420070400000n;
        const snowflake = ((BigInt(options.before) - DISCORD_EPOCH) << 22n).toString();
        fetchOptions['before'] = snowflake;
      }

      const messages = await textChannel.messages.fetch(fetchOptions);

      return messages.map((msg) => ({
        id: msg.id,
        platform: 'discord' as Platform,
        channelId: msg.channelId,
        channelName: textChannel.name,
        sender: {
          id: msg.author.id,
          name: msg.author.displayName ?? msg.author.username,
          isBot: msg.author.bot,
        },
        text: msg.content,
        timestamp: msg.createdTimestamp,
        threadId: msg.thread?.id,
        replyToId: msg.reference?.messageId ?? undefined,
      })).reverse(); // Newest last
    } catch (err) {
      logger.logError('[discord] getHistory failed', err);
      return [];
    }
  }

  async listChannels(): Promise<ChannelInfo[]> {
    const channels: ChannelInfo[] = [];
    for (const guild of this.client.guilds.cache.values()) {
      for (const channel of guild.channels.cache.values()) {
        if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement) {
          channels.push({
            id: channel.id,
            name: `${guild.name}/#${channel.name}`,
            type: channel.type === ChannelType.GuildText ? 'text' : 'announcement',
          });
        }
      }
    }
    return channels;
  }

  async isHealthy(): Promise<boolean> {
    return this.client.isReady();
  }
}
