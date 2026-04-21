/**
 * Search engine clients + tenant-aware config plumbing.
 *
 * Two classes of code live here:
 *   1. Config resolution — env-var + tenant config loaders, with a SSRF guard
 *      on SEARXNG_URL so arbitrary user-supplied URLs can't be coerced into
 *      probing internal services.
 *   2. Provider clients — thin wrappers over SearXNG and Brave Search JSON
 *      endpoints (web, news, images). Each returns the shared result shapes
 *      so orchestrators.ts can compose them without knowing the provider.
 */

import { logger } from '../../lib/logger.js';
import { loadConfig as loadSuiteConfig } from '../../lib/config.js';

// ─── Shared types ────────────────────────────────────

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
}

export interface ImageResult {
  title: string;
  url: string;
  thumbnailUrl?: string;
  source?: string;
  width?: number;
  height?: number;
}

export interface SearchResponse {
  results: SearchResult[];
  query: string;
  engine: string;
  totalResults?: number;
}

export interface ImageSearchResponse {
  results: ImageResult[];
  query: string;
  engine: string;
}

export type WebEngine = 'auto' | 'searxng' | 'brave' | 'exa' | 'tavily';
export type NewsEngine = 'auto' | 'searxng' | 'brave' | 'tavily';

// ─── Config resolution ───────────────────────────────

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
export function validateSearxngUrl(rawUrl: string | undefined): string | undefined {
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

export function getConfig(): { searxngUrl: string | undefined; braveApiKey: string | undefined } {
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
export async function getProviderConfig(): Promise<{ exaApiKey?: string; tavilyApiKey?: string }> {
  const suiteConfig = await loadSuiteConfig();
  return {
    exaApiKey: suiteConfig.search?.exaApiKey || process.env['EXA_API_KEY'],
    tavilyApiKey: suiteConfig.search?.tavilyApiKey || process.env['TAVILY_API_KEY'],
  };
}

export function hasAnyEngine(): boolean {
  const { searxngUrl, braveApiKey } = getConfig();
  return !!(searxngUrl || braveApiKey);
}

/** Async check: true if ANY provider (including Exa/Tavily tenant keys) is usable. */
export async function hasAnyProvider(): Promise<boolean> {
  if (hasAnyEngine()) return true;
  const { exaApiKey, tavilyApiKey } = await getProviderConfig();
  return !!(exaApiKey || tavilyApiKey);
}

// ─── SearXNG Client ──────────────────────────────────

export async function searchSearXNG(
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

export async function searchSearXNGImages(
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

// ─── Brave Search Client ─────────────────────────────

export async function searchBrave(
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

export async function searchBraveImages(
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
