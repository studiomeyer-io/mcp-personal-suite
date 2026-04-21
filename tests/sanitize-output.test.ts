import { describe, it, expect } from 'vitest';
import { sanitizeToolOutput, type ToolOutput } from '../src/lib/sanitize-output.js';

describe('sanitizeToolOutput', () => {
  it('scrubs Bearer tokens from content[*].text', () => {
    const out = sanitizeToolOutput({
      content: [{ type: 'text', text: 'OAuth header: Bearer sk-ant-1234567890abcdefghij' }],
    });
    expect(out.content[0].text).toContain('Bearer [REDACTED]');
    expect(out.content[0].text).not.toContain('sk-ant-1234567890');
  });

  it('scrubs Anthropic / OpenAI / xox / AKIA / Stripe tokens', () => {
    // Fixtures are built from fragments so GitHub Push Protection does
    // not treat the test file itself as a leak.
    const text =
      'anthropic=' + 'sk' + '-ant' + '-1234567890abcdefghij, ' +
      'openai=' + 'sk' + '-abcdefghijklmnopqrstuvwx, ' +
      'slack=' + 'xox' + 'b-1234567890-abcdefghij, ' +
      'aws=' + 'AKIA' + 'ABCDEFGHIJKLMNOP, ' +
      'stripe=' + 'sk' + '_' + 'live' + '_' + '1234567890abcdefghijklmn';
    const out = sanitizeToolOutput({ content: [{ type: 'text', text }] });
    const s = out.content[0].text;
    expect(s).toContain('sk-ant-[REDACTED]');
    expect(s).toContain('sk-[REDACTED]');
    expect(s).toContain('xox[REDACTED]');
    expect(s).toContain('[AWS_KEY_REDACTED]');
    expect(s).toContain('[STRIPE_KEY_REDACTED]');
  });

  it('scrubs Tavily / fal.ai / Google refresh / SMTP AUTH / WhatsApp session (Session 840 Critic)', () => {
    // Again fragment-based to avoid push-protection false positives.
    const text =
      'tavily=' + 'tvly' + '-abcdefghijklmnopqrstuv, ' +
      'falai=' + 'fal' + '-abcdefghijklmnop1234567890, ' +
      'google=' + '1' + '//0eABCDEFGhijklmnOPQRSTUVWXYZ1234567890AbCdEfGh, ' +
      'smtp: ' + 'AUTH' + ' ' + 'PLAIN' + ' AGZvbwpiYXIKZGVtb0BzbXRwLmV4YW1wbGU=, ' +
      'baileys={' + '"noise' + 'Key":"Zm9vPT0="}';
    const out = sanitizeToolOutput({ content: [{ type: 'text', text }] });
    const s = out.content[0].text;
    expect(s).toContain('[TAVILY_KEY_REDACTED]');
    expect(s).toContain('[FAL_KEY_REDACTED]');
    expect(s).toContain('[GOOGLE_REFRESH_TOKEN_REDACTED]');
    expect(s).toContain('AUTH PLAIN [REDACTED]');
    expect(s).toContain('[WHATSAPP_AUTH_REDACTED]');
    // None of the original secrets should have survived.
    expect(s).not.toContain('tvly-abcdefghijklmnopqrstuv');
    expect(s).not.toContain('fal-abcdefghijklmnop1234567890');
    expect(s).not.toContain('1//0eABCDEFG');
    expect(s).not.toContain('AGZvbwpiYXIK');
    expect(s).not.toContain('Zm9vPT0=');
  });

  it('scrubs strings in nested custom fields', () => {
    const out = sanitizeToolOutput({
      content: [{ type: 'text', text: 'ok' }],
      nested: {
        deeper: {
          token: 'Bearer sk-abcdefghij1234567890abcdef',
          safe: 'hello world',
          arr: ['sk-abcdefghij1234567890abcdef', 123, null],
        },
      },
    } as unknown as ToolOutput);
    const nested = (out.nested as { deeper: { token: string; safe: string; arr: unknown[] } }).deeper;
    expect(nested.token).toContain('Bearer [REDACTED]');
    expect(nested.safe).toBe('hello world');
    expect(nested.arr[0]).toContain('sk-[REDACTED]');
    expect(nested.arr[1]).toBe(123);
    expect(nested.arr[2]).toBe(null);
  });

  it('passes through non-string primitives unchanged', () => {
    const out = sanitizeToolOutput({
      content: [{ type: 'text', text: 'no secret here' }],
      isError: false,
      meta: { count: 42, active: true, other: null },
    } as ToolOutput);
    expect(out.isError).toBe(false);
    expect((out.meta as { count: number }).count).toBe(42);
    expect((out.meta as { active: boolean }).active).toBe(true);
  });

  it('preserves the content array shape (MCP spec)', () => {
    const out = sanitizeToolOutput({
      content: [
        { type: 'text', text: 'Bearer sk-abcdefghij1234567890abcdef' },
        { type: 'text', text: 'another line' },
      ],
    });
    expect(out.content).toHaveLength(2);
    expect(out.content[0].type).toBe('text');
    expect(out.content[0].text).toContain('[REDACTED]');
    expect(out.content[1].text).toBe('another line');
  });

  it('does nothing when content is missing or malformed', () => {
    const out = sanitizeToolOutput({ content: null as unknown as ToolOutput['content'] });
    expect(out.content).toBe(null);
  });
});
