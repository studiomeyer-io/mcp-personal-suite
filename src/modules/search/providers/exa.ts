/**
 * Exa API Provider — Neural search + Code context
 *
 * Exa (formerly Metaphor) uses a neural search model that finds pages
 * by semantic similarity rather than keyword matching. Great for
 * "find me articles about X concept" when keyword search fails.
 *
 * Two capabilities:
 *   - search_semantic: neural search across the web
 *   - search_code_context: codebases, docs, StackOverflow, GitHub issues
 *
 * Pricing (as of 2026): ~$1 per 1000 searches + embedding cost for content.
 * Free tier: 1000 queries/month.
 *
 * https://docs.exa.ai
 */

export interface ExaSearchResult {
  title: string;
  url: string;
  publishedDate?: string;
  author?: string;
  text?: string; // full content if contents.text=true
  highlights?: string[];
  score?: number;
}

export interface ExaSearchResponse {
  results: ExaSearchResult[];
  autopromptString?: string;
  resolvedSearchType?: string;
}

interface ExaSearchBody {
  query: string;
  type: 'neural' | 'auto' | 'keyword';
  numResults: number;
  contents?: {
    text?: boolean | { maxCharacters?: number };
    highlights?: boolean | { numSentences?: number };
  };
  category?: 'company' | 'research paper' | 'news' | 'github' | 'tweet' | 'personal site' | 'linkedin profile' | 'financial report';
  startPublishedDate?: string;
  endPublishedDate?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
}

/**
 * Neural semantic search — finds pages by concept, not keywords.
 * Better than Brave/Google for "find me articles about approaches to X" style queries.
 */
export async function exaNeuralSearch(
  apiKey: string,
  query: string,
  maxResults: number = 10,
  options?: {
    category?: ExaSearchBody['category'];
    includeDomains?: string[];
    excludeDomains?: string[];
    includeText?: boolean;
  },
): Promise<ExaSearchResponse> {
  const body: ExaSearchBody = {
    query,
    type: 'neural',
    numResults: Math.min(Math.max(maxResults, 1), 100),
    contents: {
      highlights: { numSentences: 2 },
      ...(options?.includeText ? { text: { maxCharacters: 1000 } } : {}),
    },
    ...(options?.category ? { category: options.category } : {}),
    ...(options?.includeDomains ? { includeDomains: options.includeDomains } : {}),
    ...(options?.excludeDomains ? { excludeDomains: options.excludeDomains } : {}),
  };

  const response = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Exa API error: ${response.status} ${errText.slice(0, 200)}`);
  }

  return response.json() as Promise<ExaSearchResponse>;
}

/**
 * Code-context search — optimized for codebases, docs, StackOverflow, GitHub issues.
 * Uses the "github" category + neural search for best code-related retrieval.
 */
export async function exaCodeSearch(
  apiKey: string,
  query: string,
  maxResults: number = 10,
): Promise<ExaSearchResponse> {
  return exaNeuralSearch(apiKey, query, maxResults, {
    category: 'github',
    includeText: true,
    includeDomains: [
      'github.com',
      'stackoverflow.com',
      'docs.rs',
      'pkg.go.dev',
      'npmjs.com',
      'readthedocs.io',
      'docs.python.org',
      'developer.mozilla.org',
    ],
  });
}
