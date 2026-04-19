/**
 * Search Module — Multi-provider search gateway (BYOK).
 *
 * Registers 7 tools:
 *   search_web, search_news, search_images, search_deep,
 *   search_semantic (Exa), search_code_context (Exa), search_research (Tavily)
 *
 * Gracefully degrades when no API keys are configured.
 * Priority: SearXNG (free, self-hosted) > Brave (API key required).
 * Exa and Tavily tools only appear when respective API keys are set.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { logger } from '../../lib/logger.js';
import { loadConfig as loadSuiteConfig } from '../../lib/config.js';
import { exaNeuralSearch, exaCodeSearch } from './providers/exa.js';
import { tavilyResearch } from './providers/tavily.js';

// ---- Types ----

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
}

interface ImageResult {
  title: string;
  url: string;
  thumbnailUrl?: string;
  source?: string;
  width?: number;
  height?: number;
}

interface SearchResponse {
  results: SearchResult[];
  query: string;
  engine: string;
  totalResults?: number;
}

interface ImageSearchResponse {
  results: ImageResult[];
  query: string;
  engine: string;
}

interface ToolResponse {
  [x: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

// ---- Helpers ----

function jsonResponse(result: unknown, isError?: boolean): ToolResponse {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    ...(isError !== undefined ? { isError } : {}),
  };
}

function errorResponse(message: string, code?: string): ToolResponse {
  return jsonResponse({ error: message, code: code ?? 'SEARCH_ERROR' }, true);
}

/**
 * SSRF guard: validate that a SearXNG URL points at a public host, not
 * internal network resources (localhost, 127.0.0.0/8, 10.0.0.0/8,
 * 172.16.0.0/12, 192.168.0.0/16, link-local). In SaaS mode, tenants
 * supply arbitrary URLs via suite_setup — an attacker could otherwise
 * coerce the server to probe internal services.
 *
 * Allows common dev/self-host cases (localhost) ONLY when SEARXNG_ALLOW_LOCAL=1
 * (admin opt-in for dev environments).
 */
function validateSearxngUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    logger.warn(`[search] Invalid SEARXNG_URL rejected: not a URL`);
    return undefined;
  }

  // Only http/https
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    logger.warn(`[search] SEARXNG_URL rejected: protocol ${url.protocol} not allowed`);
    return undefined;
  }

  // Reject credentials in URL (user:pass@host)
  if (url.username || url.password) {
    logger.warn(`[search] SEARXNG_URL rejected: credentials in URL not allowed`);
    return undefined;
  }

  const hostname = url.hostname.toLowerCase();
  const allowLocal = process.env['SEARXNG_ALLOW_LOCAL'] === '1';

  // Internal / loopback / private ranges
  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost');
  const isIpv6Loopback = hostname === '::1' || hostname === '[::1]';
  const isPrivate =
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname) ||
    /^169\.254\./.test(hostname) || // link-local
    /^fc[0-9a-f]{2}::/i.test(hostname) || // IPv6 ULA
    /^fe80::/i.test(hostname) || // IPv6 link-local
    hostname === '0.0.0.0';

  if ((isLoopback || isIpv6Loopback || isPrivate) && !allowLocal) {
    logger.warn(`[search] SEARXNG_URL rejected: ${hostname} is internal (set SEARXNG_ALLOW_LOCAL=1 to bypass in dev)`);
    return undefined;
  }

  return rawUrl;
}

function getConfig(): { searxngUrl: string | undefined; braveApiKey: string | undefined } {
  return {
    searxngUrl: validateSearxngUrl(process.env['SEARXNG_URL']),
    braveApiKey: process.env['BRAVE_API_KEY'],
  };
}

/**
 * Tenant-aware config loader for new providers (Exa, Tavily).
 * In SaaS mode reads ps_tenant_config; in stdio mode reads ~/.personal-suite/config.json.
 * Falls back to env vars if tenant hasn't configured.
 */
async function getProviderConfig(): Promise<{ exaApiKey?: string; tavilyApiKey?: string }> {
  const suiteConfig = await loadSuiteConfig();
  return {
    exaApiKey: suiteConfig.search?.exaApiKey || process.env['EXA_API_KEY'],
    tavilyApiKey: suiteConfig.search?.tavilyApiKey || process.env['TAVILY_API_KEY'],
  };
}

