// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
/**
 * Storyboard Generation Service
 * 
 * Handles the generation of storyboard contact sheet images using AI image APIs.
 * Uses the shared CORS-safe request path for external AI APIs.
 */

import { buildStoryboardPrompt, getDefaultNegativePrompt, type StoryboardPromptConfig, type CharacterInfo } from './prompt-builder';
import { calculateGrid, type AspectRatio, type Resolution, RESOLUTION_PRESETS } from './grid-calculator';
import { retryOperation } from "@/lib/utils/retry";
import { delay, RATE_LIMITS } from "@/lib/utils/rate-limiter";
import { submitGridImageRequest } from '@/lib/ai/image-generator';
import { corsFetch } from '@/lib/cors-fetch';
import {
  defaultGenerationParse,
  getBackendTaskResultUrl,
  runBackendGenerationTask,
} from '@/lib/backend-generation-task';

export interface StoryboardGenerationConfig {
  storyPrompt: string;
  sceneCount: number;
  aspectRatio: AspectRatio;
  resolution: Resolution;
  styleId?: string;
  styleTokens?: string[];
  characterDescriptions?: string[];
  characterReferenceImages?: string[];
  apiKey: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  mockMode?: boolean;
}

export interface StoryboardGenerationResult {
  imageUrl: string;
  gridConfig: {
    cols: number;
    rows: number;
    cellWidth: number;
    cellHeight: number;
  };
}

const buildEndpoint = (baseUrl: string, path: string) => {
  const normalized = baseUrl.replace(/\/+$/, '');
  return /\/v\d+$/.test(normalized) ? `${normalized}/${path}` : `${normalized}/v1/${path}`;
};

/**
 * Submit image generation task (legacy - kept for reference)
 */
async function submitImageGenTask(
  prompt: string,
  aspectRatio: string,
  resolution: string,
  apiKey: string,
  referenceImages?: string[],
  model?: string,
  baseUrl?: string
): Promise<{ taskId?: string; imageUrl?: string; estimatedTime?: number }> {
  if (!model) {
    throw new Error('璇峰厛鍦ㄨ缃腑閰嶇疆鍥剧墖鐢熸垚妯″瀷');
  }
  if (!baseUrl) {
    throw new Error('璇峰厛鍦ㄨ缃腑閰嶇疆鍥剧墖鐢熸垚鏈嶅姟鏄犲皠');
  }
  const actualModel = model;
  const actualBaseUrl = baseUrl.replace(/\/+$/, '');
  
  const requestData: Record<string, unknown> = {
    model: actualModel,
    prompt,
    n: 1,
    size: aspectRatio,
    resolution: resolution,
  };

  if (referenceImages && referenceImages.length > 0) {
    console.log('[StoryboardService] Reference images:', referenceImages.map((img, i) => ({
      index: i,
      isBase64: img.startsWith('data:'),
      isUrl: img.startsWith('http'),
      length: img.length,
    })));
    requestData.image_urls = referenceImages;
  }

  const requestBody = JSON.stringify(requestData);
  console.log('[StoryboardService] Submitting image generation:', {
    model: requestData.model,
    size: requestData.size,
    resolution: requestData.resolution,
    hasImageUrls: !!requestData.image_urls,
    promptPreview: prompt.substring(0, 100),
  });

  const controller = new AbortController();
  // 10 minutes timeout for image generation (some services are slow)
  const timeoutId = setTimeout(() => controller.abort(), 600000);

  try {
    // Use retry wrapper for 429 rate limit handling
    const data = await retryOperation(async () => {
    const endpoint = buildEndpoint(actualBaseUrl, 'images/generations');
    const response = await corsFetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: requestBody,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[StoryboardService] Image API error:', response.status, errorText);
        const error = new Error(errorText.trim() || `HTTP ${response.status}`) as Error & { status?: number };
        error.status = response.status;
        throw error;
      }

      return response.json();
    }, {
      maxRetries: 3,
      baseDelay: 3000,
      retryOn429: true,
    });

    clearTimeout(timeoutId);
    console.log('[StoryboardService] Image API response:', data);

    // Parse response
    let taskId: string | undefined;
    const dataList = data.data;
    if (Array.isArray(dataList) && dataList.length > 0) {
      taskId = dataList[0].task_id?.toString();
    }
    taskId = taskId || data.task_id?.toString();

    // Check for synchronous result
    if (!taskId) {
      const directUrl = data.data?.[0]?.url || data.url;
      if (directUrl) {
        return {
          imageUrl: directUrl,
          estimatedTime: 0,
        };
      }
      throw new Error('No task_id or image URL in response');
    }

    return {
      taskId,
      estimatedTime: data.estimated_time || 30,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        throw new Error('鍥剧墖鐢熸垚 API 璇锋眰瓒呮椂锛岃绋嶅悗鍐嶈瘯');
      }
      throw error;
    }
    throw new Error('调用图片生成 API 时发生未知错误');
  }
}

/**
 * Submit image generation task to Zhipu API
 */
