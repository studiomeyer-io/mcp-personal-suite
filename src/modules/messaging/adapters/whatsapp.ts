/**
 * WhatsApp Adapter — Uses @whiskeysockets/baileys for WhatsApp Web.
 *
 * Auth: QR Code scan (generates auth state files on disk)
 * Mode: WebSocket (persistent connection to WhatsApp servers)
 * Note: This uses the unofficial WhatsApp Web API — use responsibly.
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  type WASocket,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
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

export class WhatsAppAdapter implements ChannelAdapter {
  readonly platform: Platform = 'whatsapp';
  state: ChannelState = 'disconnected';
  readonly buffer: MessageBuffer;

  private sock: WASocket | null = null;
  private authDir: string;
  private knownChats = new Map<string, string>();
  private reconnectAttempts = 0;
  private static readonly MAX_RECONNECT = 5;

  /** Last raw QR code string from Baileys (WhatsApp pairing URI, not an image) */
  lastQrCode: string | null = null;
  /** Whether this adapter needs QR scanning (no saved auth state) */
  needsQrScan = false;

  constructor(authDir: string, bufferSize = 100) {
    this.authDir = authDir;
    this.buffer = new MessageBuffer(bufferSize);
  }

  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') return;
    this.state = 'connecting';
    this.lastQrCode = null;
    this.needsQrScan = false;

    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

      // Detect if we have saved credentials
      const hasCreds = !!(state.creds && state.creds.me);
      if (!hasCreds) {
        this.needsQrScan = true;
        logger.warn('[whatsapp] No saved credentials — QR code scan required.');
      }

      this.sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
      });

      // Capture QR code for programmatic access
      this.sock.ev.on('connection.update', (update) => {
        if (update.qr) {
          this.lastQrCode = Buffer.from(update.qr).toString('base64');
          this.needsQrScan = true;
          logger.info('[whatsapp] QR code generated. Use channel_status or channel_connect to retrieve it.');
        }
      });

      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
          const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
          if (reason !== DisconnectReason.loggedOut && this.reconnectAttempts < WhatsAppAdapter.MAX_RECONNECT) {
            this.reconnectAttempts++;
            const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
            logger.warn(`[whatsapp] Connection closed, reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${WhatsAppAdapter.MAX_RECONNECT})`, { reason });
            setTimeout(() => {
              this.connect().catch(() => { this.state = 'error'; });
            }, delay);
          } else if (reason !== DisconnectReason.loggedOut) {
            logger.error(`[whatsapp] Max reconnect attempts (${WhatsAppAdapter.MAX_RECONNECT}) reached. Giving up.`);
            this.state = 'error';
          } else {
            logger.info('[whatsapp] Logged out');
            this.state = 'disconnected';
          }
        } else if (connection === 'open') {
          logger.info('[whatsapp] Connected');
          this.state = 'connected';
          this.lastQrCode = null;
          this.needsQrScan = false;
        }
      });

      this.sock.ev.on('messages.upsert', ({ messages }) => {
        for (const msg of messages) {
          if (!msg.message || msg.key.fromMe) continue;

          const jid = msg.key.remoteJid ?? '';
          const pushName = msg.pushName ?? jid.split('@')[0];
          const text = msg.message.conversation
            ?? msg.message.extendedTextMessage?.text
            ?? msg.message.imageMessage?.caption
            ?? '';

          this.knownChats.set(jid, pushName);

          const channelMsg: ChannelMessage = {
            id: msg.key.id ?? String(Date.now()),
            platform: 'whatsapp',
            channelId: jid,
            channelName: pushName,
            sender: {
              id: msg.key.participant ?? jid,
              name: pushName,
              isBot: false,
            },
            text,
            timestamp: (msg.messageTimestamp as number) * 1000,
          };

          this.buffer.push(channelMsg);
          logger.debug(`[whatsapp] Message from ${pushName}`);
        }
      });

      // Wait for connection to be established
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connection timeout')), 60000);
        this.sock!.ev.on('connection.update', (update) => {
          if (update.connection === 'open') {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
    } catch (err) {
      this.state = 'error';
      logger.logError('[whatsapp] Failed to connect', err);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.state === 'disconnected') return;
    try {
      this.sock?.end(undefined);
    } catch {
      // Ignore
    }
    this.sock = null;
    this.state = 'disconnected';
    logger.info('[whatsapp] Disconnected');
  }

  async send(options: SendOptions): Promise<SendResult> {
    if (!this.sock) return { success: false, error: 'Not connected' };
    try {
      const result = await this.sock.sendMessage(options.channelId, { text: options.text });
      return { success: true, messageId: result?.key.id ?? undefined };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.logError('[whatsapp] Send failed', err);
      return { success: false, error: message };
    }
  }

  async getHistory(options: HistoryOptions): Promise<ChannelMessage[]> {
    // WhatsApp Web API doesn't support fetching chat history easily
    return this.buffer.toArray().filter((m) => m.channelId === options.channelId);
  }

  async listChannels(): Promise<ChannelInfo[]> {
    return Array.from(this.knownChats.entries()).map(([id, name]) => ({
      id,
      name,
      type: id.endsWith('@g.us') ? 'group' : 'dm',
    }));
  }

  async isHealthy(): Promise<boolean> {
    return this.sock !== null && this.state === 'connected';
  }
}