function hasAnyEngine(): boolean {
  const { searxngUrl, braveApiKey } = getConfig();
  return !!(searxngUrl || braveApiKey);
}

/** Async check: true if ANY provider (including Exa/Tavily tenant keys) is usable. */
async function hasAnyProvider(): Promise<boolean> {
  if (hasAnyEngine()) return true;
  const { exaApiKey, tavilyApiKey } = await getProviderConfig();
  return !!(exaApiKey || tavilyApiKey);
}

// ---- SearXNG Client ----

async function searchSearXNG(
  query: string,
  categories: string,
  maxResults: number,
): Promise<SearchResult[]> {
  const { searxngUrl } = getConfig();
  if (!searxngUrl) throw new Error('SEARXNG_URL not configured');

  const params = new URLSearchParams({
    q: query,
    format: 'json',
    categories,
  });

  const response = await fetch(`${searxngUrl}/search?${params.toString()}`, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`SearXNG returned ${response.status}: ${response.statusText}`);
  }

  const data = await response.json() as {
    results?: Array<{
      title?: string;
      url?: string;
      content?: string;
      engine?: string;
      img_src?: string;
      thumbnail_src?: string;
      img_format?: string;
    }>;
  };

  const results = (data.results ?? []).slice(0, maxResults);

  return results.map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.content ?? '',
    source: r.engine,
  }));
}

async function searchSearXNGImages(
  query: string,
  maxResults: number,
): Promise<ImageResult[]> {
  const { searxngUrl } = getConfig();
  if (!searxngUrl) throw new Error('SEARXNG_URL not configured');

  const params = new URLSearchParams({
    q: query,
    format: 'json',
    categories: 'images',
  });

  const response = await fetch(`${searxngUrl}/search?${params.toString()}`, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`SearXNG returned ${response.status}: ${response.statusText}`);
  }

  const data = await response.json() as {
    results?: Array<{
      title?: string;
      url?: string;
      img_src?: string;
      thumbnail_src?: string;
      img_format?: string;
      engine?: string;
    }>;
  };

  const results = (data.results ?? []).slice(0, maxResults);

  return results.map((r) => ({
    title: r.title ?? '',
    url: r.img_src ?? r.url ?? '',
    thumbnailUrl: r.thumbnail_src,
    source: r.engine,
  }));
}

// ---- Brave Search Client ----

async function searchBrave(
  query: string,
  endpoint: string,
  maxResults: number,
): Promise<SearchResult[]> {
  const { braveApiKey } = getConfig();
  if (!braveApiKey) throw new Error('BRAVE_API_KEY not configured');

  const params = new URLSearchParams({
    q: query,
    count: String(Math.min(maxResults, 20)), // Brave max is 20
  });

  const response = await fetch(`https://api.search.brave.com/res/v1/${endpoint}/search?${params.toString()}`, {
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': braveApiKey,
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`Brave Search returned ${response.status}: ${response.statusText}`);
  }

  const data = await response.json() as {
    web?: {
      results?: Array<{
        title?: string;
        url?: string;
        description?: string;
      }>;
    };
    news?: {
      results?: Array<{
        title?: string;
        url?: string;
        description?: string;
        source?: string;
      }>;
    };
  };

  // Web results
  if (data.web?.results) {
    return data.web.results.slice(0, maxResults).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.description ?? '',
      source: 'brave',
    }));
  }

  // News results
  if (data.news?.results) {
    return data.news.results.slice(0, maxResults).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.description ?? '',
      source: r.source ?? 'brave-news',
    }));
  }

  return [];
}

async function searchBraveImages(
  query: string,
  maxResults: number,
): Promise<ImageResult[]> {
  const { braveApiKey } = getConfig();
  if (!braveApiKey) throw new Error('BRAVE_API_KEY not configured');

  const params = new URLSearchParams({
    q: query,
    count: String(Math.min(maxResults, 20)),
  });

  const response = await fetch(`https://api.search.brave.com/res/v1/images/search?${params.toString()}`, {
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': braveApiKey,
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`Brave Image Search returned ${response.status}: ${response.statusText}`);
  }

  const data = await response.json() as {
    results?: Array<{
      title?: string;
      url?: string;
      thumbnail?: { src?: string };
      properties?: { url?: string };
      source?: string;
      width?: number;
      height?: number;
    }>;
  };

  return (data.results ?? []).slice(0, maxResults).map((r) => ({
    title: r.title ?? '',
    url: r.properties?.url ?? r.url ?? '',
    thumbnailUrl: r.thumbnail?.src,
    source: r.source ?? 'brave',
    width: r.width,
    height: r.height,
  }));
}