async function submitZhipuImageTask(
  prompt: string,
  dimensions: { width: number; height: number },
  apiKey: string,
  model?: string,
  baseUrl?: string
): Promise<{ taskId?: string; imageUrl?: string; estimatedTime?: number }> {
  if (!model) {
    throw new Error('璇峰厛鍦ㄨ缃腑閰嶇疆鍥剧墖鐢熸垚妯″瀷');
  }
  if (!baseUrl) {
    throw new Error('璇峰厛鍦ㄨ缃腑閰嶇疆鍥剧墖鐢熸垚鏈嶅姟鏄犲皠');
  }
  const endpoint = buildEndpoint(baseUrl, 'images/generations');
  const response = await corsFetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      prompt,
      size: `${dimensions.width}x${dimensions.height}`,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[StoryboardService] Zhipu error:', response.status, errorText);
    const error = new Error(errorText.trim() || `HTTP ${response.status}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  const data = await response.json();
  console.log('[StoryboardService] Zhipu response:', data);

  // CogView returns image URL directly
  const imageUrl = data.data?.[0]?.url;
  if (imageUrl) {
    return { imageUrl, estimatedTime: 0 };
  }

  return {
    taskId: `zhipu_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    estimatedTime: 0,
  };
}

/**
 * Generate a storyboard contact sheet image
 */
export async function generateStoryboardImage(
  config: StoryboardGenerationConfig,
  onProgress?: (progress: number) => void
): Promise<StoryboardGenerationResult> {
  const {
    storyPrompt,
    sceneCount,
    aspectRatio,
    resolution,
    styleTokens = [],
    characterDescriptions = [],
    apiKey,
    provider = 'aggregator',
    mockMode = false,
  } = config;

  // Calculate grid configuration
  const gridConfig = calculateGrid({
    sceneCount,
    aspectRatio,
    resolution,
  });

  // Build character info from descriptions
  const characters: CharacterInfo[] = characterDescriptions.map((desc, i) => ({
    name: `Character ${i + 1}`,
    visualTraits: desc,
  }));

  // Build the storyboard prompt
  const promptConfig: StoryboardPromptConfig = {
    story: storyPrompt,
    sceneCount,
    aspectRatio,
    resolution,
    styleTokens,
    characters: characters.length > 0 ? characters : undefined,
  };

  const prompt = buildStoryboardPrompt(promptConfig);
  const negativePrompt = getDefaultNegativePrompt();

  console.log('[StoryboardService] Generated prompt:', prompt.substring(0, 200));
  console.log('[StoryboardService] Grid config:', gridConfig);

  // Get output dimensions from resolution preset
  const outputSize = RESOLUTION_PRESETS[resolution][aspectRatio];

  // Mock mode - return a placeholder
  if (mockMode) {
    onProgress?.(100);
    const placeholderUrl = `https://placehold.co/${outputSize.width}x${outputSize.height}/333/fff?text=Storyboard+Mock+(${gridConfig.cols}x${gridConfig.rows})`;
    return {
      imageUrl: placeholderUrl,
      gridConfig: {
        cols: gridConfig.cols,
        rows: gridConfig.rows,
        cellWidth: gridConfig.cellWidth,
        cellHeight: gridConfig.cellHeight,
      },
    };
  }

  // Validate API key
  if (!apiKey) {
    throw new Error('璇峰厛鍦ㄨ缃腑閰嶇疆 API Key');
  }

  onProgress?.(10);

  const baseUrl = config.baseUrl?.replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('璇峰厛鍦ㄨ缃腑閰嶇疆鍥剧墖鐢熸垚鏈嶅姟鏄犲皠');
  }
  const model = config.model;
  if (!model) {
    throw new Error('璇峰厛鍦ㄨ缃腑閰嶇疆鍥剧墖鐢熸垚妯″瀷');
  }

  // Use submitGridImageRequest for smart routing (auto-detects chat/completions vs images/generations)
  const apiResult = await submitGridImageRequest({
    model,
    prompt,
    apiKey,
    baseUrl,
    providerPlatform: provider,
    aspectRatio,
    resolution,
    referenceImages: config.characterReferenceImages,
    onProgress: (progress) => onProgress?.(10 + Math.floor(progress * 0.9)),
  });

  if (apiResult.imageUrl) {
    onProgress?.(100);
    return {
      imageUrl: apiResult.imageUrl,
      gridConfig: {
        cols: gridConfig.cols,
        rows: gridConfig.rows,
        cellWidth: gridConfig.cellWidth,
        cellHeight: gridConfig.cellHeight,
      },
    };
  }

  throw new Error('后端故事板图片任务完成但没有图片 URL');
}

/**
 * Submit video generation task
 */
