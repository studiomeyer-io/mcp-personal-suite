/**
 * Flux Provider (fal.ai) — Photorealistic image generation
 *
 * Uses the fal.ai queue API for Flux Pro v1.1.
 * Flux excels at: photorealistic images, product shots, landscapes, portraits.
 *
 * Pricing (2026): ~$0.04 per image.
 * Uses a queue model: submit job → poll for result.
 *
 * https://fal.ai/models/fal-ai/flux-pro
 */

import type { ImageGenerateResult, ImageSize } from '../types.js';

// ---- Size Mapping ----

interface FalImageSize {
  width: number;
  height: number;
}

const SIZE_MAP: Record<ImageSize, FalImageSize> = {
  square: { width: 1024, height: 1024 },
  landscape: { width: 1344, height: 768 },
  portrait: { width: 768, height: 1344 },
};

// ---- Queue Types ----

interface FalQueueResponse {
  request_id: string;
  status: string;
  response_url?: string;
  status_url?: string;
}

interface FalResultResponse {
  images?: Array<{
    url?: string;
    width?: number;
    height?: number;
    content_type?: string;
  }>;
  seed?: number;
  has_nsfw_concepts?: boolean[];
  prompt?: string;
}

interface FalStatusResponse {
  status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  response_url?: string;
  error?: string;
  logs?: Array<{ message: string }>;
}

// ---- Generate ----

export async function generateFlux(
  apiKey: string,
  prompt: string,
  options?: {
    size?: ImageSize;
  },
): Promise<ImageGenerateResult> {
  const imageSize = SIZE_MAP[options?.size ?? 'square'];

  // Submit to queue
  const submitResponse = await fetch('https://queue.fal.run/fal-ai/flux-pro/v1.1', {
    method: 'POST',
    headers: {
      'Authorization': `Key ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      image_size: imageSize,
      num_inference_steps: 28,
      guidance_scale: 3.5,
      num_images: 1,
      safety_tolerance: '2',
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!submitResponse.ok) {
    const errText = await submitResponse.text().catch(() => '');
    throw new Error(`Flux (fal.ai) submit error: ${submitResponse.status} ${errText.slice(0, 300)}`);
  }

  const queueData = await submitResponse.json() as FalQueueResponse;

  // If result is already available (sync response)
  if (queueData.status === 'COMPLETED' && queueData.response_url) {
    return fetchFluxResult(apiKey, queueData.response_url);
  }

  // Poll for result
  const statusUrl = queueData.status_url;
  if (!statusUrl) {
    throw new Error('Flux returned no status URL for queued request');
  }

  const maxPolls = 60; // 60 * 2s = 120s max
  for (let i = 0; i < maxPolls; i++) {
    await sleep(2000);

    const statusResponse = await fetch(statusUrl, {
      headers: {
        'Authorization': `Key ${apiKey}`,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!statusResponse.ok) {
      continue; // Retry on transient errors
    }

    const status = await statusResponse.json() as FalStatusResponse;

    if (status.status === 'COMPLETED' && status.response_url) {
      return fetchFluxResult(apiKey, status.response_url);
    }

    if (status.status === 'FAILED') {
      throw new Error(`Flux generation failed: ${status.error ?? 'unknown error'}`);
    }

    // IN_QUEUE or IN_PROGRESS — continue polling
  }

  throw new Error('Flux generation timed out after 120 seconds');
}

// ---- Helpers ----

async function fetchFluxResult(apiKey: string, responseUrl: string): Promise<ImageGenerateResult> {
  const response = await fetch(responseUrl, {
    headers: {
      'Authorization': `Key ${apiKey}`,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Flux result fetch error: ${response.status} ${errText.slice(0, 300)}`);
  }

  const data = await response.json() as FalResultResponse;
  const image = data.images?.[0];

  if (!image?.url) {
    throw new Error('Flux returned no image URL');
  }

  return {
    url: image.url,
    provider: 'flux',
    model: 'flux-pro-v1.1',
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
