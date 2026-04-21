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
 *
 * Implementation splits:
 *   - ./engines.ts       — provider clients (SearXNG, Brave) + SSRF-guarded
 *                          config resolution and shared result types.
 *   - ./orchestrators.ts — routing policy (auto vs explicit engine),
 *                          deep-search composition.
 *   - This file          — MCP tool registration only.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { logger } from '../../lib/logger.js';
import { exaNeuralSearch, exaCodeSearch } from './providers/exa.js';
import { tavilyResearch } from './providers/tavily.js';
import {
  getConfig,
  getProviderConfig,
  hasAnyEngine,
  hasAnyProvider,
} from './engines.js';
import {
  doDeepSearch,
  doImageSearch,
  doNewsSearch,
  doWebSearch,
} from './orchestrators.js';

// Re-export provider-level types so any external consumer of this module
// keeps its previous import surface.
export type {
  SearchResult,
  ImageResult,
  SearchResponse,
  ImageSearchResponse,
  WebEngine,
  NewsEngine,
} from './engines.js';

interface ToolResponse {
  [x: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function jsonResponse(result: unknown, isError?: boolean): ToolResponse {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    ...(isError !== undefined ? { isError } : {}),
  };
}

function errorResponse(message: string, code?: string): ToolResponse {
  return jsonResponse({ error: message, code: code ?? 'SEARCH_ERROR' }, true);
}

// ─── Tool Registration ───────────────────────────────

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