// ---- Unified Search Functions ----

export type WebEngine = 'auto' | 'searxng' | 'brave' | 'exa' | 'tavily';
export type NewsEngine = 'auto' | 'searxng' | 'brave' | 'tavily';

async function doWebSearch(query: string, maxResults: number, engine: WebEngine = 'auto'): Promise<SearchResponse> {
  const { searxngUrl, braveApiKey } = getConfig();
  const { exaApiKey, tavilyApiKey } = await getProviderConfig();

  // Explicit engine selection
  if (engine === 'searxng') {
    if (!searxngUrl) throw new Error('SearXNG not configured for this tenant');
    const results = await searchSearXNG(query, 'general', maxResults);
    return { results, query, engine: 'searxng' };
  }
  if (engine === 'brave') {
    if (!braveApiKey) throw new Error('Brave API key not configured for this tenant');
    const results = await searchBrave(query, 'web', maxResults);
    return { results, query, engine: 'brave' };
  }
  if (engine === 'exa') {
    if (!exaApiKey) throw new Error('Exa API key not configured. Use search_semantic for neural search.');
    const exaResp = await exaNeuralSearch(exaApiKey, query, maxResults, { includeText: false });
    return {
      results: exaResp.results.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.highlights?.join(' ... ') ?? '',
        source: 'exa',
      })),
      query,
      engine: 'exa-keyword',
    };
  }
  if (engine === 'tavily') {
    if (!tavilyApiKey) throw new Error('Tavily API key not configured. Use search_research for deep research.');
    const tavilyResp = await tavilyResearch(tavilyApiKey, query, { depth: 'basic', maxResults });
    return {
      results: tavilyResp.results.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content.slice(0, 300),
        source: 'tavily',
      })),
      query,
      engine: 'tavily',
    };
  }

  // Auto mode: prefer self-hosted → Brave → no fallback to paid providers
  if (searxngUrl) {
    try {
      const results = await searchSearXNG(query, 'general', maxResults);
      return { results, query, engine: 'searxng' };
    } catch (err) {
      logger.logError('[search] SearXNG web search failed, falling back to Brave', err);
    }
  }
  if (braveApiKey) {
    try {
      const results = await searchBrave(query, 'web', maxResults);
      return { results, query, engine: 'brave' };
    } catch (err) {
      logger.logError('[search] Brave web search failed', err);
      throw err;
    }
  }

  throw new Error('No search engine configured. Set SEARXNG_URL or BRAVE_API_KEY, or pass engine="exa"|"tavily" if those keys are set.');
}

async function doNewsSearch(query: string, maxResults: number, engine: NewsEngine = 'auto'): Promise<SearchResponse> {
  const { searxngUrl, braveApiKey } = getConfig();
  const { tavilyApiKey } = await getProviderConfig();

  // Explicit engine
  if (engine === 'searxng') {
    if (!searxngUrl) throw new Error('SearXNG not configured for this tenant');
    const results = await searchSearXNG(query, 'news', maxResults);
    return { results, query, engine: 'searxng' };
  }
  if (engine === 'brave') {
    if (!braveApiKey) throw new Error('Brave API key not configured for this tenant');
    const results = await searchBrave(query, 'news', maxResults);
    return { results, query, engine: 'brave-news' };
  }
  if (engine === 'tavily') {
    if (!tavilyApiKey) throw new Error('Tavily API key not configured');
    const tavilyResp = await tavilyResearch(tavilyApiKey, query, { topic: 'news', depth: 'basic', maxResults });
    return {
      results: tavilyResp.results.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content.slice(0, 300),
        source: 'tavily-news',
      })),
      query,
      engine: 'tavily-news',
    };
  }

  // Auto fallback chain
  if (searxngUrl) {
    try {
      const results = await searchSearXNG(query, 'news', maxResults);
      return { results, query, engine: 'searxng' };
    } catch (err) {
      logger.logError('[search] SearXNG news search failed, falling back to Brave', err);
    }
  }
  if (braveApiKey) {
    try {
      const results = await searchBrave(query, 'news', maxResults);
      return { results, query, engine: 'brave-news' };
    } catch (err) {
      logger.logError('[search] Brave news search failed', err);
      throw err;
    }
  }

  throw new Error('No news search engine configured. Set SEARXNG_URL, BRAVE_API_KEY, or Tavily key.');
}

