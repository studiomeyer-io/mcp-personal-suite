/**
 * Tavily API Provider — LLM-optimized search with synthesized answers
 *
 * Tavily is built for AI agents: it runs deep searches, scrapes the top
 * results, and returns a synthesized answer with citations. Best for
 * "research this topic" queries where you'd otherwise need multiple searches.
 *
 * Pricing (as of 2026): 1000 free credits/month, then pay-as-you-go.
 * Advanced search = 2 credits, basic search = 1 credit.
 *
 * https://docs.tavily.com
 */

export interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  raw_content?: string;
  published_date?: string;
}

export interface TavilySearchResponse {
  query: string;
  answer?: string;
  results: TavilySearchResult[];
  images?: Array<{ url: string; description?: string }>;
  response_time: number;
}

interface TavilySearchBody {
  query: string;
  search_depth?: 'basic' | 'advanced';
  topic?: 'general' | 'news' | 'finance';
  max_results?: number;
  include_answer?: boolean | 'basic' | 'advanced';
  include_raw_content?: boolean;
  include_domains?: string[];
  exclude_domains?: string[];
  days?: number; // for news topic, how many days back
}

/**
 * Deep research search with synthesized answer.
 * Tavily runs multiple sub-searches, scrapes top pages, and synthesizes
 * a cited answer. Much better than raw web search for research questions.
 */
export async function tavilyResearch(
  apiKey: string,
  query: string,
  options?: {
    depth?: 'basic' | 'advanced';
    topic?: 'general' | 'news' | 'finance';
    maxResults?: number;
    includeDomains?: string[];
    excludeDomains?: string[];
    daysBack?: number;
  },
): Promise<TavilySearchResponse> {
  const body: TavilySearchBody = {
    query,
    search_depth: options?.depth ?? 'advanced',
    topic: options?.topic ?? 'general',
    max_results: Math.min(Math.max(options?.maxResults ?? 5, 1), 20),
    include_answer: 'advanced',
    include_raw_content: false,
    ...(options?.includeDomains ? { include_domains: options.includeDomains } : {}),
    ...(options?.excludeDomains ? { exclude_domains: options.excludeDomains } : {}),
    ...(options?.topic === 'news' && options?.daysBack ? { days: options.daysBack } : {}),
  };

  // API key goes in Authorization header (not body) — prevents leaking
  // in request-body logs or error responses that echo the payload.
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000), // Advanced searches can take 15-30s
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Tavily API error: ${response.status} ${errText.slice(0, 200)}`);
  }

  return response.json() as Promise<TavilySearchResponse>;
}
