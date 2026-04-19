/**
 * Google Gemini Provider — Imagen 3 via Gemini API
 *
 * Uses the Gemini generateContent API with responseModalities: ["TEXT", "IMAGE"].
 * Gemini excels at: product shots, versatile generation, multimodal understanding.
 *
 * Pricing (2026): ~$0.04-0.30 per image depending on quality.
 * Returns base64-encoded inline image data.
 *
 * https://ai.google.dev/gemini-api/docs/image-generation
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ImageGenerateResult, ImageSize } from '../types.js';

// ---- Size Instructions ----

/**
 * Gemini does not have explicit size parameters in the same way as DALL-E.
 * We guide the model via prompt instructions for aspect ratio.
 */
const SIZE_PROMPTS: Record<ImageSize, string> = {
  square: '', // default
  landscape: ' (create this in landscape aspect ratio, wider than tall)',
  portrait: ' (create this in portrait aspect ratio, taller than wide)',
};

// ---- Generate ----

export async function generateGemini(
  apiKey: string,
  prompt: string,
  options?: {
    size?: ImageSize;
  },
): Promise<ImageGenerateResult> {
  const sizeHint = SIZE_PROMPTS[options?.size ?? 'square'];
  const fullPrompt = prompt + sizeHint;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: `Generate an image: ${fullPrompt}` },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
        },
      }),
      signal: AbortSignal.timeout(60_000),
    },
  );

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Gemini API error: ${response.status} ${errText.slice(0, 300)}`);
  }

  const data = await response.json() as GeminiResponse;

  // Extract image from response parts
  const candidates = data.candidates ?? [];
  for (const candidate of candidates) {
    for (const part of candidate.content?.parts ?? []) {
      if (part.inlineData?.mimeType?.startsWith('image/')) {
        // Save base64 to temp file and return file:// URI
        const { filePath, mimeType } = await saveBase64Image(
          part.inlineData.data,
          part.inlineData.mimeType,
        );

        return {
          url: filePath,
          provider: 'gemini',
          model: 'gemini-2.0-flash-exp',
          isLocalFile: true,
          mimeType,
        };
      }
    }
  }

  // Check for text-only response (model refused or couldn't generate)
  const textParts = candidates
    .flatMap((c) => c.content?.parts ?? [])
    .filter((p) => p.text)
    .map((p) => p.text)
    .join(' ');

  if (textParts) {
    throw new Error(`Gemini returned text instead of image: ${textParts.slice(0, 300)}`);
  }

  throw new Error('Gemini returned no image data');
}

// ---- Types ----

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: {
          mimeType: string;
          data: string; // base64
        };
      }>;
    };
    finishReason?: string;
  }>;
  error?: {
    message?: string;
    code?: number;
  };
}

// ---- Helpers ----

/**
 * Save base64 image data to a temporary file.
 * Returns the absolute file path.
 */
async function saveBase64Image(
  base64Data: string,
  mimeType: string,
): Promise<{ filePath: string; mimeType: string }> {
  const ext = mimeType === 'image/png' ? 'png'
    : mimeType === 'image/webp' ? 'webp'
    : 'jpg';

  const dir = join(tmpdir(), 'personal-suite-images');
  await mkdir(dir, { recursive: true });

  const filename = `gemini-${randomUUID()}.${ext}`;
  const filePath = join(dir, filename);

  const buffer = Buffer.from(base64Data, 'base64');
  await writeFile(filePath, buffer);

  return { filePath, mimeType };
}
