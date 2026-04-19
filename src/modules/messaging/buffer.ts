/**
 * Ring Buffer for incoming messages.
 *
 * Fixed-capacity circular buffer. Oldest messages are overwritten
 * when capacity is exceeded. O(1) push, O(n) scan.
 */

import type { ChannelMessage } from './adapter.js';

export class MessageBuffer {
  private buffer: Array<ChannelMessage | null>;
  private head = 0;
  private count = 0;

  constructor(private capacity: number = 100) {
    this.buffer = new Array<ChannelMessage | null>(capacity).fill(null);
  }

  /** Push a message. Overwrites oldest if at capacity. */
  push(message: ChannelMessage): void {
    this.buffer[this.head] = message;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /** Get messages newer than the given timestamp. */
  getSince(timestamp: number): ChannelMessage[] {
    return this.toArray().filter((m) => m.timestamp > timestamp);
  }

  /** Get the most recent N messages (newest last). */
  getRecent(limit: number): ChannelMessage[] {
    const all = this.toArray();
    return limit >= all.length ? all : all.slice(-limit);
  }

  /** Get all messages in chronological order. */
  toArray(): ChannelMessage[] {
    if (this.count === 0) return [];

    const result: ChannelMessage[] = [];
    const start = this.count < this.capacity ? 0 : this.head;

    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % this.capacity;
      const msg = this.buffer[idx];
      if (msg) result.push(msg);
    }

    return result;
  }

  /** Clear all messages. */
  clear(): void {
    this.buffer = new Array<ChannelMessage | null>(this.capacity).fill(null);
    this.head = 0;
    this.count = 0;
  }

  get size(): number {
    return this.count;
  }
}
