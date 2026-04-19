/**
 * Image Module — BYOK multi-provider image generation
 *
 * Registers 3 tools:
 *   image_generate  — Generate images via OpenAI DALL-E 3, Flux Pro, or Gemini
 *   image_edit      — Edit images (OpenAI only natively, others with guidance)
 *   image_download  — Download generated images to local filesystem
 *
 * Provider selection:
 *   "auto"   — heuristic routing: OpenAI for text-heavy, Flux for photorealistic, Gemini as fallback
 *   "openai" — DALL-E 3 (best for text in images, illustrations, creative)
 *   "flux"   — Flux Pro v1.1 via fal.ai (best for photorealistic, product shots)
 *   "gemini" — Gemini 2.0 Flash (versatile, returns base64 → saved locally)
 *
 * Follows the same BYOK pattern as search/index.ts:
 *   - Users bring their own API keys via suite_setup(module: "image")
 *   - Graceful degradation when keys are missing
 *   - Provider override per request
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { writeFile, mkdir, stat } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { logger } from '../../lib/logger.js';
import { loadConfig as loadSuiteConfig } from '../../lib/config.js';
import { generateOpenAI, editOpenAI } from './providers/openai.js';
import { generateFlux } from './providers/flux.js';
import { generateGemini } from './providers/gemini.js';
import type { ImageProvider, ImageGenerateResult } from './types.js';

// ---- Types ----

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
  return jsonResponse({ error: message, code: code ?? 'IMAGE_ERROR' }, true);
}

// ---- Config Loading ----

/**
 * Tenant-aware config loader for image providers.
 * In SaaS mode reads ps_tenant_config; in stdio mode reads ~/.personal-suite/config.json.
 * Falls back to env vars if tenant hasn't configured.
 */
async function getImageConfig(): Promise<{
  openaiApiKey?: string;
  fluxApiKey?: string;
  geminiApiKey?: string;
}> {
  const suiteConfig = await loadSuiteConfig();
  return {
    openaiApiKey: suiteConfig.image?.openaiApiKey || process.env['OPENAI_API_KEY'],
    fluxApiKey: suiteConfig.image?.fluxApiKey || process.env['FAL_API_KEY'],
    geminiApiKey: suiteConfig.image?.geminiApiKey || process.env['GEMINI_API_KEY'],
  };
}

/** Check if any image provider is configured. */
async function hasAnyProvider(): Promise<boolean> {
  const config = await getImageConfig();
  return !!(config.openaiApiKey || config.fluxApiKey || config.geminiApiKey);
}

// ---- Auto-Routing Heuristic ----

/**
 * Simple heuristic for auto-selecting the best provider.
 * NOT LLM-based — just keyword/pattern matching.
 *
 * Priority (when available):
 *   1. OpenAI for text-heavy prompts (logos, text, typography, signs, labels)
 *   2. Flux for photorealistic prompts (photo, realistic, person, portrait, landscape, nature)
 *   3. Gemini as default fallback (versatile)
 *   4. Whatever is configured (any key available)
 */
function autoSelectProvider(
  prompt: string,
  available: { openai: boolean; flux: boolean; gemini: boolean },
): 'openai' | 'flux' | 'gemini' {
  const lower = prompt.toLowerCase();

  // Text-heavy prompts — OpenAI DALL-E 3 excels
  const textKeywords = [
    'text', 'logo', 'sign', 'label', 'typography', 'lettering', 'font',
    'banner', 'poster', 'title', 'heading', 'quote', 'words', 'writing',
    'infographic', 'diagram', 'chart', 'badge', 'stamp', 'watermark',
  ];
  const isTextHeavy = textKeywords.some((kw) => lower.includes(kw));

  if (isTextHeavy && available.openai) return 'openai';

  // Photorealistic prompts — Flux excels
  const photoKeywords = [
    'photo', 'realistic', 'photorealistic', 'photograph', 'portrait',
    'landscape', 'nature', 'person', 'face', 'cinematic', 'film',
    'documentary', 'real', 'lifelike', 'raw', 'dslr', 'bokeh',
    'studio shot', 'product shot', 'headshot',
  ];
  const isPhotorealistic = photoKeywords.some((kw) => lower.includes(kw));

  if (isPhotorealistic && available.flux) return 'flux';

  // Gemini as primary fallback (versatile)
  if (available.gemini) return 'gemini';

  // Fall back to whatever is available
  if (available.openai) return 'openai';
  if (available.flux) return 'flux';

  // Should not reach here if hasAnyProvider() was checked
  throw new Error('No image provider configured');
}

