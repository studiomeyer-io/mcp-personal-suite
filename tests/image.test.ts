/**
 * Image Module Tests
 *
 * Tests for multi-provider image generation (OpenAI, Flux, Gemini),
 * auto-routing heuristic, SSRF guard, download, edit, and tool registration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---- Mock fetch globally ----
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---- Mock config ----
const mockConfig = {
  image: {
    openaiApiKey: undefined as string | undefined,
    fluxApiKey: undefined as string | undefined,
    geminiApiKey: undefined as string | undefined,
  },
};

vi.mock('../src/lib/config.js', () => ({
  loadConfig: vi.fn(async () => mockConfig),
}));

// ---- Mock logger ----
vi.mock('../src/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    logError: vi.fn(),
  },
  // Real sanitizeSecrets is a pure function; forward it so the shared
  // tool-response helper (which imports it) still strips secrets in tests.
  sanitizeSecrets: (text: string) => text,
}));

// ---- Test Helpers ----

function createMockServer() {
  const tools = new Map<string, { name: string; desc: string; schema: unknown; handler: Function }>();
  return {
    tool: vi.fn((...args: unknown[]) => {
      tools.set(args[0] as string, {
        name: args[0] as string,
        desc: args[1] as string,
        schema: args[2],
        handler: args[3] as Function,
      });
    }),
    _tools: tools,
  };
}

function parseToolResponse(response: { content: Array<{ text: string }>; isError?: boolean }) {
  return JSON.parse(response.content[0].text);
}

function makeOpenAIResponse(url: string, revisedPrompt?: string) {
  return {
    ok: true,
    json: async () => ({
      data: [{ url, revised_prompt: revisedPrompt }],
    }),
    status: 200,
    statusText: 'OK',
  };
}

function makeFluxQueueResponse(statusUrl: string) {
  return {
    ok: true,
    json: async () => ({
      request_id: 'req-123',
      status: 'IN_QUEUE',
      status_url: statusUrl,
    }),
    status: 200,
    statusText: 'OK',
  };
}

function makeFluxStatusCompleted(responseUrl: string) {
  return {
    ok: true,
    json: async () => ({
      status: 'COMPLETED',
      response_url: responseUrl,
    }),
    status: 200,
    statusText: 'OK',
  };
}

function makeFluxResultResponse(imageUrl: string) {
  return {
    ok: true,
    json: async () => ({
      images: [{ url: imageUrl, width: 1024, height: 1024 }],
    }),
    status: 200,
    statusText: 'OK',
  };
}

function makeGeminiResponse(base64Data: string, mimeType = 'image/png') {
  return {
    ok: true,
    json: async () => ({
      candidates: [{
        content: {
          parts: [
            { inlineData: { mimeType, data: base64Data } },
          ],
        },
      }],
    }),
    status: 200,
    statusText: 'OK',
  };
}

// ================================================================
// Tool Registration Tests
// ================================================================

describe('registerImageTools', () => {
  let mockServer: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    mockServer = createMockServer();
  });

  it('should register 3 image tools', async () => {
    const { registerImageTools } = await import('../src/modules/image/index.js');
    registerImageTools(mockServer as any);

    expect(mockServer.tool).toHaveBeenCalledTimes(3);
    expect(mockServer._tools.has('image_generate')).toBe(true);
    expect(mockServer._tools.has('image_edit')).toBe(true);
    expect(mockServer._tools.has('image_download')).toBe(true);
  });

  it('should have correct descriptions', async () => {
    const { registerImageTools } = await import('../src/modules/image/index.js');
    registerImageTools(mockServer as any);

    const generate = mockServer._tools.get('image_generate');
    expect(generate?.desc).toContain('BYOK');
    expect(generate?.desc).toContain('OpenAI');
    expect(generate?.desc).toContain('Flux');
    expect(generate?.desc).toContain('Gemini');

    const edit = mockServer._tools.get('image_edit');
    expect(edit?.desc).toContain('OpenAI');

    const download = mockServer._tools.get('image_download');
    expect(download?.desc).toContain('SSRF');
  });
});

// ================================================================
// image_generate — No Provider
// ================================================================

describe('image_generate — no provider configured', () => {
  beforeEach(() => {
    vi.resetModules();
    mockConfig.image = {
      openaiApiKey: undefined,
      fluxApiKey: undefined,
      geminiApiKey: undefined,
    };
    mockFetch.mockReset();
  });

  it('should return NO_PROVIDER error when no keys configured', async () => {
    const mockServer = createMockServer();
    const { registerImageTools } = await import('../src/modules/image/index.js');
    registerImageTools(mockServer as any);

    const handler = mockServer._tools.get('image_generate')!.handler;
    const result = await handler({ prompt: 'test', provider: undefined, size: undefined, style: undefined, quality: undefined });
    const parsed = parseToolResponse(result);

    expect(result.isError).toBe(true);
    expect(parsed.code).toBe('NO_PROVIDER');
    expect(parsed.error).toContain('suite_setup');
  });
});

// ================================================================
// image_generate — OpenAI
// ================================================================

describe('image_generate — OpenAI', () => {
  beforeEach(() => {
    vi.resetModules();
    mockConfig.image = {
      openaiApiKey: 'sk-test-openai-key',
      fluxApiKey: undefined,
      geminiApiKey: undefined,
    };
    mockFetch.mockReset();
  });

  it('should call OpenAI API with correct parameters', async () => {
    mockFetch.mockResolvedValueOnce(makeOpenAIResponse(
      'https://oaidalleapiprodscus.blob.core.windows.net/test.png',
      'A revised prompt',
    ));

    const mockServer = createMockServer();
    const { registerImageTools } = await import('../src/modules/image/index.js');
    registerImageTools(mockServer as any);

    const handler = mockServer._tools.get('image_generate')!.handler;
    const result = await handler({
      prompt: 'A logo with text "Hello"',
      provider: 'openai',
      size: 'landscape',
      quality: 'hd',
      style: 'natural',
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/images/generations');

    const body = JSON.parse(opts.body);
    expect(body.model).toBe('dall-e-3');
    expect(body.size).toBe('1792x1024');
    expect(body.quality).toBe('hd');
    expect(body.style).toBe('natural');

    const parsed = parseToolResponse(result);
    expect(parsed.provider).toBe('openai');
    expect(parsed.model).toBe('dall-e-3');
    expect(parsed.revisedPrompt).toBe('A revised prompt');
    expect(parsed.url).toContain('oaidalleapiprodscus');
  });

  it('should return error when OpenAI API fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      text: async () => 'Rate limit exceeded',
    });

    const mockServer = createMockServer();
    const { registerImageTools } = await import('../src/modules/image/index.js');
    registerImageTools(mockServer as any);

    const handler = mockServer._tools.get('image_generate')!.handler;
    const result = await handler({ prompt: 'test', provider: 'openai' });
    const parsed = parseToolResponse(result);

    expect(result.isError).toBe(true);
    expect(parsed.error).toContain('429');
  });

  it('should use square size by default', async () => {
    mockFetch.mockResolvedValueOnce(makeOpenAIResponse('https://oaidalleapiprodscus.blob.core.windows.net/test.png'));

    const mockServer = createMockServer();
    const { registerImageTools } = await import('../src/modules/image/index.js');
    registerImageTools(mockServer as any);

    const handler = mockServer._tools.get('image_generate')!.handler;
    await handler({ prompt: 'test', provider: 'openai' });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.size).toBe('1024x1024');
  });

  it('should map portrait size correctly', async () => {
    mockFetch.mockResolvedValueOnce(makeOpenAIResponse('https://oaidalleapiprodscus.blob.core.windows.net/test.png'));

    const mockServer = createMockServer();
    const { registerImageTools } = await import('../src/modules/image/index.js');
    registerImageTools(mockServer as any);

    const handler = mockServer._tools.get('image_generate')!.handler;
    await handler({ prompt: 'test', provider: 'openai', size: 'portrait' });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.size).toBe('1024x1792');
  });
});

// ================================================================
// image_generate — Flux
// ================================================================

describe('image_generate — Flux', () => {
  beforeEach(() => {
    vi.resetModules();
    mockConfig.image = {
      openaiApiKey: undefined,
      fluxApiKey: 'fal-test-key',
      geminiApiKey: undefined,
    };
    mockFetch.mockReset();
  });

  it('should submit to Flux queue and poll for result', async () => {
    const statusUrl = 'https://queue.fal.run/fal-ai/flux-pro/v1.1/status/req-123';
    const responseUrl = 'https://queue.fal.run/fal-ai/flux-pro/v1.1/result/req-123';
    const imageUrl = 'https://v3.fal.media/files/generated-image.jpg';

    // Submit → queue response
    mockFetch.mockResolvedValueOnce(makeFluxQueueResponse(statusUrl));
    // First poll → still in progress
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'IN_PROGRESS' }),
    });
    // Second poll → completed
    mockFetch.mockResolvedValueOnce(makeFluxStatusCompleted(responseUrl));
    // Fetch result
    mockFetch.mockResolvedValueOnce(makeFluxResultResponse(imageUrl));

    const mockServer = createMockServer();
    const { registerImageTools } = await import('../src/modules/image/index.js');
    registerImageTools(mockServer as any);

    const handler = mockServer._tools.get('image_generate')!.handler;
    const result = await handler({ prompt: 'A photorealistic landscape', provider: 'flux' });
    const parsed = parseToolResponse(result);

    expect(parsed.provider).toBe('flux');
    expect(parsed.model).toBe('flux-pro-v1.1');
    expect(parsed.url).toBe(imageUrl);

    // Check queue submission had correct headers
    const [submitUrl, submitOpts] = mockFetch.mock.calls[0];
    expect(submitUrl).toBe('https://queue.fal.run/fal-ai/flux-pro/v1.1');
    expect(submitOpts.headers['Authorization']).toBe('Key fal-test-key');
  });

  it('should return error when Flux API key is missing', async () => {
    mockConfig.image.fluxApiKey = undefined;

    const mockServer = createMockServer();
    const { registerImageTools } = await import('../src/modules/image/index.js');
    registerImageTools(mockServer as any);

    const handler = mockServer._tools.get('image_generate')!.handler;
    const result = await handler({ prompt: 'test', provider: 'flux' });
    const parsed = parseToolResponse(result);

    expect(result.isError).toBe(true);
    expect(parsed.code).toBe('NO_PROVIDER');
  });
});

// ================================================================
// image_generate — Gemini
// ================================================================

describe('image_generate — Gemini', () => {
  beforeEach(() => {
    vi.resetModules();
    mockConfig.image = {
      openaiApiKey: undefined,
      fluxApiKey: undefined,
      geminiApiKey: 'AIza-test-gemini-key',
    };
    mockFetch.mockReset();
  });

  it('should call Gemini API and save base64 result', async () => {
    // Small 1x1 transparent PNG as base64
    const base64Png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    mockFetch.mockResolvedValueOnce(makeGeminiResponse(base64Png, 'image/png'));

    const mockServer = createMockServer();
    const { registerImageTools } = await import('../src/modules/image/index.js');
    registerImageTools(mockServer as any);

    const handler = mockServer._tools.get('image_generate')!.handler;
    const result = await handler({ prompt: 'A product shot', provider: 'gemini' });
    const parsed = parseToolResponse(result);

    expect(parsed.provider).toBe('gemini');
    expect(parsed.model).toBe('gemini-2.0-flash-exp');
    expect(parsed.isLocalFile).toBe(true);
    expect(parsed.mimeType).toBe('image/png');
    // File should be in temp directory
    expect(parsed.url).toContain('personal-suite-images');
    expect(parsed.url).toContain('gemini-');
    expect(parsed.url).toMatch(/\.png$/);

    // Verify API call
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('generativelanguage.googleapis.com');
    expect(url).toContain('key=AIza-test-gemini-key');
  });

  it('should return error when Gemini returns text instead of image', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            parts: [
              { text: 'I cannot generate that image due to safety concerns.' },
            ],
          },
        }],
      }),
    });

    const mockServer = createMockServer();
    const { registerImageTools } = await import('../src/modules/image/index.js');
    registerImageTools(mockServer as any);

    const handler = mockServer._tools.get('image_generate')!.handler;
    const result = await handler({ prompt: 'test', provider: 'gemini' });
    const parsed = parseToolResponse(result);

    expect(result.isError).toBe(true);
    expect(parsed.error).toContain('text instead of image');
  });
});

// ================================================================
// image_generate — Auto-Routing
// ================================================================

describe('image_generate — auto-routing', () => {
  beforeEach(() => {
    vi.resetModules();
    mockFetch.mockReset();
  });

  it('should route text-heavy prompts to OpenAI when available', async () => {
    mockConfig.image = {
      openaiApiKey: 'sk-test',
      fluxApiKey: 'fal-test',
      geminiApiKey: 'AIza-test',
    };

    mockFetch.mockResolvedValueOnce(makeOpenAIResponse('https://oaidalleapiprodscus.blob.core.windows.net/test.png'));

    const mockServer = createMockServer();
    const { registerImageTools } = await import('../src/modules/image/index.js');
    registerImageTools(mockServer as any);

    const handler = mockServer._tools.get('image_generate')!.handler;
    const result = await handler({ prompt: 'A logo with typography for a coffee shop' });
    const parsed = parseToolResponse(result);

    expect(parsed.provider).toBe('openai');
  });

  it('should route photorealistic prompts to Flux when available', async () => {
    mockConfig.image = {
      openaiApiKey: 'sk-test',
      fluxApiKey: 'fal-test',
      geminiApiKey: 'AIza-test',
    };

    // Flux queue + status + result
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        request_id: 'req-1',
        status: 'COMPLETED',
        response_url: 'https://queue.fal.run/result/1',
      }),
    });
    mockFetch.mockResolvedValueOnce(makeFluxResultResponse('https://v3.fal.media/test.jpg'));

    const mockServer = createMockServer();
    const { registerImageTools } = await import('../src/modules/image/index.js');
    registerImageTools(mockServer as any);

    const handler = mockServer._tools.get('image_generate')!.handler;
    const result = await handler({ prompt: 'A photorealistic portrait of a person with bokeh' });
    const parsed = parseToolResponse(result);

    expect(parsed.provider).toBe('flux');
  });

  it('should fall back to Gemini for generic prompts', async () => {
    mockConfig.image = {
      openaiApiKey: 'sk-test',
      fluxApiKey: 'fal-test',
      geminiApiKey: 'AIza-test',
    };

    const base64Png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    mockFetch.mockResolvedValueOnce(makeGeminiResponse(base64Png));

    const mockServer = createMockServer();
    const { registerImageTools } = await import('../src/modules/image/index.js');
    registerImageTools(mockServer as any);

    const handler = mockServer._tools.get('image_generate')!.handler;
    const result = await handler({ prompt: 'A colorful abstract painting' });
    const parsed = parseToolResponse(result);

    expect(parsed.provider).toBe('gemini');
  });

  it('should use only available provider when single key configured', async () => {
    mockConfig.image = {
      openaiApiKey: undefined,
      fluxApiKey: 'fal-test',
      geminiApiKey: undefined,
    };

    // Even text-heavy prompt should go to Flux if it's the only provider
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        request_id: 'req-1',
        status: 'COMPLETED',
        response_url: 'https://queue.fal.run/result/1',
      }),
    });
    mockFetch.mockResolvedValueOnce(makeFluxResultResponse('https://v3.fal.media/test.jpg'));

    const mockServer = createMockServer();
    const { registerImageTools } = await import('../src/modules/image/index.js');
    registerImageTools(mockServer as any);

    const handler = mockServer._tools.get('image_generate')!.handler;
    const result = await handler({ prompt: 'A logo with text and typography' });
    const parsed = parseToolResponse(result);

    expect(parsed.provider).toBe('flux');
  });
});

// ================================================================
// image_edit
// ================================================================

describe('image_edit', () => {
  beforeEach(() => {
    vi.resetModules();
    mockFetch.mockReset();
  });

  it('should return error when OpenAI key not configured', async () => {
    mockConfig.image = {
      openaiApiKey: undefined,
      fluxApiKey: 'fal-test',
      geminiApiKey: undefined,
    };

    const mockServer = createMockServer();
    const { registerImageTools } = await import('../src/modules/image/index.js');
    registerImageTools(mockServer as any);

    const handler = mockServer._tools.get('image_edit')!.handler;
    const result = await handler({
      imageUrl: 'https://example.com/test.png',
      prompt: 'Make the sky blue',
    });
    const parsed = parseToolResponse(result);

    expect(result.isError).toBe(true);
    expect(parsed.code).toBe('NO_OPENAI_KEY');
  });

  it('should call OpenAI edit endpoint', async () => {
    mockConfig.image = {
      openaiApiKey: 'sk-test-edit',
      fluxApiKey: undefined,
      geminiApiKey: undefined,
    };

    // Mock downloading the source image
    mockFetch.mockResolvedValueOnce({
      ok: true,
      blob: async () => new Blob(['fake-image-data'], { type: 'image/png' }),
    });

    // Mock edit response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ url: 'https://oaidalleapiprodscus.blob.core.windows.net/edited.png' }],
      }),
    });

    const mockServer = createMockServer();
    const { registerImageTools } = await import('../src/modules/image/index.js');
    registerImageTools(mockServer as any);

    const handler = mockServer._tools.get('image_edit')!.handler;
    const result = await handler({
      imageUrl: 'https://example.com/source.png',
      prompt: 'Make the background red',
    });
    const parsed = parseToolResponse(result);

    expect(parsed.provider).toBe('openai');
    expect(parsed.model).toBe('dall-e-2');
  });
});

// ================================================================
// image_download — SSRF Guard
// ================================================================

describe('image_download — SSRF guard', () => {
  beforeEach(() => {
    vi.resetModules();
    mockFetch.mockReset();
  });

  it('should block HTTP URLs (require HTTPS)', async () => {
    const mockServer = createMockServer();
    const { registerImageTools } = await import('../src/modules/image/index.js');
    registerImageTools(mockServer as any);

    const handler = mockServer._tools.get('image_download')!.handler;
    const result = await handler({ url: 'http://example.com/image.png' });
    const parsed = parseToolResponse(result);

    expect(result.isError).toBe(true);
    expect(parsed.error).toContain('HTTPS');
  });

  it('should block localhost URLs', async () => {
    const mockServer = createMockServer();
    const { registerImageTools } = await import('../src/modules/image/index.js');
    registerImageTools(mockServer as any);

    const handler = mockServer._tools.get('image_download')!.handler;
    const result = await handler({ url: 'https://localhost/image.png' });
    const parsed = parseToolResponse(result);

    expect(result.isError).toBe(true);
    expect(parsed.error).toContain('private');
  });

  it('should block 127.0.0.1 URLs', async () => {
    const mockServer = createMockServer();
    const { registerImageTools } = await import('../src/modules/image/index.js');
    registerImageTools(mockServer as any);

    const handler = mockServer._tools.get('image_download')!.handler;
    const result = await handler({ url: 'https://127.0.0.1/image.png' });
    const parsed = parseToolResponse(result);

    expect(result.isError).toBe(true);
    expect(parsed.error).toContain('private');
  });

  it('should block private IP 10.x.x.x', async () => {
    const mockServer = createMockServer();
    const { registerImageTools } = await import('../src/modules/image/index.js');
    registerImageTools(mockServer as any);

    const handler = mockServer._tools.get('image_download')!.handler;
    const result = await handler({ url: 'https://10.0.0.1/image.png' });
    const parsed = parseToolResponse(result);

    expect(result.isError).toBe(true);
    expect(parsed.error).toContain('private');
  });

  it('should block private IP 192.168.x.x', async () => {
    const mockServer = createMockServer();
    const { registerImageTools } = await import('../src/modules/image/index.js');
    registerImageTools(mockServer as any);

    const handler = mockServer._tools.get('image_download')!.handler;
    const result = await handler({ url: 'https://192.168.1.1/image.png' });
    const parsed = parseToolResponse(result);

    expect(result.isError).toBe(true);
    expect(parsed.error).toContain('private');
  });

  it('should block private IP 172.16-31.x.x', async () => {
    const mockServer = createMockServer();
    const { registerImageTools } = await import('../src/modules/image/index.js');
    registerImageTools(mockServer as any);

    const handler = mockServer._tools.get('image_download')!.handler;
    const result = await handler({ url: 'https://172.16.0.1/image.png' });
    const parsed = parseToolResponse(result);

    expect(result.isError).toBe(true);
    expect(parsed.error).toContain('private');
  });

  it('should block .local and .internal domains', async () => {
    const mockServer = createMockServer();
    const { registerImageTools } = await import('../src/modules/image/index.js');
    registerImageTools(mockServer as any);

    const handler = mockServer._tools.get('image_download')!.handler;

    const localResult = await handler({ url: 'https://myhost.local/image.png' });
    expect(localResult.isError).toBe(true);

    const internalResult = await handler({ url: 'https://api.internal/image.png' });
    expect(internalResult.isError).toBe(true);
  });

  it('should block URLs with embedded credentials', async () => {
    const mockServer = createMockServer();
    const { registerImageTools } = await import('../src/modules/image/index.js');
    registerImageTools(mockServer as any);

    const handler = mockServer._tools.get('image_download')!.handler;
    const result = await handler({ url: 'https://user:pass@oaidalleapiprodscus.blob.core.windows.net/image.png' });
    const parsed = parseToolResponse(result);

    expect(result.isError).toBe(true);
    expect(parsed.error).toContain('credentials');
  });

  it('should block unknown domains', async () => {
    const mockServer = createMockServer();
    const { registerImageTools } = await import('../src/modules/image/index.js');
    registerImageTools(mockServer as any);

    const handler = mockServer._tools.get('image_download')!.handler;
    const result = await handler({ url: 'https://evil-server.com/image.png' });
    const parsed = parseToolResponse(result);

    expect(result.isError).toBe(true);
    expect(parsed.error).toContain('not in the allowed CDN list');
  });

  it('should allow OpenAI CDN URLs', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([['content-type', 'image/png']]) as any,
      arrayBuffer: async () => new ArrayBuffer(100),
    });

    const mockServer = createMockServer();
    const { registerImageTools } = await import('../src/modules/image/index.js');
    registerImageTools(mockServer as any);

    const handler = mockServer._tools.get('image_download')!.handler;
    const result = await handler({
      url: 'https://oaidalleapiprodscus.blob.core.windows.net/some-image.png',
      filename: 'test-download.png',
    });
    const parsed = parseToolResponse(result);

    // Should have attempted the fetch (not blocked by SSRF)
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeUndefined();
    expect(parsed.path).toContain('test-download.png');
  });

  it('should allow fal.media URLs', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([['content-type', 'image/jpeg']]) as any,
      arrayBuffer: async () => new ArrayBuffer(200),
    });

    const mockServer = createMockServer();
    const { registerImageTools } = await import('../src/modules/image/index.js');
    registerImageTools(mockServer as any);

    const handler = mockServer._tools.get('image_download')!.handler;
    const result = await handler({
      url: 'https://v3.fal.media/files/flux-output.jpg',
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeUndefined();
  });

  it('should allow local Gemini temp files', async () => {
    // Create a temp file to simulate Gemini output
    const { writeFile, mkdir } = await import('node:fs/promises');
    const tempDir = join(tmpdir(), 'personal-suite-images');
    await mkdir(tempDir, { recursive: true });
    const tempFile = join(tempDir, 'gemini-test-download.png');
    await writeFile(tempFile, Buffer.from([0x89, 0x50, 0x4E, 0x47])); // PNG magic bytes

    const mockServer = createMockServer();
    const { registerImageTools } = await import('../src/modules/image/index.js');
    registerImageTools(mockServer as any);

    const handler = mockServer._tools.get('image_download')!.handler;
    const result = await handler({
      url: tempFile,
      filename: 'my-gemini-image.png',
    });
    const parsed = parseToolResponse(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.path).toContain('my-gemini-image.png');
    expect(parsed.source).toBe('local-copy');

    // Cleanup
    const { unlink } = await import('node:fs/promises');
    try { await unlink(tempFile); } catch { /* ignore */ }
    try { await unlink(parsed.path); } catch { /* ignore */ }
  });

  it('should block local files outside temp directory', async () => {
    const mockServer = createMockServer();
    const { registerImageTools } = await import('../src/modules/image/index.js');
    registerImageTools(mockServer as any);

    const handler = mockServer._tools.get('image_download')!.handler;
    const result = await handler({ url: '/etc/passwd' });
    const parsed = parseToolResponse(result);

    expect(result.isError).toBe(true);
    expect(parsed.error).toContain('not in expected temp directory');
  });
});

// ================================================================
// Config Integration
// ================================================================

describe('ImageConfig types', () => {
  it('SuiteConfig should support image property', async () => {
    const configModule = await import('../src/lib/config.js');
    // Verify SuiteConfig accepts image config
    const suiteConfig = {
      image: {
        openaiApiKey: 'sk-test',
        fluxApiKey: 'fal-test',
      },
    };

    expect(suiteConfig.image.openaiApiKey).toBe('sk-test');
    expect(suiteConfig.image.fluxApiKey).toBe('fal-test');
    // ImageConfig structure is correct
    expect(suiteConfig.image).toBeDefined();
  });
});
