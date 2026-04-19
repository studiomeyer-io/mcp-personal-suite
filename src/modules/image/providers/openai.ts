/**
 * OpenAI DALL-E 3 Provider — Text rendering, creative, versatile
 *
 * Uses the OpenAI Images API directly via fetch (no SDK dependency).
 * DALL-E 3 excels at: text in images, creative/artistic, logos, illustrations.
 *
 * Pricing (2026): ~$0.04-0.12 per image depending on size/quality.
 * Images are returned as URLs valid for 1 hour.
 *
 * https://platform.openai.com/docs/api-reference/images/create
 */

import type { ImageGenerateResult, ImageSize, ImageQuality, ImageStyle } from '../types.js';

// ---- Size Mapping ----

const SIZE_MAP: Record<ImageSize, string> = {
  square: '1024x1024',
  landscape: '1792x1024',
  portrait: '1024x1792',
};

// ---- Generate ----

export async function generateOpenAI(
  apiKey: string,
  prompt: string,
  options?: {
    size?: ImageSize;
    quality?: ImageQuality;
    style?: ImageStyle;
  },
): Promise<ImageGenerateResult> {
  const size = SIZE_MAP[options?.size ?? 'square'];
  const quality = options?.quality === 'hd' ? 'hd' : 'standard';
  const style = options?.style === 'natural' ? 'natural' : 'vivid';

  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'dall-e-3',
      prompt,
      n: 1,
      size,
      quality,
      style,
      response_format: 'url',
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`OpenAI API error: ${response.status} ${errText.slice(0, 300)}`);
  }

  const data = await response.json() as {
    data?: Array<{
      url?: string;
      revised_prompt?: string;
    }>;
  };

  const imageData = data.data?.[0];
  if (!imageData?.url) {
    throw new Error('OpenAI returned no image URL');
  }

  return {
    url: imageData.url,
    provider: 'openai',
    model: 'dall-e-3',
    revisedPrompt: imageData.revised_prompt,
  };
}

// ---- Edit ----

export async function editOpenAI(
  apiKey: string,
  imageUrl: string,
  prompt: string,
  options?: {
    size?: ImageSize;
  },
): Promise<ImageGenerateResult> {
  // Download the source image
  const imageResponse = await fetch(imageUrl, {
    signal: AbortSignal.timeout(30_000),
  });

  if (!imageResponse.ok) {
    throw new Error(`Failed to download source image: ${imageResponse.status}`);
  }

  const imageBlob = await imageResponse.blob();

  // Build multipart form
  const form = new FormData();
  form.append('model', 'dall-e-2'); // DALL-E 3 does not support edit
  form.append('image', imageBlob, 'image.png');
  form.append('prompt', prompt);
  form.append('n', '1');
  form.append('size', SIZE_MAP[options?.size ?? 'square'] === '1024x1024' ? '1024x1024' : '1024x1024');
  form.append('response_format', 'url');

  const response = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`OpenAI Edit API error: ${response.status} ${errText.slice(0, 300)}`);
  }

  const data = await response.json() as {
    data?: Array<{
      url?: string;
      revised_prompt?: string;
    }>;
  };

  const editData = data.data?.[0];
  if (!editData?.url) {
    throw new Error('OpenAI returned no image URL for edit');
  }

  return {
    url: editData.url,
    provider: 'openai',
    model: 'dall-e-2',
    revisedPrompt: editData.revised_prompt,
  };
}