async function doImageSearch(query: string, maxResults: number): Promise<ImageSearchResponse> {
  const { searxngUrl, braveApiKey } = getConfig();

  if (searxngUrl) {
    try {
      const results = await searchSearXNGImages(query, maxResults);
      return { results, query, engine: 'searxng' };
    } catch (err) {
      logger.logError('[search] SearXNG image search failed, falling back to Brave', err);
    }
  }

  if (braveApiKey) {
    try {
      const results = await searchBraveImages(query, maxResults);
      return { results, query, engine: 'brave' };
    } catch (err) {
      logger.logError('[search] Brave image search failed', err);
      throw err;
    }
  }

  throw new Error('No search engine configured. Set SEARXNG_URL or BRAVE_API_KEY.');
}

// ---- Deep Search ----

interface DeepSearchRound {
  angle: string;
  results: SearchResult[];
}

/**
 * Multi-round deep search: generates search angles from the query,
 * runs parallel searches, deduplicates, and returns combined results.
 */
async function doDeepSearch(
  query: string,
  maxRounds: number,
  maxResultsPerRound: number,
): Promise<{ query: string; rounds: DeepSearchRound[]; combined: SearchResult[]; engine: string }> {
  // Generate search angles by decomposing the query into sub-queries
  const angles = generateSearchAngles(query, maxRounds);

  // Run all angles in parallel
  const roundResults = await Promise.allSettled(
    angles.map(async (angle): Promise<DeepSearchRound> => {
      try {
        const response = await doWebSearch(angle, maxResultsPerRound);
        return { angle, results: response.results };
      } catch {
        return { angle, results: [] };
      }
    }),
  );

  const rounds: DeepSearchRound[] = roundResults
    .filter((r): r is PromiseFulfilledResult<DeepSearchRound> => r.status === 'fulfilled')
    .map((r) => r.value);

  // Deduplicate by URL
  const seen = new Set<string>();
  const combined: SearchResult[] = [];

  for (const round of rounds) {
    for (const result of round.results) {
      if (!seen.has(result.url)) {
        seen.add(result.url);
        combined.push(result);
      }
    }
  }

  const { searxngUrl } = getConfig();
  return {
    query,
    rounds,
    combined,
    engine: searxngUrl ? 'searxng' : 'brave',
  };
}

/**
 * Generate search angles from a query to explore different facets.
 * Simple heuristic: original query + variations with common modifiers.
 */
function generateSearchAngles(query: string, maxAngles: number): string[] {
  const angles: string[] = [query];

  const modifiers = [
    `${query} comparison`,
    `${query} best practices`,
    `${query} alternatives`,
    `${query} tutorial guide`,
    `${query} latest news 2026`,
    `${query} problems issues`,
    `${query} examples`,
    `"${query}" review`,
  ];

  for (const mod of modifiers) {
    if (angles.length >= maxAngles) break;
    angles.push(mod);
  }

  return angles.slice(0, maxAngles);
}

// ---- Tool Registration ----

