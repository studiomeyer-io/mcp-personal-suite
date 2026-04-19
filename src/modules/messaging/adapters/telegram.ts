/**
 * Telegram Adapter — Uses grammy for bot communication.
 *
 * Auth: TELEGRAM_BOT_TOKEN from @BotFather
 * Mode: Long-polling (no webhook, no public URL needed)
 */

import { Bot } from 'grammy';
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

export class TelegramAdapter implements ChannelAdapter {
  readonly platform: Platform = 'telegram';
  state: ChannelState = 'disconnected';
  readonly buffer: MessageBuffer;

  private bot: Bot;
  private botId: number | null = null;
  private knownChats = new Map<string, string>(); // chatId -> chatName
  private token: string;

  constructor(token: string, bufferSize = 100) {
    this.token = token;
    this.bot = new Bot(token);
    this.buffer = new MessageBuffer(bufferSize);
  }

  async connect(): Promise<void> {
    if (this.state === 'connected') return;
    this.state = 'connecting';

    try {
      // Recreate bot instance to avoid listener stacking on reconnect
      this.bot = new Bot(this.token);

      // Get bot's own ID for self-message filtering
      const me = await this.bot.api.getMe();
      this.botId = me.id;

      // Set up message listener
      this.bot.on('message', (ctx) => {
        const chat = ctx.chat;
        const from = ctx.from;
        if (!from) return;
        if (from.id === this.botId) return; // Skip own messages

        const chatId = String(chat.id);
        const chatName = chat.type === 'private'
          ? `${from.first_name}${from.last_name ? ' ' + from.last_name : ''}`
          : (chat as { title?: string }).title ?? chatId;

        this.knownChats.set(chatId, chatName);

        const msg: ChannelMessage = {
          id: String(ctx.message.message_id),
          platform: 'telegram',
          channelId: chatId,
          channelName: chatName,
          sender: {
            id: String(from.id),
            name: `${from.first_name}${from.last_name ? ' ' + from.last_name : ''}`,
            isBot: from.is_bot,
          },
          text: ctx.message.text ?? ctx.message.caption ?? '',
          timestamp: ctx.message.date * 1000,
          threadId: ctx.message.message_thread_id ? String(ctx.message.message_thread_id) : undefined,
          replyToId: ctx.message.reply_to_message?.message_id
            ? String(ctx.message.reply_to_message.message_id)
            : undefined,
        };

        this.buffer.push(msg);
        logger.debug(`[telegram] Message from ${msg.sender.name} in ${chatName}`);
      });

      // Start polling in background (non-blocking)
      this.bot.start({
        onStart: () => {
          logger.info('[telegram] Bot connected and polling');
        },
      });

      this.state = 'connected';
    } catch (err) {
      this.state = 'error';
      logger.logError('[telegram] Failed to connect', err);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.state === 'disconnected') return;
    try {
      this.bot.stop();
    } catch {
      // Ignore stop errors
    }
    this.state = 'disconnected';
    logger.info('[telegram] Disconnected');
  }

  async send(options: SendOptions): Promise<SendResult> {
    try {
      const params: Record<string, unknown> = {};
      if (options.replyToId) {
        params['reply_parameters'] = { message_id: parseInt(options.replyToId, 10) };
      }
      if (options.threadId) {
        params['message_thread_id'] = parseInt(options.threadId, 10);
      }

      const result = await this.bot.api.sendMessage(
        options.channelId,
        options.text,
        params,
      );

      return { success: true, messageId: String(result.message_id) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.logError('[telegram] Send failed', err);
      return { success: false, error: message };
    }
  }

  async getHistory(options: HistoryOptions): Promise<ChannelMessage[]> {
    // Telegram Bot API has no getHistory endpoint.
    // Return buffered messages for this channel instead.
    return this.buffer.toArray().filter((m) => m.channelId === options.channelId);
  }

  async listChannels(): Promise<ChannelInfo[]> {
    // Telegram bots can only discover chats they've received messages from
    return Array.from(this.knownChats.entries()).map(([id, name]) => ({
      id,
      name,
      type: 'chat',
    }));
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.bot.api.getMe();
      return true;
    } catch {
      return false;
    }
  }
}
