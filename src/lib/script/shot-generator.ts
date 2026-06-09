// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
/**
 * Shot Generator Service
 * Generates images and videos for individual shots using AI APIs
 */

import type { Shot } from "@/types/script";
import { delay, RATE_LIMITS } from "@/lib/utils/rate-limiter";
import {
  defaultGenerationParse,
  getBackendTaskResultUrl,
  runBackendGenerationTask,
} from "@/lib/backend-generation-task";

const buildEndpoint = (baseUrl: string, path: string) => {
  const normalized = baseUrl.replace(/\/+$/, '');
  return /\/v\d+$/.test(normalized) ? `${normalized}/${path}` : `${normalized}/v1/${path}`;
};

export interface ShotGenerationConfig {
  apiKey: string;
  provider?: string;
  baseUrl: string;
  model: string;
  aspectRatio?: '16:9' | '9:16';
  styleTokens?: string[];
  referenceImages?: string[]; // Character reference images for consistency
  imageResolution?: '1K' | '2K' | '4K';
  videoResolution?: '480p' | '720p' | '1080p';
}

export interface ShotGenerationResult {
  imageUrl?: string;
  videoUrl?: string;
}

/**
 * Generate image for a shot
 */
export async function generateShotImage(
  shot: Shot,
  config: ShotGenerationConfig,
  onProgress?: (progress: number) => void
): Promise<string> {
  const { apiKey, baseUrl, model, aspectRatio = '16:9', styleTokens = [], referenceImages = [] } = config;

  if (!apiKey) {
    throw new Error('API Key is required');
  }
  if (!baseUrl) {
    throw new Error('Base URL is required');
  }
  if (!model) {
    throw new Error('Model is required');
  }

  // Build prompt from shot data (prefer calibrated imagePrompt from three-tier system)
  let prompt = shot.imagePrompt || shot.visualPrompt || shot.actionSummary;
  
  // Add style tokens
  if (styleTokens.length > 0) {
    prompt = `${styleTokens.join(', ')}, ${prompt}`;
  }

  // Add cinematic quality tokens
  prompt = `cinematic, highly detailed, 8k resolution, professional lighting, ${prompt}`;

  console.log('[ShotGenerator] Generating image for shot:', shot.id, prompt.substring(0, 100));

  const requestData: Record<string, unknown> = {
    model,
    prompt,
    n: 1,
    size: aspectRatio,
    resolution: config.imageResolution || '2K',
  };

  // Add reference images for character consistency
  if (referenceImages.length > 0) {
    requestData.image_urls = referenceImages;
  }

  onProgress?.(10);

  const task = await runBackendGenerationTask({
    kind: 'image',
    label: `shot-image:${shot.id}`,
    submit: {
      url: buildEndpoint(baseUrl, 'images/generations'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestData),
    },
    poll: {
      url: buildEndpoint(baseUrl, 'tasks/{taskId}'),
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Cache-Control': 'no-cache',
      },
      intervalMs: 2000,
    },
    parse: defaultGenerationParse('image'),
    result: { mediaKind: 'image' },
  }, {
    intervalMs: 2000,
    onProgress,
  });
  const imageUrl = getBackendTaskResultUrl(task);
  if (!imageUrl) throw new Error('后端镜头图片任务完成但没有图片 URL');
  return imageUrl;
}

/**
 * Generate video for a shot (image-to-video)
 */
export async function generateShotVideo(
  shot: Shot,
  imageUrl: string,
  config: ShotGenerationConfig,
  onProgress?: (progress: number) => void
): Promise<string> {
  const { apiKey, baseUrl, model, aspectRatio = '16:9', referenceImages = [] } = config;

  if (!apiKey) {
    throw new Error('API Key is required');
  }
  if (!baseUrl) {
    throw new Error('Base URL is required');
  }
  if (!model) {
    throw new Error('Model is required');
  }

  // Build video prompt
  const prompt = shot.videoPrompt || shot.actionSummary;

  console.log('[ShotGenerator] Generating video for shot:', shot.id, prompt.substring(0, 100));

  // Build image_with_roles
  interface ImageWithRole {
    url: string;
    role: 'first_frame' | 'last_frame' | 'reference_image';
  }

  const roles: ImageWithRole[] = [
    { url: imageUrl, role: 'first_frame' }
  ];

  // Add character reference images (max 4)
  const maxRefs = Math.min(referenceImages.length, 4);
  for (let i = 0; i < maxRefs; i++) {
    roles.push({ url: referenceImages[i], role: 'reference_image' });
  }

  const requestBody = {
    model,
    prompt,
    duration: shot.duration || 5,
    aspect_ratio: aspectRatio,
    resolution: config.videoResolution || '480p',
    audio: true,
    camerafixed: false,
    image_with_roles: roles,
  };

  onProgress?.(10);

  const task = await runBackendGenerationTask({
    kind: 'video',
    label: `shot-video:${shot.id}`,
    submit: {
      url: buildEndpoint(baseUrl, 'videos/generations'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    },
    poll: {
      url: buildEndpoint(baseUrl, 'tasks/{taskId}'),
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Cache-Control': 'no-cache',
      },
      intervalMs: 2000,
    },
    parse: defaultGenerationParse('video'),
    result: { mediaKind: 'video' },
  }, {
    intervalMs: 2000,
    onProgress,
  });
  const videoUrl = getBackendTaskResultUrl(task);
  if (!videoUrl) throw new Error('后端镜头视频任务完成但没有视频 URL');
  return videoUrl;
}

/**
 * Batch generate images for multiple shots
 */
/**
 * Batch generate images for multiple shots with rate limiting
 */
export async function batchGenerateShotImages(
  shots: Shot[],
  config: ShotGenerationConfig,
  onShotProgress: (shotId: string, progress: number) => void,
  onShotComplete: (shotId: string, imageUrl: string) => void,
  onShotError: (shotId: string, error: string) => void
): Promise<void> {
  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    
    // Rate limiting: wait between requests (except first)
    if (i > 0) {
      await delay(RATE_LIMITS.BATCH_ITEM_DELAY);
    }
    
    try {
      const imageUrl = await generateShotImage(
        shot,
        config,
        (progress) => onShotProgress(shot.id, progress)
      );
      onShotComplete(shot.id, imageUrl);
    } catch (error) {
      const err = error as Error;
      onShotError(shot.id, err.message);
    }
  }
}
