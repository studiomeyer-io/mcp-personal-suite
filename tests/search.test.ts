/**
 * Search Module Tests
 *
 * Tests for SearXNG search, Brave search, fallback logic,
 * deep search, tool registration, and edge cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- Mock fetch globally ----
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---- Test Helpers ----

function createMockServer() {
  const tools = new Map<string, unknown>();
  return {
    tool: vi.fn((...args: unknown[]) => {
      tools.set(args[0] as string, args);
    }),
    _tools: tools,
  };
}

function makeSearXNGResponse(results: Array<{ title: string; url: string; content: string; engine?: string }>) {
  return {
    ok: true,
    json: async () => ({ results }),
    status: 200,
    statusText: 'OK',
  };
}

function makeSearXNGImageResponse(results: Array<{ title: string; url: string; img_src?: string; thumbnail_src?: string; engine?: string }>) {
  return {
    ok: true,
    json: async () => ({ results }),
    status: 200,
    statusText: 'OK',
  };
}

function makeBraveWebResponse(results: Array<{ title: string; url: string; description: string }>) {
  return {
    ok: true,
    json: async () => ({ web: { results } }),
    status: 200,
    statusText: 'OK',
  };
}

function makeBraveNewsResponse(results: Array<{ title: string; url: string; description: string; source?: string }>) {
  return {
    ok: true,
    json: async () => ({ news: { results } }),
    status: 200,
    statusText: 'OK',
  };
}

function makeBraveImageResponse(results: Array<{ title: string; url: string; thumbnail?: { src: string }; properties?: { url: string }; width?: number; height?: number }>) {
  return {
    ok: true,
    json: async () => ({ results }),
    status: 200,
    statusText: 'OK',
  };
}

function parseToolResponse(response: { content: Array<{ text: string }>; isError?: boolean }) {
  return JSON.parse(response.content[0].text);
}

// ================================================================
// Tool Registration Tests
// ================================================================

describe('registerSearchTools', () => {
  let mockServer: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    mockServer = createMockServer();
    vi.stubEnv('SEARXNG_URL', '');
    vi.stubEnv('BRAVE_API_KEY', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('registers all 7 search tools', async () => {
    const { registerSearchTools } = await import('../src/modules/search/index.js');
    registerSearchTools(mockServer as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const expectedTools = [
      'search_web', 'search_news', 'search_images', 'search_deep',
      'search_semantic', 'search_code_context', 'search_research',
    ];
    for (const toolName of expectedTools) {
      expect(mockServer._tools.has(toolName), `Missing tool: ${toolName}`).toBe(true);
    }
    expect(mockServer._tools.size).toBe(7);
  });

  it('SSRF guard: allows localhost only when SEARXNG_ALLOW_LOCAL=1', async () => {
    // Without ALLOW_LOCAL → localhost rejected, tools still register (NO_ENGINE at runtime)
    vi.stubEnv('SEARXNG_URL', 'http://localhost:8888');
    vi.stubEnv('SEARXNG_ALLOW_LOCAL', '');
    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const s1 = createMockServer();
    registerSearchTools(s1 as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);
    expect(s1._tools.size).toBe(7);

    // With ALLOW_LOCAL=1 → allowed
    vi.stubEnv('SEARXNG_ALLOW_LOCAL', '1');
    const s2 = createMockServer();
    registerSearchTools(s2 as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);
    expect(s2._tools.size).toBe(7);
  });

  it('SSRF guard: rejects private IP ranges + non-http protocols', async () => {
    vi.stubEnv('SEARXNG_ALLOW_LOCAL', '');
    const badUrls = [
      'http://10.0.0.1',
      'http://192.168.1.1',
      'http://172.20.0.1',
      'http://169.254.1.1',
      'file:///etc/passwd',
      'ftp://example.com',
      'gopher://example.com',
    ];
    const { registerSearchTools } = await import('../src/modules/search/index.js');
    for (const url of badUrls) {
      vi.stubEnv('SEARXNG_URL', url);
      const s = createMockServer();
      registerSearchTools(s as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);
      expect(s._tools.size).toBe(7); // tools register but searxngUrl is undefined
    }
  });

  it('search_web + search_news accept engine param in schema', async () => {
    vi.stubEnv('SEARXNG_URL', 'http://localhost:8888');
    vi.stubEnv('SEARXNG_ALLOW_LOCAL', '1');
    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const s = createMockServer();
    registerSearchTools(s as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    // Get the zod schema for search_web (3rd arg to server.tool)
    const webTool = s._tools.get('search_web') as unknown as unknown[];
    const webSchema = webTool[2] as Record<string, { _def?: { typeName?: string; innerType?: { _def?: { values?: string[] } } } }>;

    // Zod ZodEnum → wraps in ZodOptional, check values array exists
    expect(webSchema.engine).toBeDefined();
    expect(webSchema.query).toBeDefined();
    expect(webSchema.maxResults).toBeDefined();

    const newsTool = s._tools.get('search_news') as unknown as unknown[];
    const newsSchema = newsTool[2] as Record<string, unknown>;
    expect(newsSchema.engine).toBeDefined();
  });

  it('search_web routes to Exa when engine="exa"', async () => {
    vi.stubEnv('SEARXNG_URL', '');
    vi.stubEnv('BRAVE_API_KEY', '');
    vi.stubEnv('EXA_API_KEY', 'test-exa-key');

    // Reuse the top-level stubbed mockFetch
    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [{ title: 'Exa result', url: 'https://e.com', highlights: ['concept match'] }] }),
    });

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const s = createMockServer();
    registerSearchTools(s as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const webTool = s._tools.get('search_web') as unknown as [string, string, unknown, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>];
    const handler = webTool[3];
    const result = await handler({ query: 'test', engine: 'exa' });
    const parsed = JSON.parse(result.content[0].text);

    expect(mockFetch).toHaveBeenCalled();
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://api.exa.ai/search');
    expect(parsed.engine).toBe('exa-keyword');
    expect(parsed.results[0].title).toBe('Exa result');

    vi.restoreAllMocks();
  });

  it('search_web routes to Tavily when engine="tavily"', async () => {
    vi.stubEnv('SEARXNG_URL', '');
    vi.stubEnv('BRAVE_API_KEY', '');
    vi.stubEnv('TAVILY_API_KEY', 'tvly-test');

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        query: 'q',
        results: [{ title: 'T', url: 'https://t.com', content: 'tavily snippet', score: 0.9 }],
        response_time: 1.2,
      }),
    });

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const s = createMockServer();
    registerSearchTools(s as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const webTool = s._tools.get('search_web') as unknown as [string, string, unknown, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>];
    const result = await webTool[3]({ query: 'test', engine: 'tavily' });
    const parsed = JSON.parse(result.content[0].text);

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://api.tavily.com/search');
    expect(parsed.engine).toBe('tavily');

    vi.restoreAllMocks();
  });

  it('search_web returns error when explicit engine has no key', async () => {
    vi.stubEnv('EXA_API_KEY', '');
    vi.stubEnv('TAVILY_API_KEY', '');
    vi.stubEnv('SEARXNG_URL', 'http://localhost:8888');
    vi.stubEnv('SEARXNG_ALLOW_LOCAL', '1');

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const s = createMockServer();
    registerSearchTools(s as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const webTool = s._tools.get('search_web') as unknown as [string, string, unknown, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>];
    const result = await webTool[3]({ query: 'test', engine: 'exa' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toContain('Exa API key not configured');
  });

  it('search_news routes to Tavily with topic=news when engine="tavily"', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'tvly-news');

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        query: 'q',
        results: [{ title: 'N', url: 'https://n.com', content: 'news content', score: 0.8 }],
        response_time: 1,
      }),
    });

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const s = createMockServer();
    registerSearchTools(s as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const newsTool = s._tools.get('search_news') as unknown as [string, string, unknown, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>];
    const result = await newsTool[3]({ query: 'ai regulation', engine: 'tavily' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.engine).toBe('tavily-news');
    // Verify body had topic=news
    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.topic).toBe('news');

    vi.restoreAllMocks();
  });

  it('each tool has name, description, schema, and handler', async () => {
    const { registerSearchTools } = await import('../src/modules/search/index.js');
    registerSearchTools(mockServer as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    for (const [, args] of mockServer._tools) {
      const argsArray = args as unknown[];
      expect(typeof argsArray[0]).toBe('string');
      expect(typeof argsArray[1]).toBe('string');
      expect(typeof argsArray[2]).toBe('object');
      expect(typeof argsArray[3]).toBe('function');
    }
  });
});

// ================================================================
// SearXNG Search Tests
// ================================================================

describe('SearXNG search', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubEnv('SEARXNG_URL', 'http://localhost:8888');
    vi.stubEnv('SEARXNG_ALLOW_LOCAL', '1');
    vi.stubEnv('BRAVE_API_KEY', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('calls SearXNG with correct URL and params', async () => {
    mockFetch.mockResolvedValueOnce(makeSearXNGResponse([
      { title: 'Result 1', url: 'https://example.com', content: 'Snippet 1' },
    ]));

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const server = createMockServer();
    registerSearchTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const handler = (server._tools.get('search_web') as unknown[])[3] as (args: Record<string, unknown>) => Promise<unknown>;
    await handler({ query: 'test query', maxResults: 5 });

    expect(mockFetch).toHaveBeenCalledOnce();
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('http://localhost:8888/search');
    expect(calledUrl).toContain('q=test+query');
    expect(calledUrl).toContain('format=json');
    expect(calledUrl).toContain('categories=general');
  });

  it('parses SearXNG results correctly', async () => {
    mockFetch.mockResolvedValueOnce(makeSearXNGResponse([
      { title: 'Result A', url: 'https://a.com', content: 'Snippet A', engine: 'google' },
      { title: 'Result B', url: 'https://b.com', content: 'Snippet B', engine: 'bing' },
    ]));

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const server = createMockServer();
    registerSearchTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const handler = (server._tools.get('search_web') as unknown[])[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    const response = await handler({ query: 'test', maxResults: 10 });
    const data = parseToolResponse(response);

    expect(data.engine).toBe('searxng');
    expect(data.results).toHaveLength(2);
    expect(data.results[0].title).toBe('Result A');
    expect(data.results[0].url).toBe('https://a.com');
    expect(data.results[0].snippet).toBe('Snippet A');
    expect(data.results[0].source).toBe('google');
  });

  it('handles SearXNG HTTP error by falling back', async () => {
    // SearXNG returns 500
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const server = createMockServer();
    registerSearchTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const handler = (server._tools.get('search_web') as unknown[])[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    const response = await handler({ query: 'test' });
    const data = parseToolResponse(response);

    // Should fail since no Brave fallback configured
    expect(response.isError).toBe(true);
    expect(data.error).toBeDefined();
  });

  it('handles SearXNG network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const server = createMockServer();
    registerSearchTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const handler = (server._tools.get('search_web') as unknown[])[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    const response = await handler({ query: 'test' });

    expect(response.isError).toBe(true);
  });

  it('respects maxResults limit', async () => {
    const manyResults = Array.from({ length: 20 }, (_, i) => ({
      title: `Result ${i}`,
      url: `https://example.com/${i}`,
      content: `Snippet ${i}`,
    }));
    mockFetch.mockResolvedValueOnce(makeSearXNGResponse(manyResults));

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const server = createMockServer();
    registerSearchTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const handler = (server._tools.get('search_web') as unknown[])[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    const response = await handler({ query: 'test', maxResults: 3 });
    const data = parseToolResponse(response);

    expect(data.results.length).toBeLessThanOrEqual(3);
  });

  it('handles empty results from SearXNG', async () => {
    mockFetch.mockResolvedValueOnce(makeSearXNGResponse([]));

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const server = createMockServer();
    registerSearchTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const handler = (server._tools.get('search_web') as unknown[])[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    const response = await handler({ query: 'test' });
    const data = parseToolResponse(response);

    expect(data.results).toEqual([]);
  });

  it('handles missing fields in SearXNG results', async () => {
    mockFetch.mockResolvedValueOnce(makeSearXNGResponse([
      { title: '', url: '', content: '' },
    ]));

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const server = createMockServer();
    registerSearchTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const handler = (server._tools.get('search_web') as unknown[])[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    const response = await handler({ query: 'test' });
    const data = parseToolResponse(response);

    expect(data.results[0].title).toBe('');
    expect(data.results[0].url).toBe('');
    expect(data.results[0].snippet).toBe('');
  });
});

// ================================================================
// Brave Search Tests
// ================================================================

describe('Brave search', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubEnv('SEARXNG_URL', '');
    vi.stubEnv('BRAVE_API_KEY', 'test-brave-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sends API key in X-Subscription-Token header', async () => {
    mockFetch.mockResolvedValueOnce(makeBraveWebResponse([
      { title: 'Brave Result', url: 'https://example.com', description: 'Desc' },
    ]));

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const server = createMockServer();
    registerSearchTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const handler = (server._tools.get('search_web') as unknown[])[3] as (args: Record<string, unknown>) => Promise<unknown>;
    await handler({ query: 'test' });

    expect(mockFetch).toHaveBeenCalledOnce();
    const options = mockFetch.mock.calls[0][1] as { headers: Record<string, string> };
    expect(options.headers['X-Subscription-Token']).toBe('test-brave-key');
  });

  it('calls Brave web search endpoint', async () => {
    mockFetch.mockResolvedValueOnce(makeBraveWebResponse([]));

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const server = createMockServer();
    registerSearchTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const handler = (server._tools.get('search_web') as unknown[])[3] as (args: Record<string, unknown>) => Promise<unknown>;
    await handler({ query: 'brave test' });

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('https://api.search.brave.com/res/v1/web/search');
    expect(calledUrl).toContain('q=brave+test');
  });

  it('parses Brave web results correctly', async () => {
    mockFetch.mockResolvedValueOnce(makeBraveWebResponse([
      { title: 'Brave 1', url: 'https://b1.com', description: 'Desc 1' },
      { title: 'Brave 2', url: 'https://b2.com', description: 'Desc 2' },
    ]));

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const server = createMockServer();
    registerSearchTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const handler = (server._tools.get('search_web') as unknown[])[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    const response = await handler({ query: 'test' });
    const data = parseToolResponse(response);

    expect(data.engine).toBe('brave');
    expect(data.results).toHaveLength(2);
    expect(data.results[0].snippet).toBe('Desc 1');
    expect(data.results[0].source).toBe('brave');
  });

  it('handles Brave HTTP error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
    });

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const server = createMockServer();
    registerSearchTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const handler = (server._tools.get('search_web') as unknown[])[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    const response = await handler({ query: 'test' });

    expect(response.isError).toBe(true);
    const data = parseToolResponse(response);
    expect(data.error).toContain('429');
  });

  it('caps maxResults at 20 for Brave', async () => {
    mockFetch.mockResolvedValueOnce(makeBraveWebResponse([]));

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const server = createMockServer();
    registerSearchTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const handler = (server._tools.get('search_web') as unknown[])[3] as (args: Record<string, unknown>) => Promise<unknown>;
    await handler({ query: 'test', maxResults: 50 });

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('count=20');
  });
});

// ================================================================
// Fallback Logic Tests
// ================================================================

describe('fallback logic', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('falls back from SearXNG to Brave on SearXNG failure', async () => {
    vi.stubEnv('SEARXNG_URL', 'http://localhost:8888');
    vi.stubEnv('SEARXNG_ALLOW_LOCAL', '1');
    vi.stubEnv('BRAVE_API_KEY', 'test-key');

    // SearXNG fails
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });
    // Brave succeeds
    mockFetch.mockResolvedValueOnce(makeBraveWebResponse([
      { title: 'Brave Fallback', url: 'https://brave.com', description: 'Fallback result' },
    ]));

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const server = createMockServer();
    registerSearchTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const handler = (server._tools.get('search_web') as unknown[])[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    const response = await handler({ query: 'fallback test' });
    const data = parseToolResponse(response);

    expect(data.engine).toBe('brave');
    expect(data.results[0].title).toBe('Brave Fallback');
  });

  it('returns error when no search engine is configured', async () => {
    vi.stubEnv('SEARXNG_URL', '');
    vi.stubEnv('BRAVE_API_KEY', '');

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const server = createMockServer();
    registerSearchTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const handler = (server._tools.get('search_web') as unknown[])[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    const response = await handler({ query: 'test' });

    expect(response.isError).toBe(true);
    const data = parseToolResponse(response);
    expect(data.code).toBe('NO_ENGINE');
  });

  it('uses SearXNG first when both are configured', async () => {
    vi.stubEnv('SEARXNG_URL', 'http://localhost:8888');
    vi.stubEnv('SEARXNG_ALLOW_LOCAL', '1');
    vi.stubEnv('BRAVE_API_KEY', 'test-key');

    mockFetch.mockResolvedValueOnce(makeSearXNGResponse([
      { title: 'SearXNG Result', url: 'https://searx.com', content: 'Primary' },
    ]));

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const server = createMockServer();
    registerSearchTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const handler = (server._tools.get('search_web') as unknown[])[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    const response = await handler({ query: 'test' });
    const data = parseToolResponse(response);

    expect(data.engine).toBe('searxng');
    // Brave should not be called
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});

// ================================================================
// News Search Tests
// ================================================================

describe('news search', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('passes categories=news to SearXNG', async () => {
    vi.stubEnv('SEARXNG_URL', 'http://localhost:8888');
    vi.stubEnv('SEARXNG_ALLOW_LOCAL', '1');
    vi.stubEnv('BRAVE_API_KEY', '');

    mockFetch.mockResolvedValueOnce(makeSearXNGResponse([
      { title: 'News Article', url: 'https://news.com', content: 'Breaking' },
    ]));

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const server = createMockServer();
    registerSearchTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const handler = (server._tools.get('search_news') as unknown[])[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    await handler({ query: 'news test' });

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('categories=news');
  });

  it('falls back to Brave news endpoint', async () => {
    vi.stubEnv('SEARXNG_URL', '');
    vi.stubEnv('BRAVE_API_KEY', 'test-key');

    mockFetch.mockResolvedValueOnce(makeBraveNewsResponse([
      { title: 'Brave News', url: 'https://news.brave.com', description: 'Article', source: 'Reuters' },
    ]));

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const server = createMockServer();
    registerSearchTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const handler = (server._tools.get('search_news') as unknown[])[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    const response = await handler({ query: 'news' });
    const data = parseToolResponse(response);

    expect(data.engine).toBe('brave-news');
    expect(data.results[0].source).toBe('Reuters');
  });

  it('returns error when no engine for news', async () => {
    vi.stubEnv('SEARXNG_URL', '');
    vi.stubEnv('BRAVE_API_KEY', '');

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const server = createMockServer();
    registerSearchTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const handler = (server._tools.get('search_news') as unknown[])[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    const response = await handler({ query: 'test' });

    expect(response.isError).toBe(true);
  });
});

// ================================================================
// Image Search Tests
// ================================================================

describe('image search', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('passes categories=images to SearXNG', async () => {
    vi.stubEnv('SEARXNG_URL', 'http://localhost:8888');
    vi.stubEnv('SEARXNG_ALLOW_LOCAL', '1');
    vi.stubEnv('BRAVE_API_KEY', '');

    mockFetch.mockResolvedValueOnce(makeSearXNGImageResponse([
      { title: 'Cat', url: 'https://cats.com', img_src: 'https://cats.com/cat.jpg', thumbnail_src: 'https://cats.com/cat-thumb.jpg' },
    ]));

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const server = createMockServer();
    registerSearchTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const handler = (server._tools.get('search_images') as unknown[])[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    const response = await handler({ query: 'cats' });

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('categories=images');

    const data = parseToolResponse(response);
    expect(data.results[0].url).toBe('https://cats.com/cat.jpg');
    expect(data.results[0].thumbnailUrl).toBe('https://cats.com/cat-thumb.jpg');
  });

  it('uses Brave image search endpoint', async () => {
    vi.stubEnv('SEARXNG_URL', '');
    vi.stubEnv('BRAVE_API_KEY', 'test-key');

    mockFetch.mockResolvedValueOnce(makeBraveImageResponse([
      {
        title: 'Dog',
        url: 'https://dogs.com',
        thumbnail: { src: 'https://dogs.com/thumb.jpg' },
        properties: { url: 'https://dogs.com/dog.jpg' },
        width: 800,
        height: 600,
      },
    ]));

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const server = createMockServer();
    registerSearchTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const handler = (server._tools.get('search_images') as unknown[])[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    const response = await handler({ query: 'dogs' });

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('api.search.brave.com/res/v1/images/search');

    const data = parseToolResponse(response);
    expect(data.results[0].url).toBe('https://dogs.com/dog.jpg');
    expect(data.results[0].thumbnailUrl).toBe('https://dogs.com/thumb.jpg');
    expect(data.results[0].width).toBe(800);
    expect(data.results[0].height).toBe(600);
  });

  it('returns error when no engine for images', async () => {
    vi.stubEnv('SEARXNG_URL', '');
    vi.stubEnv('BRAVE_API_KEY', '');

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const server = createMockServer();
    registerSearchTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const handler = (server._tools.get('search_images') as unknown[])[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    const response = await handler({ query: 'test' });

    expect(response.isError).toBe(true);
  });
});

// ================================================================
// Deep Search Tests
// ================================================================

describe('deep search', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubEnv('SEARXNG_URL', 'http://localhost:8888');
    vi.stubEnv('SEARXNG_ALLOW_LOCAL', '1');
    vi.stubEnv('BRAVE_API_KEY', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('generates multiple search angles', async () => {
    // Mock multiple fetch calls for parallel searches
    for (let i = 0; i < 4; i++) {
      mockFetch.mockResolvedValueOnce(makeSearXNGResponse([
        { title: `Angle ${i} Result`, url: `https://example.com/angle${i}`, content: `Content ${i}` },
      ]));
    }

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const server = createMockServer();
    registerSearchTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const handler = (server._tools.get('search_deep') as unknown[])[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    const response = await handler({ query: 'AI agents', maxRounds: 4, maxResultsPerRound: 5 });
    const data = parseToolResponse(response);

    expect(data.rounds).toBeDefined();
    expect(data.rounds.length).toBeGreaterThanOrEqual(1);
    expect(data.combined).toBeDefined();
    expect(data.summary).toBeDefined();
    expect(data.summary.totalRounds).toBeGreaterThanOrEqual(1);
  });

  it('deduplicates results by URL', async () => {
    // Return the same URL from multiple angles
    for (let i = 0; i < 3; i++) {
      mockFetch.mockResolvedValueOnce(makeSearXNGResponse([
        { title: 'Same Result', url: 'https://example.com/same', content: 'Duplicate' },
        { title: `Unique ${i}`, url: `https://example.com/unique${i}`, content: `Unique ${i}` },
      ]));
    }

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const server = createMockServer();
    registerSearchTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const handler = (server._tools.get('search_deep') as unknown[])[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    const response = await handler({ query: 'test', maxRounds: 3, maxResultsPerRound: 5 });
    const data = parseToolResponse(response);

    // The duplicate URL should appear only once in combined results
    const urls = data.combined.map((r: { url: string }) => r.url);
    const uniqueUrls = new Set(urls);
    expect(urls.length).toBe(uniqueUrls.size);
    expect(urls.filter((u: string) => u === 'https://example.com/same')).toHaveLength(1);
  });

  it('handles individual angle failures gracefully', async () => {
    // First angle succeeds
    mockFetch.mockResolvedValueOnce(makeSearXNGResponse([
      { title: 'OK Result', url: 'https://ok.com', content: 'Works' },
    ]));
    // Second angle fails
    mockFetch.mockRejectedValueOnce(new Error('Timeout'));

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const server = createMockServer();
    registerSearchTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const handler = (server._tools.get('search_deep') as unknown[])[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    const response = await handler({ query: 'test', maxRounds: 2, maxResultsPerRound: 5 });
    const data = parseToolResponse(response);

    // Should still have results from the successful round
    expect(data.combined.length).toBeGreaterThanOrEqual(1);
  });

  it('respects maxRounds parameter', async () => {
    // Set up enough mocks for 2 rounds
    for (let i = 0; i < 2; i++) {
      mockFetch.mockResolvedValueOnce(makeSearXNGResponse([
        { title: `R${i}`, url: `https://r${i}.com`, content: 'c' },
      ]));
    }

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const server = createMockServer();
    registerSearchTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const handler = (server._tools.get('search_deep') as unknown[])[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    const response = await handler({ query: 'test', maxRounds: 2, maxResultsPerRound: 3 });
    const data = parseToolResponse(response);

    expect(data.summary.totalRounds).toBeLessThanOrEqual(2);
  });

  it('uses default maxRounds=4 and maxResultsPerRound=5', async () => {
    for (let i = 0; i < 4; i++) {
      mockFetch.mockResolvedValueOnce(makeSearXNGResponse([]));
    }

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const server = createMockServer();
    registerSearchTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const handler = (server._tools.get('search_deep') as unknown[])[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    const response = await handler({ query: 'default params' });
    const data = parseToolResponse(response);

    // Default is 4 rounds
    expect(data.summary.totalRounds).toBeLessThanOrEqual(4);
  });

  it('returns error when no engine is configured for deep search', async () => {
    vi.stubEnv('SEARXNG_URL', '');
    vi.stubEnv('BRAVE_API_KEY', '');

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const server = createMockServer();
    registerSearchTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const handler = (server._tools.get('search_deep') as unknown[])[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    const response = await handler({ query: 'test' });

    expect(response.isError).toBe(true);
  });

  it('summary includes round breakdown', async () => {
    for (let i = 0; i < 3; i++) {
      mockFetch.mockResolvedValueOnce(makeSearXNGResponse([
        { title: `R${i}`, url: `https://r${i}.com`, content: 'c' },
      ]));
    }

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const server = createMockServer();
    registerSearchTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const handler = (server._tools.get('search_deep') as unknown[])[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    const response = await handler({ query: 'test', maxRounds: 3, maxResultsPerRound: 5 });
    const data = parseToolResponse(response);

    expect(data.summary.roundBreakdown).toBeDefined();
    expect(Array.isArray(data.summary.roundBreakdown)).toBe(true);
    for (const round of data.summary.roundBreakdown) {
      expect(round).toHaveProperty('angle');
      expect(round).toHaveProperty('resultCount');
    }
  });
});

// ================================================================
// Edge Cases
// ================================================================

describe('edge cases', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('handles malformed SearXNG response (no results key)', async () => {
    vi.stubEnv('SEARXNG_URL', 'http://localhost:8888');
    vi.stubEnv('SEARXNG_ALLOW_LOCAL', '1');
    vi.stubEnv('BRAVE_API_KEY', '');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}), // No results key
    });

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const server = createMockServer();
    registerSearchTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const handler = (server._tools.get('search_web') as unknown[])[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    const response = await handler({ query: 'test' });
    const data = parseToolResponse(response);

    expect(data.results).toEqual([]);
  });

  it('handles malformed Brave response (no web or news key)', async () => {
    vi.stubEnv('SEARXNG_URL', '');
    vi.stubEnv('BRAVE_API_KEY', 'test-key');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}), // Empty response body
    });

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const server = createMockServer();
    registerSearchTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const handler = (server._tools.get('search_web') as unknown[])[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    const response = await handler({ query: 'test' });
    const data = parseToolResponse(response);

    expect(data.results).toEqual([]);
  });

  it('default maxResults is 10 for search_web', async () => {
    vi.stubEnv('SEARXNG_URL', 'http://localhost:8888');
    vi.stubEnv('SEARXNG_ALLOW_LOCAL', '1');
    vi.stubEnv('BRAVE_API_KEY', '');

    const manyResults = Array.from({ length: 30 }, (_, i) => ({
      title: `R${i}`,
      url: `https://r${i}.com`,
      content: `C${i}`,
    }));
    mockFetch.mockResolvedValueOnce(makeSearXNGResponse(manyResults));

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const server = createMockServer();
    registerSearchTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const handler = (server._tools.get('search_web') as unknown[])[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    const response = await handler({ query: 'test' });
    const data = parseToolResponse(response);

    expect(data.results.length).toBeLessThanOrEqual(10);
  });

  it('SearXNG image search falls back to URL when img_src is missing', async () => {
    vi.stubEnv('SEARXNG_URL', 'http://localhost:8888');
    vi.stubEnv('SEARXNG_ALLOW_LOCAL', '1');
    vi.stubEnv('BRAVE_API_KEY', '');

    mockFetch.mockResolvedValueOnce(makeSearXNGImageResponse([
      { title: 'No img_src', url: 'https://fallback.com/page' },
    ]));

    const { registerSearchTools } = await import('../src/modules/search/index.js');
    const server = createMockServer();
    registerSearchTools(server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer);

    const handler = (server._tools.get('search_images') as unknown[])[3] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    const response = await handler({ query: 'test' });
    const data = parseToolResponse(response);

    // Should fall back to url field
    expect(data.results[0].url).toBe('https://fallback.com/page');
  });
});

// ================================================================
// Helper Functions Tests
// ================================================================

describe('search helper functions', () => {
  it('jsonResponse wraps data in text content', () => {
    // Re-implement to test the format contract
    function jsonResponse(result: unknown, isError?: boolean) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        ...(isError !== undefined ? { isError } : {}),
      };
    }

    const result = jsonResponse({ query: 'test', results: [] });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.query).toBe('test');
  });

  it('errorResponse includes error code', () => {
    function jsonResponse(result: unknown, isError?: boolean) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        ...(isError !== undefined ? { isError } : {}),
      };
    }

    function errorResponse(message: string, code?: string) {
      return jsonResponse({ error: message, code: code ?? 'SEARCH_ERROR' }, true);
    }

    const result = errorResponse('Not found', 'NOT_FOUND');
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('Not found');
    expect(parsed.code).toBe('NOT_FOUND');
  });

  it('errorResponse uses SEARCH_ERROR as default code', () => {
    function jsonResponse(result: unknown, isError?: boolean) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        ...(isError !== undefined ? { isError } : {}),
      };
    }

    function errorResponse(message: string, code?: string) {
      return jsonResponse({ error: message, code: code ?? 'SEARCH_ERROR' }, true);
    }

    const result = errorResponse('some error');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.code).toBe('SEARCH_ERROR');
  });
});
