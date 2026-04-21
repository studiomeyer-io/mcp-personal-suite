import { describe, it, expect } from 'vitest';
import {
  jsonResponse,
  errorResponse,
  textResponse,
} from '../src/lib/tool-response.js';

describe('tool-response — jsonResponse', () => {
  it('returns a well-formed MCP ToolResponse', () => {
    const res = jsonResponse({ ok: true, count: 5 });
    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe('text');
    const body = JSON.parse(res.content[0].text);
    expect(body).toEqual({ ok: true, count: 5 });
  });

  it('passes isError through', () => {
    const res = jsonResponse({ error: 'nope' }, true);
    expect(res.isError).toBe(true);
  });

  it('sanitizes secrets embedded in the serialized payload', () => {
    const res = jsonResponse({ token: 'Bearer sk-abcdefghij1234567890abcdef' });
    expect(res.content[0].text).toContain('[REDACTED]');
    expect(res.content[0].text).not.toContain('sk-abcdefghij1234567890abcdef');
  });
});

describe('tool-response — errorResponse', () => {
  it('defaults to code="ERROR" and isError=true', () => {
    const res = errorResponse('boom');
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0].text);
    expect(body).toEqual({ error: 'boom', code: 'ERROR' });
  });

  it('accepts a custom code and extra fields', () => {
    const res = errorResponse('nope', 'NOT_CONFIGURED', { hint: 'run suite_setup' });
    const body = JSON.parse(res.content[0].text);
    expect(body).toEqual({ error: 'nope', code: 'NOT_CONFIGURED', hint: 'run suite_setup' });
  });
});

describe('tool-response — textResponse', () => {
  it('wraps a plain string as a ToolResponse', () => {
    const res = textResponse('Hello');
    expect(res.content[0].text).toBe('Hello');
    expect(res.isError).toBeUndefined();
  });

  it('sanitizes the plain string too', () => {
    const res = textResponse('got Bearer sk-abcdefghij1234567890abcdef here');
    expect(res.content[0].text).toContain('Bearer [REDACTED]');
  });
});