async function submitVideoGenTask(
  imageInput: string,
  prompt: string,
  aspectRatio: string,
  apiKey: string,
  referenceImages?: string[],
  model?: string,
  baseUrl?: string,
  videoResolution?: '480p' | '720p' | '1080p',
  onProgress?: (progress: number) => void,
): Promise<{ videoUrl?: string; estimatedTime?: number }> {
  if (!model) {
    throw new Error('璇峰厛鍦ㄨ缃腑閰嶇疆瑙嗛鐢熸垚妯″瀷');
  }
  if (!baseUrl) {
    throw new Error('璇峰厛鍦ㄨ缃腑閰嶇疆瑙嗛鐢熸垚鏈嶅姟鏄犲皠');
  }
  const actualModel = model;
  const actualBaseUrl = baseUrl.replace(/\/+$/, '');
  // Build image_with_roles array for doubao-seedance model
  interface ImageWithRole {
    url: string;
    role: 'first_frame' | 'last_frame' | 'reference_image';
  }

  const roles: ImageWithRole[] = [];

  // First image as first_frame
  roles.push({ url: imageInput, role: 'first_frame' });

  // Add character reference images (max 4)
  if (referenceImages && referenceImages.length > 0) {
    const maxRefs = Math.min(referenceImages.length, 4);
    for (let i = 0; i < maxRefs; i++) {
      roles.push({ url: referenceImages[i], role: 'reference_image' });
    }
  }

  const requestBody: Record<string, unknown> = {
    model: actualModel,
    prompt: prompt,
    duration: 5,
    aspect_ratio: aspectRatio,
    resolution: videoResolution || '480p',
    audio: true,
    camerafixed: false,
    image_with_roles: roles,
  };

  console.log('[StoryboardService] Submitting video to:', actualBaseUrl, {
    model: requestBody.model,
    aspectRatio: requestBody.aspect_ratio,
    promptPreview: prompt.substring(0, 100),
    imageRolesCount: roles.length,
  });

  const endpoint = buildEndpoint(actualBaseUrl, 'videos/generations');
  const task = await runBackendGenerationTask({
    kind: 'video',
    label: 'storyboard-video',
    submit: {
      url: endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    },
    poll: {
      url: buildEndpoint(actualBaseUrl, 'tasks/{taskId}'),
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
  if (!videoUrl) throw new Error('后端故事板视频任务完成但没有视频 URL');
  return {
    videoUrl,
    estimatedTime: 0,
  };
}

/**
 * Generate videos for split scenes
 * Uses the shared CORS-safe request path for external AI APIs.
 */
export async function generateSceneVideos(
  scenes: Array<{
    id: number;
    imageDataUrl: string;
    videoPrompt: string;
  }>,
  config: {
    aspectRatio: AspectRatio;
    apiKey: string;
    provider?: string;
    model?: string;
    baseUrl?: string;
    mockMode?: boolean;
    characterReferenceImages?: string[];
    videoResolution?: '480p' | '720p' | '1080p';
  },
  onSceneProgress?: (sceneId: number, progress: number) => void,
  onSceneComplete?: (sceneId: number, videoUrl: string) => void,
  onSceneFailed?: (sceneId: number, error: string) => void
): Promise<Map<number, string>> {
  const results = new Map<number, string>();

  const {
    aspectRatio,
    apiKey,
    provider = 'aggregator',
    model,
    baseUrl,
    mockMode = false,
    characterReferenceImages = [],
  } = config;

  // Validate API key
  if (!apiKey && !mockMode) {
    throw new Error('璇峰厛鍦ㄨ缃腑閰嶇疆 API Key');
  }

  // Process scenes sequentially with rate limiting
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    
    // Rate limiting: wait between video requests (except first)
    if (i > 0) {
      await delay(RATE_LIMITS.BATCH_ITEM_DELAY);
    }
    
    try {
      onSceneProgress?.(scene.id, 0);

      // Mock mode
      if (mockMode) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const mockVideoUrl = `https://example.com/mock-video-${scene.id}.mp4`;
        results.set(scene.id, mockVideoUrl);
        onSceneProgress?.(scene.id, 100);
        onSceneComplete?.(scene.id, mockVideoUrl);
        continue;
      }

      onSceneProgress?.(scene.id, 10);

      // Submit video generation task directly to external API
      // API supports base64 data URLs directly
      if (provider !== 'zhipu') {
        const resolvedBaseUrl = baseUrl?.replace(/\/+$/, '');
        if (!resolvedBaseUrl) {
          throw new Error('璇峰厛鍦ㄨ缃腑閰嶇疆瑙嗛鐢熸垚鏈嶅姟鏄犲皠');
        }
        const result = await submitVideoGenTask(
          scene.imageDataUrl,
          scene.videoPrompt,
          aspectRatio,
          apiKey,
          characterReferenceImages,
          model,
          resolvedBaseUrl,
          config.videoResolution,
          (progress) => onSceneProgress?.(scene.id, progress)
        );

        if (result.videoUrl) {
          results.set(scene.id, result.videoUrl);
          onSceneProgress?.(scene.id, 100);
          onSceneComplete?.(scene.id, result.videoUrl);
          continue;
        }

        throw new Error('后端故事板视频任务完成但没有视频 URL');
      } else {
        throw new Error(`Video generation not yet supported for provider: ${provider}`);
      }
    } catch (error) {
      const err = error as Error;
      console.error(`[StoryboardService] Scene ${scene.id} video generation failed:`, err);
      onSceneFailed?.(scene.id, err.message);
    }
  }

  return results;
}

