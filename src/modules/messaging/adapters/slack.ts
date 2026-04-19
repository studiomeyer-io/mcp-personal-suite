/**
 * Slack Adapter — Uses @slack/bolt for Socket Mode communication.
 *
 * Auth: SLACK_BOT_TOKEN (xoxb-) + SLACK_APP_TOKEN (xapp-) for Socket Mode
 * No public URL needed — Socket Mode handles everything.
 */

import { App } from '@slack/bolt';
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

export class SlackAdapter implements ChannelAdapter {
  readonly platform: Platform = 'slack';
  state: ChannelState = 'disconnected';
  readonly buffer: MessageBuffer;

  private app: App;
  private botToken: string;

  constructor(botToken: string, appToken: string, bufferSize = 100) {
    this.botToken = botToken;
    this.buffer = new MessageBuffer(bufferSize);
    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
    });
  }

  async connect(): Promise<void> {
    if (this.state === 'connected') return;
    this.state = 'connecting';

    try {
      // Listen for messages
      this.app.message(async ({ message }) => {
        // Only handle regular user messages, skip bot messages
        if (!message || message.subtype) return;
        if (!('text' in message) || !('user' in message)) return;
        if ('bot_id' in message && message.bot_id) return;

        const msg: ChannelMessage = {
          id: message.ts,
          platform: 'slack',
          channelId: message.channel,
          sender: {
            id: message.user ?? 'unknown',
            name: message.user ?? 'unknown', // Resolve later if needed
            isBot: false,
          },
          text: message.text ?? '',
          timestamp: parseFloat(message.ts) * 1000,
          threadId: message.thread_ts,
          replyToId: message.thread_ts !== message.ts ? message.thread_ts : undefined,
        };

        this.buffer.push(msg);
        logger.debug(`[slack] Message from ${msg.sender.id} in ${msg.channelId}`);
      });

      await this.app.start();
      this.state = 'connected';
      logger.info('[slack] Bot connected via Socket Mode');
    } catch (err) {
      this.state = 'error';
      logger.logError('[slack] Failed to connect', err);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.state === 'disconnected') return;
    try {
      await this.app.stop();
    } catch {
      // Ignore stop errors
    }
    this.state = 'disconnected';
    logger.info('[slack] Disconnected');
  }

  async send(options: SendOptions): Promise<SendResult> {
    try {
      const result = await this.app.client.chat.postMessage({
        token: this.botToken,
        channel: options.channelId,
        text: options.text,
        ...(options.threadId ? { thread_ts: options.threadId } : {}),
      });

      return { success: true, messageId: result.ts };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.logError('[slack] Send failed', err);
      return { success: false, error: message };
    }
  }

  async getHistory(options: HistoryOptions): Promise<ChannelMessage[]> {
    try {
      const result = await this.app.client.conversations.history({
        token: this.botToken,
        channel: options.channelId,
        limit: options.limit ?? 50,
        ...(options.before ? { latest: String(options.before / 1000) } : {}),
      });

      return (result.messages ?? []).map((msg) => ({
        id: msg.ts ?? '',
        platform: 'slack' as Platform,
        channelId: options.channelId,
        sender: {
          id: msg.user ?? 'unknown',
          name: msg.user ?? 'unknown',
          isBot: msg.bot_id !== undefined,
        },
        text: msg.text ?? '',
        timestamp: parseFloat(msg.ts ?? '0') * 1000,
        threadId: msg.thread_ts,
      })).reverse(); // Newest last
    } catch (err) {
      logger.logError('[slack] getHistory failed', err);
      return [];
    }
  }

  async listChannels(): Promise<ChannelInfo[]> {
    try {
      const result = await this.app.client.conversations.list({
        token: this.botToken,
        types: 'public_channel,private_channel,im,mpim',
        limit: 200,
      });

      return (result.channels ?? []).map((ch) => ({
        id: ch.id ?? '',
        name: ch.name ?? ch.id ?? 'unknown',
        type: ch.is_im ? 'dm' : ch.is_mpim ? 'group-dm' : ch.is_private ? 'private' : 'public',
      }));
    } catch (err) {
      logger.logError('[slack] listChannels failed', err);
      return [];
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.app.client.auth.test({ token: this.botToken });
      return true;
    } catch {
      return false;
    }
  }
}