// ---- SSRF Guard ----

/**
 * Allowed CDN domains for image_download.
 * Only HTTPS URLs from known image generation CDNs are permitted.
 */
const ALLOWED_DOWNLOAD_DOMAINS = [
  // OpenAI
  'oaidalleapiprodscus.blob.core.windows.net',
  'dalleprodsec.blob.core.windows.net',
  // fal.ai / Flux
  'fal.media',
  'v3.fal.media',
  'storage.googleapis.com',
  // Gemini (local files are handled separately)
  // General CDNs that providers may use
  'cdn.openai.com',
  'replicate.delivery',
];

/**
 * Validate a URL for image download. Prevents SSRF by:
 *   1. Requiring HTTPS protocol
 *   2. Blocking private/internal IPs
 *   3. Only allowing known CDN domains
 *
 * Local file paths (from Gemini) are allowed if they start with the temp dir.
 */
function validateDownloadUrl(rawUrl: string): { type: 'url'; url: string } | { type: 'file'; path: string } {
  // Local file path (Gemini base64 results)
  if (rawUrl.startsWith('/') || rawUrl.startsWith(tmpdir())) {
    const tempBase = join(tmpdir(), 'personal-suite-images');
    if (!rawUrl.startsWith(tempBase)) {
      throw new Error(`Local file path not in expected temp directory. Only files from ${tempBase} are allowed.`);
    }
    return { type: 'file', path: rawUrl };
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL format');
  }

  // HTTPS only
  if (url.protocol !== 'https:') {
    throw new Error('Only HTTPS URLs are allowed for image download');
  }

  // Block credentials in URL
  if (url.username || url.password) {
    throw new Error('URLs with embedded credentials are not allowed');
  }

  const hostname = url.hostname.toLowerCase();

  // Block private/internal IPs
  const isPrivate =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname === '0.0.0.0' ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname) ||
    /^169\.254\./.test(hostname) ||
    /^fc[0-9a-f]{2}::/i.test(hostname) ||
    /^fe80::/i.test(hostname) ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal');

  if (isPrivate) {
    throw new Error('Download from private/internal addresses is not allowed');
  }

  // Check against allowed CDN domains
  const isDomainAllowed = ALLOWED_DOWNLOAD_DOMAINS.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );

  if (!isDomainAllowed) {
    throw new Error(
      `Domain "${hostname}" is not in the allowed CDN list. ` +
      `Allowed: ${ALLOWED_DOWNLOAD_DOMAINS.join(', ')}. ` +
      'If this is a valid image URL from a provider, please open an issue to add the domain.',
    );
  }

  return { type: 'url', url: rawUrl };
}

// ---- Filename Sanitization (v0.5.3 — Path-Traversal defense) ----
//
// Reject path separators, control chars, relative-path tokens, and
// NUL bytes. Anything beyond safe filename chars must be rejected,
// not silently stripped — if a caller sends "../etc/passwd" that is
// intent, not a typo, and we do not want to help them get closer.

function sanitizeFilename(rawName: string): string {
  const cleaned = basename(rawName); // strips any path component
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new Error('Filename cannot be empty, "." or ".."');
  }
  if (/[\x00-\x1f\x7f/\\]/.test(cleaned)) {
    throw new Error('Filename contains control characters or path separators');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(cleaned)) {
    throw new Error(
      'Filename must match [A-Za-z0-9._-]+. Spaces, quotes, and special chars are not allowed.',
    );
  }
  if (cleaned.length > 128) {
    throw new Error('Filename too long (max 128 chars)');
  }
  return cleaned;
}

// ---- Download Helper ----

function getDownloadDir(): string {
  const downloads = join(homedir(), 'Downloads');
  if (existsSync(downloads)) return downloads;
  return tmpdir();
}

function inferExtension(mimeType: string, url: string): string {
  // From MIME type
  if (mimeType.includes('png')) return '.png';
  if (mimeType.includes('webp')) return '.webp';
  if (mimeType.includes('gif')) return '.gif';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return '.jpg';

  // From URL
  const urlExt = extname(new URL(url).pathname).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(urlExt)) return urlExt;

  // Default
  return '.png';
}

