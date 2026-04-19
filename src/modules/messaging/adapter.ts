/**
 * Channel Adapter — Unified interface for all messaging platforms.
 *
 * Every platform (Telegram, Discord, Slack, WhatsApp) implements this interface.
 * Tools are platform-agnostic — they only speak ChannelAdapter.
 */

import type { MessageBuffer } from './buffer.js';

// ---- Platform Types ----

export type Platform = 'telegram' | 'discord' | 'slack' | 'whatsapp';

export type ChannelState = 'disconnected' | 'connecting' | 'connected' | 'error';

// ---- Message Types ----

export interface ChannelMessage {
  id: string;
  platform: Platform;
  channelId: string;
  channelName?: string;
  sender: {
    id: string;
    name: string;
    isBot: boolean;
  };
  text: string;
  timestamp: number;
  threadId?: string;
  replyToId?: string;
  mediaUrl?: string;
}

export interface SendOptions {
  channelId: string;
  text: string;
  threadId?: string;
  mediaUrl?: string;
  replyToId?: string;
}

export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface HistoryOptions {
  channelId: string;
  limit?: number;
  before?: number;
  threadId?: string;
}

export interface ChannelInfo {
  id: string;
  name: string;
  type: string;
}

// ---- Adapter Interface ----

export interface ChannelAdapter {
  readonly platform: Platform;
  state: ChannelState;
  readonly buffer: MessageBuffer;

  /** Connect to the platform (idempotent — no-op if already connected) */
  connect(): Promise<void>;

  /** Disconnect gracefully */
  disconnect(): Promise<void>;

  /** Send a message */
  send(options: SendOptions): Promise<SendResult>;

  /** Get message history from the platform API (not the buffer) */
  getHistory(options: HistoryOptions): Promise<ChannelMessage[]>;

  /** List available channels/groups/conversations */
  listChannels(): Promise<ChannelInfo[]>;

  /** Health check */
  isHealthy(): Promise<boolean>;
}