export function registerSearchTools(server: McpServer): void {
  const { searxngUrl, braveApiKey } = getConfig();
  const engineInfo = searxngUrl
    ? 'SearXNG'
    : braveApiKey
      ? 'Brave Search'
      : 'none (set SEARXNG_URL or BRAVE_API_KEY)';

  // ---- search_web (Unified Router) ----
  server.tool(
    'search_web',
    'Search the web. Default "auto" mode uses SearXNG → Brave fallback. Pass engine="exa"|"tavily" to use those providers for keyword-style web search.',
    {
      query: z.string().describe('Search query'),
      maxResults: z.coerce.number().min(1).max(50).optional().describe('Max results to return (default: 10)'),
      engine: z.enum(['auto', 'searxng', 'brave', 'exa', 'tavily']).optional().describe('Provider override. "auto" (default) uses SearXNG→Brave fallback.'),
    },
    async ({ query, maxResults, engine }) => {
      if (!(await hasAnyProvider())) {
        return errorResponse(
          'No search provider configured. Run suite_setup(module: "search", ...) with at least one of: search_searxng_url, search_brave_api_key, search_exa_api_key, search_tavily_api_key.',
          'NO_ENGINE',
        );
      }

      try {
        const response = await doWebSearch(query, maxResults ?? 10, engine ?? 'auto');
        return jsonResponse(response);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.logError('[search] search_web failed', err);
        return errorResponse(message);
      }
    },
  );

  // ---- search_news (Unified Router) ----
  server.tool(
    'search_news',
    'Search for recent news articles. Default "auto" uses SearXNG → Brave. Pass engine="tavily" for AI-synthesized news with citations.',
    {
      query: z.string().describe('News search query'),
      maxResults: z.coerce.number().min(1).max(50).optional().describe('Max results to return (default: 10)'),
      engine: z.enum(['auto', 'searxng', 'brave', 'tavily']).optional().describe('Provider override. "auto" (default) uses SearXNG→Brave fallback.'),
    },
    async ({ query, maxResults, engine }) => {
      if (!(await hasAnyProvider())) {
        return errorResponse(
          'No search provider configured. Run suite_setup(module: "search", ...).',
          'NO_ENGINE',
        );
      }

      try {
        const response = await doNewsSearch(query, maxResults ?? 10, engine ?? 'auto');
        return jsonResponse(response);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.logError('[search] search_news failed', err);
        return errorResponse(message);
      }
    },
  );

  // ---- search_images ----
  server.tool(
    'search_images',
    'Search for images on the web. Uses SearXNG images category or Brave Image Search.',
    {
      query: z.string().describe('Image search query'),
      maxResults: z.coerce.number().min(1).max(50).optional().describe('Max results to return (default: 10)'),
    },
    async ({ query, maxResults }) => {
      if (!hasAnyEngine()) {
        return errorResponse(
          'No search engine configured. Set SEARXNG_URL or BRAVE_API_KEY environment variable.',
          'NO_ENGINE',
        );
      }

      try {
        const response = await doImageSearch(query, maxResults ?? 10);
        return jsonResponse(response);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.logError('[search] search_images failed', err);
        return errorResponse(message);
      }
    },
  );

  // ---- search_deep ----
  server.tool(
    'search_deep',
    'Multi-round deep search. Generates multiple search angles from the query, searches in parallel, deduplicates results, and returns a comprehensive combined result set.',
    {
      query: z.string().describe('The main research query'),
      maxRounds: z.coerce.number().min(1).max(8).optional().describe('Number of search angles to explore (default: 4)'),
      maxResultsPerRound: z.coerce.number().min(1).max(20).optional().describe('Max results per search angle (default: 5)'),
    },
    async ({ query, maxRounds, maxResultsPerRound }) => {
      if (!hasAnyEngine()) {
        return errorResponse(
          'No search engine configured. Set SEARXNG_URL or BRAVE_API_KEY environment variable.',
          'NO_ENGINE',
        );
      }

      try {
        const response = await doDeepSearch(
          query,
          maxRounds ?? 4,
          maxResultsPerRound ?? 5,
        );
        return jsonResponse({
          ...response,
          summary: {
            totalRounds: response.rounds.length,
            totalUniqueResults: response.combined.length,
            roundBreakdown: response.rounds.map((r) => ({
              angle: r.angle,
              resultCount: r.results.length,
            })),
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.logError('[search] search_deep failed', err);
        return errorResponse(message);
      }
    },
  );

  // ---- search_semantic (Exa Neural Search) ----
  server.tool(
    'search_semantic',
    'Neural/semantic search via Exa — finds pages by concept similarity, not keywords. Best when you know WHAT you want but not exact keywords. Requires user to configure exaApiKey via suite_setup.',
    {
      query: z.string().describe('Conceptual search query (e.g. "approaches to reducing API costs in agent loops")'),
      maxResults: z.coerce.number().min(1).max(50).optional().describe('Max results (default: 10)'),
      category: z.enum(['research paper', 'news', 'github', 'tweet', 'company', 'personal site', 'linkedin profile', 'financial report']).optional().describe('Restrict to a content category'),
      includeDomains: z.array(z.string()).optional().describe('Only include these domains'),
      excludeDomains: z.array(z.string()).optional().describe('Exclude these domains'),
      includeText: z.boolean().optional().describe('Include 1000-char text excerpts (default: false, uses highlights only)'),
    },
    async ({ query, maxResults, category, includeDomains, excludeDomains, includeText }) => {
      const { exaApiKey } = await getProviderConfig();
      if (!exaApiKey) {
        return errorResponse(
          'Exa API key not configured. Get one at exa.ai, then run suite_setup(module: "search", search_exa_api_key: "..."). See exa.ai for current pricing.',
          'NO_EXA_KEY',
        );
      }

      try {
        const response = await exaNeuralSearch(exaApiKey, query, maxResults ?? 10, {
          category,
          includeDomains,
          excludeDomains,
          includeText,
        });
        return jsonResponse({
          engine: 'exa-neural',
          query,
          results: response.results.map((r) => ({
            title: r.title,
            url: r.url,
            publishedDate: r.publishedDate,
            author: r.author,
            highlights: r.highlights,
            text: r.text,
            score: r.score,
          })),
          totalResults: response.results.length,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.logError('[search] search_semantic failed', err);
        return errorResponse(message);
      }
    },
  );

  // ---- search_code_context (Exa Code Search) ----
  server.tool(
    'search_code_context',
    'Find code examples, documentation, GitHub issues, StackOverflow threads via Exa. Best for "how do I do X in library Y" queries. Requires exaApiKey.',
    {
      query: z.string().describe('Code/technical query (e.g. "how to stream tool_use responses with anthropic SDK")'),
      maxResults: z.coerce.number().min(1).max(50).optional().describe('Max results (default: 10)'),
    },
    async ({ query, maxResults }) => {
      const { exaApiKey } = await getProviderConfig();
      if (!exaApiKey) {
        return errorResponse(
          'Exa API key not configured. Get one at exa.ai, then run suite_setup(module: "search", search_exa_api_key: "...").',
          'NO_EXA_KEY',
        );
      }

      try {
        const response = await exaCodeSearch(exaApiKey, query, maxResults ?? 10);
        return jsonResponse({
          engine: 'exa-code',
          query,
          results: response.results.map((r) => ({
            title: r.title,
            url: r.url,
            text: r.text,
            highlights: r.highlights,
            score: r.score,
          })),
          totalResults: response.results.length,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.logError('[search] search_code_context failed', err);
        return errorResponse(message);
      }
    },
  );

  // ---- search_research (Tavily Deep Research) ----
  server.tool(
    'search_research',
    'Deep research search via Tavily — runs multiple sub-searches, scrapes top pages, returns a synthesized answer with citations. Slow (15-30s) but gives you a research-grade answer, not raw links. Requires tavilyApiKey.',
    {
      query: z.string().describe('Research question (e.g. "What are the current approaches to MCP authentication?")'),
      depth: z.enum(['basic', 'advanced']).optional().describe('Search depth — advanced is slower but better (default: advanced)'),
      topic: z.enum(['general', 'news', 'finance']).optional().describe('Content domain (default: general)'),
      maxResults: z.coerce.number().min(1).max(20).optional().describe('Max source results to cite (default: 5)'),
      daysBack: z.coerce.number().min(1).max(365).optional().describe('For news topic: how many days back to search'),
      includeDomains: z.array(z.string()).optional().describe('Only include these domains'),
      excludeDomains: z.array(z.string()).optional().describe('Exclude these domains'),
    },
    async ({ query, depth, topic, maxResults, daysBack, includeDomains, excludeDomains }) => {
      const { tavilyApiKey } = await getProviderConfig();
      if (!tavilyApiKey) {
        return errorResponse(
          'Tavily API key not configured. Get one at tavily.com (1000 free credits/mo, advanced search = 2 credits), then run suite_setup(module: "search", search_tavily_api_key: "...").',
          'NO_TAVILY_KEY',
        );
      }

      try {
        const response = await tavilyResearch(tavilyApiKey, query, {
          depth,
          topic,
          maxResults,
          daysBack,
          includeDomains,
          excludeDomains,
        });
        return jsonResponse({
          engine: 'tavily',
          query: response.query,
          answer: response.answer,
          results: response.results.map((r) => ({
            title: r.title,
            url: r.url,
            content: r.content,
            score: r.score,
            publishedDate: r.published_date,
          })),
          totalSources: response.results.length,
          responseTimeMs: Math.round(response.response_time * 1000),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.logError('[search] search_research failed', err);
        return errorResponse(message);
      }
    },
  );

  logger.info(`Search module registered (engine: ${engineInfo})`);
}
