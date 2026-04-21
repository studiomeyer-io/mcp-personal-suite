/**
 * Orchestrators — multi-provider routing + deep-search composition.
 *
 * These functions don't talk to HTTP directly; they pick providers via the
 * clients in engines.ts. Splitting the routing from the provider clients
 * keeps each piece small enough to reason about: engines.ts is a dumb
 * transport layer, this file encodes the "which engine, with what fallback"
 * policy.
 */

import { logger } from '../../lib/logger.js';
import { exaNeuralSearch } from './providers/exa.js';
import { tavilyResearch } from './providers/tavily.js';
import {
  getConfig,
  getProviderConfig,
  searchBrave,
  searchBraveImages,
  searchSearXNG,
  searchSearXNGImages,
  type ImageSearchResponse,
  type NewsEngine,
  type SearchResponse,
  type SearchResult,
  type WebEngine,
} from './engines.js';

// ─── Unified web / news / image search ───────────────

export async function doWebSearch(
  query: string,
  maxResults: number,
  engine: WebEngine = 'auto',
): Promise<SearchResponse> {
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

export async function doNewsSearch(
  query: string,
  maxResults: number,
  engine: NewsEngine = 'auto',
): Promise<SearchResponse> {
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

export async function doImageSearch(query: string, maxResults: number): Promise<ImageSearchResponse> {
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

// ─── Deep Search ─────────────────────────────────────

export interface DeepSearchRound {
  angle: string;
  results: SearchResult[];
}

/**
 * Multi-round deep search: generates search angles from the query,
 * runs parallel searches, deduplicates, and returns combined results.
 */
export async function doDeepSearch(
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
export function generateSearchAngles(query: string, maxAngles: number): string[] {
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
