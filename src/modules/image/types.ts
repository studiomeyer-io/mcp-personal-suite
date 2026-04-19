/**
 * Image Module — Shared Types
 *
 * Common types used across all image providers.
 */

export type ImageProvider = 'auto' | 'openai' | 'flux' | 'gemini';
export type ImageSize = 'square' | 'landscape' | 'portrait';
export type ImageQuality = 'standard' | 'hd';
export type ImageStyle = 'vivid' | 'natural';

export interface ImageGenerateResult {
  /** URL to the generated image (HTTPS URL or local file path for Gemini) */
  url: string;
  /** Which provider generated this image */
  provider: 'openai' | 'flux' | 'gemini';
  /** Model name used */
  model: string;
  /** Revised prompt (OpenAI only) */
  revisedPrompt?: string;
  /** True if URL is a local file path rather than an HTTP URL */
  isLocalFile?: boolean;
  /** MIME type of the image (when known) */
  mimeType?: string;
}

export interface ImageDownloadResult {
  /** Absolute path to the downloaded file */
  path: string;
  /** File size in bytes */
  size: number;
  /** MIME type */
  mimeType: string;
}