// ---- Tool Registration ----

export function registerImageTools(server: McpServer): void {

  // ---- image_generate ----
  server.tool(
    'image_generate',
    'Generate an image using AI. BYOK: configure your API keys via suite_setup(module: "image"). Providers: OpenAI DALL-E 3 (best for text/logos), Flux Pro (best for photorealistic), Gemini (versatile fallback). "auto" mode selects the best provider based on prompt content.',
    {
      prompt: z.string().min(1).max(4000).describe('Image generation prompt. Be descriptive for best results.'),
      provider: z.enum(['auto', 'openai', 'flux', 'gemini']).optional()
        .describe('Provider to use. "auto" (default) picks based on prompt: OpenAI for text-heavy, Flux for photorealistic, Gemini as fallback.'),
      size: z.enum(['square', 'landscape', 'portrait']).optional()
        .describe('Image dimensions. square=1024x1024, landscape=1792x1024, portrait=1024x1792. Default: square.'),
      style: z.enum(['vivid', 'natural']).optional()
        .describe('Image style (OpenAI only). vivid=hyper-real/dramatic, natural=more subtle. Default: vivid.'),
      quality: z.enum(['standard', 'hd']).optional()
        .describe('Image quality (OpenAI only). hd=finer detail but slower. Default: standard.'),
    },
    async ({ prompt, provider: requestedProvider, size, style, quality }) => {
      if (!(await hasAnyProvider())) {
        return errorResponse(
          'No image provider configured. Run suite_setup(module: "image") with at least one of: ' +
          'image_openai_api_key, image_flux_api_key, image_gemini_api_key. ' +
          'Or set env vars: OPENAI_API_KEY, FAL_API_KEY, GEMINI_API_KEY.',
          'NO_PROVIDER',
        );
      }

      try {
        const config = await getImageConfig();
        const available = {
          openai: !!config.openaiApiKey,
          flux: !!config.fluxApiKey,
          gemini: !!config.geminiApiKey,
        };

        // Resolve provider
        let provider: 'openai' | 'flux' | 'gemini';
        if (!requestedProvider || requestedProvider === 'auto') {
          provider = autoSelectProvider(prompt, available);
        } else {
          provider = requestedProvider;
        }

        // Validate the selected provider has a key
        if (provider === 'openai' && !config.openaiApiKey) {
          return errorResponse(
            'OpenAI API key not configured. Run suite_setup(module: "image", image_openai_api_key: "sk-...") or set OPENAI_API_KEY env var.',
            'NO_OPENAI_KEY',
          );
        }
        if (provider === 'flux' && !config.fluxApiKey) {
          return errorResponse(
            'Flux (fal.ai) API key not configured. Run suite_setup(module: "image", image_flux_api_key: "...") or set FAL_API_KEY env var.',
            'NO_FLUX_KEY',
          );
        }
        if (provider === 'gemini' && !config.geminiApiKey) {
          return errorResponse(
            'Gemini API key not configured. Run suite_setup(module: "image", image_gemini_api_key: "...") or set GEMINI_API_KEY env var.',
            'NO_GEMINI_KEY',
          );
        }

        // Generate
        let result: ImageGenerateResult;

        switch (provider) {
          case 'openai':
            result = await generateOpenAI(config.openaiApiKey!, prompt, { size, quality, style });
            break;
          case 'flux':
            result = await generateFlux(config.fluxApiKey!, prompt, { size });
            break;
          case 'gemini':
            result = await generateGemini(config.geminiApiKey!, prompt, { size });
            break;
        }

        return jsonResponse({
          ...result,
          prompt,
          size: size ?? 'square',
          note: result.isLocalFile
            ? 'Image saved locally (Gemini returns base64). Use image_download to move it to your preferred location.'
            : 'Image URL may expire. Use image_download to save permanently.',
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.logError('[image] image_generate failed', err);
        return errorResponse(message);
      }
    },
  );

  // ---- image_edit ----
  server.tool(
    'image_edit',
    'Edit an existing image using AI. Currently only OpenAI (DALL-E 2) supports native image editing. For Flux/Gemini, use image_generate with a detailed prompt describing the desired output.',
    {
      imageUrl: z.string().describe('URL of the source image to edit (must be accessible via HTTPS)'),
      prompt: z.string().min(1).max(4000).describe('Description of the edit to make'),
      provider: z.enum(['openai']).optional()
        .describe('Provider to use. Currently only "openai" supports native editing.'),
    },
    async ({ imageUrl, prompt, provider }) => {
      const config = await getImageConfig();

      // Only OpenAI supports editing
      if (provider && provider !== 'openai') {
        return errorResponse(
          `Provider "${provider}" does not support image editing. Only OpenAI (DALL-E) supports native image edits. ` +
          'For other providers, use image_generate with a detailed prompt describing the desired result.',
          'EDIT_NOT_SUPPORTED',
        );
      }

      if (!config.openaiApiKey) {
        return errorResponse(
          'Image editing requires OpenAI API key (DALL-E). Run suite_setup(module: "image", image_openai_api_key: "sk-...") ' +
          'or set OPENAI_API_KEY env var. Alternative: use image_generate with a detailed prompt.',
          'NO_OPENAI_KEY',
        );
      }

      try {
        const result = await editOpenAI(config.openaiApiKey, imageUrl, prompt);

        return jsonResponse({
          ...result,
          prompt,
          sourceImageUrl: imageUrl,
          note: 'Image URL expires in ~1 hour. Use image_download to save permanently.',
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.logError('[image] image_edit failed', err);
        return errorResponse(message);
      }
    },
  );

  // ---- image_download ----
  server.tool(
    'image_download',
    'Download a generated image to local filesystem. SSRF-protected: only HTTPS URLs from known image CDNs (OpenAI, fal.ai, Google) and local Gemini temp files are allowed. Default save location: ~/Downloads/ or /tmp/.',
    {
      url: z.string().describe('Image URL to download (from image_generate result) or local file path (Gemini)'),
      filename: z.string().optional()
        .describe('Custom filename (e.g. "my-logo.png"). Auto-generated if omitted.'),
    },
    async ({ url, filename }) => {
      try {
        const validated = validateDownloadUrl(url);
        const downloadDir = getDownloadDir();

        if (validated.type === 'file') {
          // Local file (Gemini base64 result) — copy to download dir
          const { readFile } = await import('node:fs/promises');
          const data = await readFile(validated.path);
          const srcName = basename(validated.path);
          const finalName = sanitizeFilename(filename || srcName);
          const destPath = join(downloadDir, finalName);

          await mkdir(downloadDir, { recursive: true });
          await writeFile(destPath, data);

          const fileStat = await stat(destPath);
          const ext = extname(finalName).toLowerCase();
          const mimeType = ext === '.png' ? 'image/png'
            : ext === '.webp' ? 'image/webp'
            : ext === '.gif' ? 'image/gif'
            : 'image/jpeg';

          return jsonResponse({
            path: destPath,
            size: fileStat.size,
            mimeType,
            source: 'local-copy',
          });
        }

        // Remote URL — download.
        // redirect: 'error' ensures we never follow 3xx off the CDN allowlist
        // (v0.5.3 — SSRF-via-redirect defense). Caller must provide a direct URL.
        const response = await fetch(validated.url, {
          signal: AbortSignal.timeout(30_000),
          redirect: 'error',
        });

        if (!response.ok) {
          return errorResponse(
            `Failed to download image: HTTP ${response.status} ${response.statusText}`,
            'DOWNLOAD_FAILED',
          );
        }

        const contentType = response.headers.get('content-type') || 'image/png';
        const buffer = Buffer.from(await response.arrayBuffer());

        // Determine filename — sanitize any caller-supplied name
        const ext = inferExtension(contentType, validated.url);
        const finalName = filename
          ? sanitizeFilename(filename)
          : `image-${Date.now()}${ext}`;

        const destPath = join(downloadDir, finalName);
        await mkdir(downloadDir, { recursive: true });
        await writeFile(destPath, buffer);

        return jsonResponse({
          path: destPath,
          size: buffer.length,
          mimeType: contentType,
          source: 'downloaded',
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.logError('[image] image_download failed', err);
        return errorResponse(message, 'DOWNLOAD_ERROR');
      }
    },
  );

  logger.info('Image module registered (BYOK: OpenAI/Flux/Gemini)');
}
