// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
import { getFeatureConfig } from "@/lib/ai/feature-router";
import { saveVideoToLocal } from "@/lib/image-storage";
import { resolveImageToHttpUrl } from "@/lib/media-url-resolver";
import { normalizeUrl } from "./use-image-generation";
import { useAPIConfigStore } from "@/stores/api-config-store";
import { retryOperation } from "@/lib/utils/retry";
import { buildVolcVideoTaskUrls, isVolcArkVideoPlatform } from "@/lib/volc-ark-video";
import { createProviderError, isProviderContentModerationError } from "@/lib/ai/provider-errors";
import { normalizeNetworkErrorMessage } from "@/lib/network-error";
import {
  defaultGenerationParse,
  getBackendTaskResultUrl,
  runBackendGenerationTask,
  type BackendGenerationTaskInput,
} from "@/lib/backend-generation-task";
import { getUserScopedMediaCategory } from "@/lib/user-session";
import {
  prepareVideoMediaInputs,
  type PreparedVideoImageInput,
  type VideoApiFormat,
  type VideoImageInput,
} from "@/lib/ai/video-media-prep";
import {
  ensureStructuredCaptionVideoPrompt,
  shouldRetryWithStructuredCaptionPrompt,
} from "@/lib/generation/structured-video-prompt";
import {
  AGNES_VIDEO_LAST_FRAME_UNSUPPORTED_MESSAGE,
  isAgnesProvider,
  isAgnesVideoModel,
} from "@/lib/ai/provider-platforms";

// ==================== Content Moderation ====================

/**
 * Keywords indicating content moderation errors
 * Based on ScriptAgent's CONTENT_MODERATION_KEYWORDS
 */
const CONTENT_MODERATION_KEYWORDS = [
  'moderation',
  'content_sensitive',
  'violation',
  'sensitive',
  'policy',
  'refused',
  'rejected',
  'inappropriate',
  'blocked',
  'review',
  'prohibited',
  'not_allowed',
  'unsafe',
  '内容审核',
  '违规',
  '敏感',
  '禁止',
  '拒绝',
  '不合规',
] as const;

/**
 * Check if an error is related to content moderation
 * @param error - Error message or error object
 * @returns true if it's a moderation error
 */
export function isContentModerationError(error: string | Error | unknown): boolean {
  if (isProviderContentModerationError(error)) return true;
  const errorStr = error instanceof Error
    ? error.message.toLowerCase()
    : String(error).toLowerCase();

  return CONTENT_MODERATION_KEYWORDS.some(keyword =>
    errorStr.includes(keyword.toLowerCase())
  );
}

// Get API configuration for video generation
export function getVideoApiConfig() {
  const featureConfig = getFeatureConfig('video_generation');
  if (!featureConfig) {
    return null;
  }
  
  const keyManager = featureConfig.keyManager;
  const apiKey = keyManager.getCurrentKey() || '';
  const platform = featureConfig.platform;
  const model = featureConfig.models?.[0];
  if (!model) {
    return null;
  }
  const videoBaseUrl = featureConfig.baseUrl?.replace(/\/+$/, '');
  if (!videoBaseUrl) {
    return null;
  }
  
  return {
    apiKey,
    keyManager,
    platform,
    model,
    videoBaseUrl,
  };
}

interface ConvertToHttpUrlOptions {
  fallbackHttpUrl?: string | null;
  uploadName?: string;
  forceReuploadHttp?: boolean;
  preferLocalFallback?: boolean;
}

export type VideoImageRole = VideoImageInput['role'];
export type VideoImageWithRole = VideoImageInput;

// Convert local/base64 image to HTTP URL for API
export async function convertToHttpUrl(
  rawUrl: unknown,
  options?: ConvertToHttpUrlOptions
): Promise<string> {
  return resolveImageToHttpUrl(rawUrl, {
    localFallback: options?.fallbackHttpUrl,
    uploadName: options?.uploadName?.trim() || `media_ref_${Date.now()}`,
    minDimension: 300,
    forceReuploadHttp: options?.forceReuploadHttp ?? false,
    preferLocalFallback: options?.preferLocalFallback ?? false,
    logPrefix: 'VideoGen',
  });
}

// Build image_with_roles array for video generation
export async function buildImageWithRoles(
  firstFrameUrl: string | undefined,
  lastFrameUrl: string | undefined
): Promise<VideoImageWithRole[]> {
  const imageWithRoles: VideoImageWithRole[] = [];

  if (firstFrameUrl) {
    const normalizedFirstFrame = normalizeUrl(firstFrameUrl) || '';
    const firstFrameConverted = await convertToHttpUrl(normalizedFirstFrame);
    if (firstFrameConverted) {
      imageWithRoles.push({ url: firstFrameConverted, role: 'first_frame', sourceUrl: normalizedFirstFrame });
    }
  }

  if (lastFrameUrl) {
    const normalizedLastFrame = normalizeUrl(lastFrameUrl) || '';
    const lastFrameConverted = await convertToHttpUrl(normalizedLastFrame);
    if (lastFrameConverted) {
      imageWithRoles.push({ url: lastFrameConverted, role: 'last_frame', sourceUrl: normalizedLastFrame });
    }
  }

  return imageWithRoles;
}

// ==================== 模型路由检测 ====================

/**
 * OpenAI 兼容中转 supported_endpoint_types → 内部视频路由格式
 * 基于 /api/pricing_new 返回的元数据，而非模型名猜测
 */
const VIDEO_FORMAT_MAP: Record<string, VideoApiFormat> = {
  // OpenAI 官方视频格式 (sora-2): /v1/videos
  'openAI官方视频格式': 'openai_official',
  'openAI视频格式': 'openai_official',
  // 豆包/Seedance 中转: /volc/v1/contents/generations/tasks
  '豆包视频异步': 'volc',
  // 阿里百炼 wan: /ali/bailian/...
  '异步': 'wan',
  // 可灵 Kling 全系列: /kling/v1/videos/...
  '文生视频': 'kling',
  '图生视频': 'kling',
  '视频延长': 'kling',
  'omni-video': 'kling',
  '动作控制': 'kling',
  '多模态视频编辑': 'kling',
  '数字人': 'kling',
  '对口型': 'kling',
  '视频特效': 'kling',
  // 统一格式: /v1/video/generations
  'openai': 'unified', // 某些自定义供应商会把视频模型标记为通用 openai
  '视频统一格式': 'unified',
  'grok视频': 'unified',
  'openai-response': 'unified',
  '海螺视频生成': 'unified',
  'luma视频生成': 'unified',
  'luma视频扩展': 'unified',
  'runway图生视频': 'unified',
  'aigc-video': 'unified',
  'wan视频生成': 'unified',
  // Vidu (all route to unified /v1/video/generations)
  'vidu文生视频': 'unified',
  'vidu图生视频': 'unified',
  'vidu参考生视频': 'unified',
  'vidu首尾帧': 'unified',
  'luma视频延长': 'unified',
};

/**
 * 统一格式端点路径映射（端点类型 → 提交/轮询 URL 路径）
 * 每种端点类型直接对应确定的 URL，不再靠 fallback 猜测
 */
const UNIFIED_ENDPOINT_PATHS: Record<string, { submit: string; poll: (id: string) => string }> = {
  // 路径均为域名根起的绝对路径（不依赖 /v1/ 前缀拼接）
  'grok视频':     { submit: '/v1/video/create',      poll: (id) => `/v1/video/query?id=${id}` },
  '视频统一格式': { submit: '/v1/video/create',      poll: (id) => `/v1/video/query?id=${id}` },
  '海螺视频生成': { submit: '/minimax/v1/video_generation', poll: (id) => `/minimax/v1/query/video_generation?task_id=${id}` },
  'luma视频生成': { submit: '/luma/generations',            poll: (id) => `/luma/generations/${id}` },
  'luma视频扩展': { submit: '/luma/generations',            poll: (id) => `/luma/generations/${id}` },
  'luma视频延长': { submit: '/luma/generations',            poll: (id) => `/luma/generations/${id}` },
  'runway图生视频': { submit: '/runwayml/v1/image_to_video', poll: (id) => `/runwayml/v1/tasks/${id}` },
  'wan视频生成':    { submit: '/alibailian/api/v1/services/aigc/video-generation/video-synthesis', poll: (id) => `/alibailian/api/v1/tasks/${id}` },
  'aigc-video':    { submit: '/tencent-vod/v1/aigc-video', poll: (id) => `/tencent-vod/v1/aigc-video/${id}` },
  // Vidu 企业版端点 (/ent/v2/)
  'vidu文生视频':   { submit: '/ent/v2/text2video',       poll: (id) => `/ent/v2/task?task_id=${id}` },
  'vidu图生视频':   { submit: '/ent/v2/img2video',        poll: (id) => `/ent/v2/task?task_id=${id}` },
  'vidu参考生视频': { submit: '/ent/v2/reference2video',  poll: (id) => `/ent/v2/task?task_id=${id}` },
  'vidu首尾帧':     { submit: '/ent/v2/start-end2video',  poll: (id) => `/ent/v2/task?task_id=${id}` },
};
const DEFAULT_UNIFIED_ENDPOINT = { submit: '/v1/video/generations', poll: (id: string) => `/v1/video/generations/${id}` };

/**
 * 根据模型端点类型查找对应的提交/轮询 URL 路径
 */
function getUnifiedEndpointPaths(endpointTypes: string[]): { submit: string; poll: (id: string) => string } {
  for (const t of endpointTypes) {
    if (UNIFIED_ENDPOINT_PATHS[t]) return UNIFIED_ENDPOINT_PATHS[t];
  }
  return DEFAULT_UNIFIED_ENDPOINT;
}

/**
 * 根据模型的 supported_endpoint_types 元数据检测应使用的视频 API 格式
 * 优先使用 OpenAI 兼容中转 /api/pricing_new 同步的元数据，fallback 到模型名推断
 */
function detectVideoApiFormat(model: string, platform?: string): VideoApiFormat {
  if (isAgnesProvider(platform) && isAgnesVideoModel(model)) return 'agnes';
  if (isVolcArkVideoPlatform(platform)) return 'volc_ark';

  // 1. 查询 store 中的 endpoint types 元数据
  const endpointTypes = useAPIConfigStore.getState().modelEndpointTypes[model];
  if (endpointTypes && endpointTypes.length > 0) {
    // 优先级：openai_official → kling → volc → wan → replicate → unified
    for (const t of endpointTypes) {
      if (VIDEO_FORMAT_MAP[t] === 'openai_official') {
        console.log(`[VideoGen] Metadata-driven routing: ${model} → openai_official (endpoint: ${t})`);
        return 'openai_official';
      }
    }
    for (const t of endpointTypes) {
      if (VIDEO_FORMAT_MAP[t] === 'kling') {
        console.log(`[VideoGen] Metadata-driven routing: ${model} → kling (endpoint: ${t})`);
        return 'kling';
      }
    }
    for (const t of endpointTypes) {
      if (VIDEO_FORMAT_MAP[t] === 'volc') {
        console.log(`[VideoGen] Metadata-driven routing: ${model} → volc (endpoint: ${t})`);
        return 'volc';
      }
    }
    for (const t of endpointTypes) {
      if (VIDEO_FORMAT_MAP[t] === 'wan') {
        console.log(`[VideoGen] Metadata-driven routing: ${model} → wan (endpoint: ${t})`);
        return 'wan';
      }
    }
    // Replicate: endpoint type uses '{org}/{model}异步' pattern (contains '/' before '异步')
    if (endpointTypes.some(t => t.includes('/') && t.endsWith('异步'))) {
      console.log(`[VideoGen] Metadata-driven routing: ${model} → replicate (dynamic pattern)`);
      return 'replicate';
    }
    for (const t of endpointTypes) {
      if (VIDEO_FORMAT_MAP[t] === 'unified') {
        console.log(`[VideoGen] Metadata-driven routing: ${model} → unified (endpoint: ${t})`);
        return 'unified';
      }
    }
    // 有元数据但没匹配到已知格式
    console.warn(`[VideoGen] Unknown endpoint types for ${model}:`, endpointTypes, '→ fallback to name-based');
  }

  // 2. Fallback: 按模型名推断
  const m = model.toLowerCase();
  if (m.includes('sora-2')) return 'openai_official';
  if (m.includes('kling')) return 'kling';
  // doubao-seedance 默认走中转 volc 格式；火山方舟官方平台会在前面按 platform 强制分流
  if (m.includes('doubao') || m.includes('seedance') || m.includes('seedream')) return 'volc';
  if (m.includes('wan')) return 'wan';
  return 'unified';
}

// ==================== 通用错误处理 ====================

// ==================== 视频生成主入口 ====================

function buildVideoStorageKey(model: string): string {
  const safeModel = model.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'video';
  return `${getUserScopedMediaCategory('videos')}/generated_${safeModel}_${Date.now()}.mp4`;
}

async function runBackendVideoTask(params: {
  provider: string;
  model: string;
  route: string;
  label: string;
  submitUrl: string;
  submitHeaders: Record<string, string>;
  submitBody?: string;
  submitFormData?: BackendGenerationTaskInput['submit']['formData'];
  pollUrl?: string;
  pollHeaders?: Record<string, string>;
  fallbackUrl?: string;
  intervalMs?: number;
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
  parse?: BackendGenerationTaskInput['parse'];
}): Promise<string> {
  try {
    const task = await runBackendGenerationTask({
      kind: 'video',
      label: params.label,
      submit: {
        url: params.submitUrl,
        method: 'POST',
        headers: params.submitHeaders,
        body: params.submitBody,
        formData: params.submitFormData,
      },
      poll: params.pollUrl ? {
        url: params.pollUrl,
        method: 'GET',
        headers: params.pollHeaders || params.submitHeaders,
        intervalMs: params.intervalMs || 5000,
      } : undefined,
      parse: {
        ...defaultGenerationParse('video'),
        ...params.parse,
      },
      result: {
        mediaKind: 'video',
        storageKey: buildVideoStorageKey(params.model),
        fallbackUrl: params.fallbackUrl,
      },
    }, {
      signal: params.signal,
      intervalMs: Math.min(5000, params.intervalMs || 5000),
      onProgress: (progress) => params.onProgress?.(progress),
    });

    const resultUrl = getBackendTaskResultUrl(task);
    if (!resultUrl) throw new Error('后端任务完成但没有视频地址');
    return resultUrl;
  } catch (error) {
    if (params.signal?.aborted) throw error;
    throw createProviderError({
      mediaKind: 'video',
      stage: 'poll',
      provider: params.provider,
      model: params.model,
      route: params.route,
      originalError: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

// Call video generation API — 根据模型自动路由到正确的 OpenAI 兼容中转 API 格式
export async function callVideoGenerationApi(
  apiKey: string,
  prompt: string,
  duration: number,
  aspectRatio: string,
  imageWithRoles: VideoImageWithRole[],
  onProgress?: (progress: number) => void,
  keyManager?: { getCurrentKey?: () => string | null; handleError: (status: number, errorText?: string) => boolean; getAvailableKeyCount: () => number; getTotalKeyCount: () => number },
  platform?: string,
  videoResolution?: '480p' | '720p' | '1080p',
  /** Seedance 2.0: 视频引用 URL 列表 (运镜/动作复刻) */
  videoRefs?: string[],
  /** Seedance 2.0: 音频引用 URL 列表 (节奏/BGM) */
  audioRefs?: string[],
  /** Seedance 2.0: 是否生成音频（默认 true） */
  enableAudio?: boolean,
  /** Seedance 2.0: 是否锁定运镜（默认 false） */
  cameraFixed?: boolean,
  /** 外部中止信号，用于停止生成时真正取消网络请求 */
  signal?: AbortSignal,
): Promise<string> {
  const featureConfig = getFeatureConfig('video_generation');
  const resolvedPlatform = platform || featureConfig?.platform;
  if (!resolvedPlatform) {
    throw new Error('请先在设置中配置视频生成服务映射');
  }
  const model = featureConfig?.models?.[0];
  if (!model) {
    throw new Error('请先在设置中配置视频生成模型');
  }
  if (isAgnesProvider(resolvedPlatform) && !isAgnesVideoModel(model)) {
    throw new Error('当前视频生成服务选择的是 Agnes AI，但所选模型不是 Agnes Video v2.0。请改用 agnes-video-v2.0，或选择其他支持视频生成的供应商。');
  }
  const videoBaseUrl = featureConfig?.baseUrl?.replace(/\/+$/, '');
  if (!videoBaseUrl) {
    throw new Error('请先在设置中配置视频生成服务映射');
  }

  // 根据元数据/模型名检测 API 格式并路由，包裹重试（覆盖 429/503/529 等）
  const format = detectVideoApiFormat(model, resolvedPlatform);
  console.log('[VideoGen] Detected API format:', { model, format, platform: resolvedPlatform });
  const preparedMedia = await retryOperation(() => prepareVideoMediaInputs({
    format,
    imageWithRoles,
    videoRefs,
    audioRefs,
    provider: resolvedPlatform,
    model,
    logPrefix: 'VideoGen',
  }), {
    maxRetries: 2,
    baseDelay: 1000,
    retryOn429: true,
    onRetry: (attempt, delay, error) => {
      console.warn(`[VideoGen] Media input preparation retry ${attempt}, delay ${delay}ms, error: ${error.message}`);
    },
  });
  if (format === 'agnes') {
    assertAgnesVideoInputsSupported({
      imageWithRoles: preparedMedia.images,
      videoRefs: preparedMedia.videoRefs,
      audioRefs: preparedMedia.audioRefs,
      enableAudio,
      cameraFixed,
    });
  }

  return retryOperation(() => {
    if (signal?.aborted) return Promise.reject(new Error('用户已取消'));
    // 每次重试动态取当前 key（keyManager.handleError 已 rotate，需要用新 key）
    const currentApiKey = keyManager?.getCurrentKey?.() || apiKey;
    const keyHint = currentApiKey ? `${currentApiKey.substring(0, 8)}…` : '(none)';
    console.log(`[VideoGen] Using key: ${keyHint}, format: ${format}`);
    switch (format) {
      case 'openai_official':
        return callOpenAIOfficialVideoApi(currentApiKey, prompt, videoBaseUrl, model, aspectRatio, duration, videoResolution, onProgress, keyManager, signal);
      case 'agnes':
        return callAgnesVideoApi(currentApiKey, prompt, videoBaseUrl, model, aspectRatio, preparedMedia.images, videoResolution, duration, onProgress, keyManager, signal);
      case 'volc':
        return callVolcVideoApi(currentApiKey, prompt, videoBaseUrl, model, aspectRatio, preparedMedia.images, videoResolution, duration, cameraFixed, onProgress, keyManager, preparedMedia.videoRefs, preparedMedia.audioRefs, signal, false, enableAudio);
      case 'volc_ark':
        return callVolcVideoApi(currentApiKey, prompt, videoBaseUrl, model, aspectRatio, preparedMedia.images, videoResolution, duration, cameraFixed, onProgress, keyManager, preparedMedia.videoRefs, preparedMedia.audioRefs, signal, true, enableAudio);
      case 'wan':
        return callWanVideoApi(currentApiKey, prompt, videoBaseUrl, model, preparedMedia.images, videoResolution, duration, enableAudio, onProgress, keyManager, signal);
      case 'kling':
        return callKlingVideoApi(currentApiKey, prompt, videoBaseUrl, model, aspectRatio, preparedMedia.images, duration, onProgress, keyManager, signal);
      case 'replicate':
        return callReplicateVideoApi(currentApiKey, prompt, videoBaseUrl, model, aspectRatio, preparedMedia.images, duration, videoResolution, onProgress, keyManager, signal);
      default:
        // 统一格式: grok, veo, luma, runway, 海螺, 即梦, wan2.6, vidu 等
        return callUnifiedVideoApi(currentApiKey, prompt, videoBaseUrl, model, aspectRatio, preparedMedia.images, videoResolution, duration, onProgress, keyManager, signal);
    }
  }, {
    maxRetries: 3,
    baseDelay: 3000,
    retryOn429: true,
    onRetry: (attempt, delay) => {
      const availableKeys = keyManager?.getAvailableKeyCount?.() ?? 1;
      console.warn(`[VideoGen] Retryable error, retrying in ${delay}ms... (Attempt ${attempt}/3, available keys: ${availableKeys})`);
    },
  });
}

// ==================== 视频统一格式 (grok/veo/luma/runway/海螺/即梦/doubao-seedance/wan2.6/vidu 等) ====================
// OpenAI 兼容中转 文档: POST /v1/video/generations (primary) + /v1/video/create (fallback)
//             GET  /v1/video/generations/{id} (primary) + /v1/video/query?id= (fallback)

/**
 * Convert aspect ratio string to Runway pixel-format ratio (e.g. '16:9' → '1280:720')
 */
function toRunwayRatio(aspectRatio: string): string {
  const map: Record<string, string> = {
    '16:9': '1280:720',
    '9:16': '720:1280',
    '1:1':  '720:720',
    '4:3':  '960:720',
    '3:4':  '720:960',
    '21:9': '2048:880',
  };
  return map[aspectRatio] ?? aspectRatio;
}

function getAgnesUnsupportedVideoInputs(params: {
  imageWithRoles: Array<{ url: string; role: 'first_frame' | 'last_frame' }>;
  videoRefs?: string[];
  audioRefs?: string[];
  enableAudio?: boolean;
  cameraFixed?: boolean;
}): string[] {
  const unsupported: string[] = [];
  if (params.imageWithRoles.some((img) => img.role === 'last_frame' && img.url)) {
    unsupported.push('尾帧输入');
  }
  if ((params.videoRefs || []).filter(Boolean).length > 0) {
    unsupported.push('视频引用');
  }
  if ((params.audioRefs || []).filter(Boolean).length > 0) {
    unsupported.push('音频引用');
  }
  if (params.enableAudio === true) {
    unsupported.push('自动生成/保留音频');
  }
  if (params.cameraFixed === true) {
    unsupported.push('锁定运镜');
  }
  return unsupported;
}

function assertAgnesVideoInputsSupported(params: {
  imageWithRoles: Array<{ url: string; role: 'first_frame' | 'last_frame' }>;
  videoRefs?: string[];
  audioRefs?: string[];
  enableAudio?: boolean;
  cameraFixed?: boolean;
}): void {
  const unsupported = getAgnesUnsupportedVideoInputs(params);
  if (unsupported.length === 0) return;
  throw new Error(`${AGNES_VIDEO_LAST_FRAME_UNSUPPORTED_MESSAGE} 当前请求包含不支持的内容：${unsupported.join('、')}。`);
}

async function callAgnesVideoApi(
  apiKey: string,
  prompt: string,
  baseUrl: string,
  model: string,
  aspectRatio: string,
  imageWithRoles: Array<{ url: string; role: 'first_frame' | 'last_frame' }>,
  videoResolution?: string,
  duration?: number,
  onProgress?: (progress: number) => void,
  keyManager?: { handleError: (status: number, errorText?: string) => boolean },
  signal?: AbortSignal,
): Promise<string> {
  assertAgnesVideoInputsSupported({ imageWithRoles });
  const firstFrame = imageWithRoles.find((img) => img.role === 'first_frame');
  const requestBody: Record<string, unknown> = {
    model,
    prompt,
  };
  if (firstFrame?.url) requestBody.image = firstFrame.url;
  if (duration) requestBody.duration = duration;
  if (aspectRatio) requestBody.aspect_ratio = aspectRatio;
  if (videoResolution) requestBody.resolution = videoResolution.toLowerCase();

  const submitUrl = /\/v\d+$/.test(baseUrl) ? `${baseUrl}/videos` : `${baseUrl}/v1/videos`;
  console.log('[VideoGen] Agnes format → POST /v1/videos', {
    model,
    hasImage: !!firstFrame?.url,
    duration,
    aspectRatio,
    videoResolution,
  });

  const pollUrl = /\/v\d+$/.test(baseUrl) ? `${baseUrl}/videos/{taskId}` : `${baseUrl}/v1/videos/{taskId}`;
  const contentUrl = /\/v\d+$/.test(baseUrl) ? `${baseUrl}/videos/{taskId}/content` : `${baseUrl}/v1/videos/{taskId}/content`;

  return runBackendVideoTask({
    provider: 'Agnes',
    model,
    route: '/v1/videos',
    label: `agnes-video:${model}`,
    submitUrl,
    submitHeaders: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    submitBody: JSON.stringify(requestBody),
    pollUrl,
    pollHeaders: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    fallbackUrl: contentUrl,
    intervalMs: 5000,
    onProgress,
    signal,
  });
}

async function callUnifiedVideoApi(
  apiKey: string,
  prompt: string,
  baseUrl: string,
  model: string,
  aspectRatio: string,
  imageWithRoles: Array<{ url: string; role: 'first_frame' | 'last_frame' }>,
  videoResolution?: string,
  duration?: number,
  onProgress?: (progress: number) => void,
  keyManager?: { handleError: (status: number, errorText?: string) => boolean },
  signal?: AbortSignal,
): Promise<string> {
  // 检测模型端点类型，决定特殊处理和 URL 路径
  const endpointTypes = useAPIConfigStore.getState().modelEndpointTypes[model] || [];
  const isLuma = endpointTypes.some(t => /luma/i.test(t));
  const isRunway = endpointTypes.some(t => /runway/i.test(t));
  const isGrok = endpointTypes.some(t => /grok/i.test(t)) || /grok/i.test(model);
  const endpointPaths = getUnifiedEndpointPaths(endpointTypes);

  // 构建请求体（对齐 freedom-api.ts generateVideoViaUnified）
  const body: Record<string, unknown> = { model, prompt };
  const metadata: Record<string, unknown> = {};

  // Duration: Luma requires string with unit ("5s"), other models use number
  if (duration) {
    body.duration = isLuma ? `${duration}s` : duration;
  }

  // AspectRatio 处理策略（各模型格式不同，按模型分别处理）：
  // - Runway: metadata.ratio（像素格式 1280:720）
  // - Grok: 顶层 aspect_ratio（xAI 官方格式，支持 16:9/9:16/4:3/3:4/3:2/2:3/1:1）
  // - 其他统一格式模型: metadata.aspect_ratio
  if (aspectRatio) {
    if (isRunway) {
      metadata.ratio = toRunwayRatio(aspectRatio);
    } else if (isGrok) {
      body.aspect_ratio = aspectRatio;
    } else {
      metadata.aspect_ratio = aspectRatio;
    }
  }

  // Resolution: Grok supports "720p"/"480p" at top level; others via metadata
  if (videoResolution) {
    if (isRunway) {
      // Runway doesn't use resolution field
    } else if (isGrok) {
      body.resolution = videoResolution;
    } else {
      metadata.resolution = videoResolution;
    }
  }

  // Image inputs: single `image` field (not array)
  const firstFrame = imageWithRoles.find(img => img.role === 'first_frame');
  if (firstFrame?.url) {
    body.image = firstFrame.url;
  }
  const lastFrame = imageWithRoles.find(img => img.role === 'last_frame');
  if (lastFrame?.url) {
    metadata.image_end = lastFrame.url;
  }

  if (Object.keys(metadata).length > 0) body.metadata = metadata;

  // 绝对路径拼接：从域名根开始
  const rootBase = baseUrl.replace(/\/v\d+$/, '');
  const submitUrl = `${rootBase}${endpointPaths.submit}`;
  console.log(`[VideoGen] Unified format → POST ${endpointPaths.submit}`, { model, metadata, hasImage: !!firstFrame?.url });

  return runBackendVideoTask({
    provider: '统一视频接口',
    model,
    route: endpointPaths.submit,
    label: `video:${model}`,
    submitUrl,
    submitHeaders: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    submitBody: JSON.stringify(body),
    pollUrl: `${rootBase}${endpointPaths.poll('{taskId}')}`,
    pollHeaders: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    intervalMs: 5000,
    onProgress,
    signal,
  });
}

// ==================== Volcengine 豆包/Seedance 格式 ====================
// OpenAI 兼容中转: POST /volc/v1/contents/generations/tasks
// 火山方舟官方: POST /api/v3/contents/generations/tasks

async function callVolcVideoApi(
  apiKey: string,
  prompt: string,
  baseUrl: string,
  model: string,
  aspectRatio: string,
  imageWithRoles: PreparedVideoImageInput[],
  videoResolution?: string,
  duration?: number,
  cameraFixed?: boolean,
  onProgress?: (progress: number) => void,
  keyManager?: { handleError: (status: number, errorText?: string) => boolean },
  /** Seedance 2.0: 视频引用 URL 列表 */
  videoRefs?: string[],
  /** Seedance 2.0: 音频引用 URL 列表 */
  audioRefs?: string[],
  signal?: AbortSignal,
  officialArk: boolean = false,
  generateAudio: boolean = false,
): Promise<string> {
  // 构建 content 数组（Volcengine 格式: text + image_url）
  const content: Array<Record<string, unknown>> = [];

  const resolution = (videoResolution || '720p').toLowerCase();
  const buildTextContent = (textPrompt: string, structuredPrompt: boolean): string => {
    if (structuredPrompt) {
      const promptWithParams = [
        textPrompt,
        `Video parameters: resolution ${resolution}, aspect ratio ${aspectRatio}`,
        duration ? `duration ${duration} seconds` : '',
        cameraFixed !== undefined ? `camera fixed ${cameraFixed}` : '',
      ].filter(Boolean).join('. ');
      return ensureStructuredCaptionVideoPrompt(promptWithParams);
    }

    if (officialArk) return textPrompt;
    let textContent = textPrompt;
    textContent += ` --rs ${resolution}`;
    textContent += ` --rt ${aspectRatio}`;
    if (duration) textContent += ` --dur ${duration}`;
    if (cameraFixed !== undefined) textContent += ` --cf ${cameraFixed}`;
    return textContent;
  };

  const formatFetchError = (error: unknown): string => {
    return normalizeNetworkErrorMessage(error, '视频生成请求');
  };

  // 图片内容（首帧/尾帧）
  for (const img of imageWithRoles) {
    if (img.url) {
      content.push({
        type: 'image_url',
        image_url: { url: img.url },
        role: img.role,
      });
    }
  }

  const mediaContent = content;
  const buildContent = (textPrompt: string, structuredPrompt: boolean): Array<Record<string, unknown>> => [
    { type: 'text', text: buildTextContent(textPrompt, structuredPrompt) },
    ...mediaContent,
    ...(videoRefs || []).filter(Boolean).map((vUrl) => ({
      type: 'video_url',
      video_url: { url: vUrl },
    })),
    ...(audioRefs || []).filter(Boolean).map((aUrl) => ({
      type: 'audio_url',
      audio_url: { url: aUrl },
    })),
  ];

  const buildRequestBody = (textPrompt: string, structuredPrompt: boolean) => {
    const requestContent = buildContent(textPrompt, structuredPrompt);
    return officialArk
      ? {
          model,
          content: requestContent,
          ...(duration ? { duration } : {}),
          generate_audio: generateAudio,
          ...(aspectRatio ? { ratio: aspectRatio } : {}),
        }
      : { model, content: requestContent };
  };
  const taskUrls = buildVolcVideoTaskUrls(baseUrl, officialArk);

  console.log(`[VideoGen] Volc format → POST ${taskUrls.routeLabel}`, {
    model,
    officialArk,
    resolution,
    aspectRatio,
    duration,
    imageCount: imageWithRoles.filter(i => i.url).length,
    imageInputMode: imageWithRoles.some(i => i.url) ? 'base64_data_uri' : 'none',
  });

  const runVolcTask = async (structuredPrompt: boolean): Promise<string> => {
    try {
      return await runBackendVideoTask({
        provider: officialArk ? '火山方舟' : 'Volc 兼容中转',
        model,
        route: taskUrls.routeLabel,
        label: `volc-video:${model}`,
        submitUrl: taskUrls.submit,
        submitHeaders: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        submitBody: JSON.stringify(buildRequestBody(prompt, structuredPrompt)),
        pollUrl: taskUrls.poll('{taskId}'),
        pollHeaders: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        intervalMs: 5000,
        onProgress,
        signal,
        parse: {
          statusPaths: ['status', 'data.status', 'output.status'],
          resultUrlPaths: [
            'content.video_url',
            'content.0.video_url',
            'outputs.0.url',
            'output.video_url',
            'output.url',
            'video_url',
            'url',
          ],
          errorPaths: ['error.message', 'error.code', 'message', 'data.error.message', 'data.error'],
          successStatuses: ['succeeded', 'success', 'completed'],
          failureStatuses: ['failed', 'error', 'expired', 'cancelled', 'canceled'],
        },
      });
    } catch (error) {
      const detail = formatFetchError(error);
      if (!structuredPrompt && shouldRetryWithStructuredCaptionPrompt(detail)) {
        console.warn('[VideoGen] Volc requires structured caption prompt; retrying once with style_caption JSON');
        return runVolcTask(true);
      }
      throw error;
    }
  };

  return runVolcTask(false);
}

// ==================== 通义万象 wan 格式 ====================
// OpenAI 兼容中转 文档:
//   创建: POST /alibailian/api/v1/services/aigc/video-generation/video-synthesis
//   查询: GET  /alibailian/api/v1/tasks/{task_id}

async function callWanVideoApi(
  apiKey: string,
  prompt: string,
  baseUrl: string,
  model: string,
  imageWithRoles: Array<{ url: string; role: string }>,
  resolution?: string,
  duration?: number,
  enableAudio?: boolean,
  onProgress?: (progress: number) => void,
  keyManager?: { handleError: (status: number, errorText?: string) => boolean },
  signal?: AbortSignal,
): Promise<string> {
  const firstFrame = imageWithRoles.find(img => img.role === 'first_frame');

  const requestBody: Record<string, unknown> = {
    model,
    input: {
      prompt,
      ...(firstFrame?.url ? { img_url: firstFrame.url } : {}),
    },
    parameters: {
      resolution: (resolution || '480P').toUpperCase(),
      prompt_extend: true,
      ...(duration ? { duration: Math.max(3, Math.min(10, duration)) } : {}),
      audio: enableAudio !== false,
    },
  };

  console.log('[VideoGen] Wan format → POST /alibailian/api/v1/services/aigc/video-generation/video-synthesis', { model });

  return runBackendVideoTask({
    provider: '通义万相',
    model,
    route: '/alibailian/api/v1/services/aigc/video-generation/video-synthesis',
    label: `wan-video:${model}`,
    submitUrl: `${baseUrl}/alibailian/api/v1/services/aigc/video-generation/video-synthesis`,
    submitHeaders: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    submitBody: JSON.stringify(requestBody),
    pollUrl: `${baseUrl}/alibailian/api/v1/tasks/{taskId}`,
    pollHeaders: { 'Authorization': `Bearer ${apiKey}` },
    intervalMs: 5000,
    onProgress,
    signal,
    parse: {
      taskIdPaths: ['output.task_id', 'task_id', 'id'],
      statusPaths: ['output.task_status', 'status'],
      resultUrlPaths: ['output.video_url', 'video_url', 'url'],
      errorPaths: ['output.message', 'output.error', 'message', 'error'],
      successStatuses: ['succeeded', 'success', 'completed'],
      failureStatuses: ['failed', 'error'],
    },
  });
}

// ==================== Kling 可灵全系列格式 ====================
// OpenAI 兼容中转: POST /kling/v1/videos/{path} + GET /kling/v1/videos/{path}/{task_id}

/**
 * Resolve kling model name for API requests.
 * Composite IDs like 'kling-image-v1-5' → 'kling-v1-5' (OpenAI 兼容中转 version ID).
 * Video version IDs (kling-v2-6) pass through unchanged.
 */
function resolveKlingModelName(model: string): string {
  const match = model.match(/^kling-image-(v.+)$/);
  return match ? `kling-${match[1]}` : model;
}

// Native Kling endpoint paths (relative to /kling/v1/videos/)
// kling-video variants (kling-v2-1-master, kling-v3-0-pro, etc.) fall through to text2video / image2video
const KLING_VIDEO_PATH_MAP: Record<string, string> = {
  'kling-omni-video': 'omni-video',
  'kling-video-extend': 'video-extend',
  'kling-motion-control': 'motion-control',
  'kling-multi-elements': 'multi-elements',
  'kling-avatar-image2video': 'avatar/image2video',
  'kling-advanced-lip-sync': 'advanced-lip-sync',
  'kling-effects': 'effects',
};

async function callKlingVideoApi(
  apiKey: string,
  prompt: string,
  baseUrl: string,
  model: string,
  aspectRatio: string,
  imageWithRoles: Array<{ url: string; role: string }>,
  duration?: number,
  onProgress?: (progress: number) => void,
  keyManager?: { handleError: (status: number, errorText?: string) => boolean },
  signal?: AbortSignal,
): Promise<string> {
  const firstFrame = imageWithRoles.find(img => img.role === 'first_frame');
  const lastFrame = imageWithRoles.find(img => img.role === 'last_frame');

  // Determine the endpoint path: specialized models have a fixed path;
  // all kling-video variants fall through to text2video / image2video
  const specialPath = KLING_VIDEO_PATH_MAP[model];
  const endpointPath = specialPath || (firstFrame?.url ? 'image2video' : 'text2video');

  // Kling 用 model_name 而不是 model
  const requestBody: Record<string, unknown> = {
    model_name: resolveKlingModelName(model),
    prompt,
    aspect_ratio: aspectRatio,
    duration: duration ? String(Math.min(10, Math.max(5, duration))) : '5',
    mode: 'std',
  };

  // Attach image URLs for image-based endpoints
  if (endpointPath === 'image2video' && firstFrame?.url) {
    requestBody.image_url = firstFrame.url;
    if (lastFrame?.url) requestBody.tail_image_url = lastFrame.url;
  } else if (endpointPath === 'avatar/image2video' && firstFrame?.url) {
    requestBody.image_url = firstFrame.url;
  }

  const submitUrl = `${baseUrl}/kling/v1/videos/${endpointPath}`;
  console.log('[VideoGen] Kling format →', endpointPath, { model, submitUrl });

  return runBackendVideoTask({
    provider: 'Kling',
    model,
    route: `/kling/v1/videos/${endpointPath}`,
    label: `kling-video:${model}`,
    submitUrl,
    submitHeaders: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    submitBody: JSON.stringify(requestBody),
    pollUrl: `${baseUrl}/kling/v1/videos/${endpointPath}/{taskId}`,
    pollHeaders: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    intervalMs: 5000,
    onProgress,
    signal,
    parse: {
      taskIdPaths: ['data.task_id', 'task_id', 'id'],
      statusPaths: ['data.task_status', 'status'],
      resultUrlPaths: ['data.task_result.videos.0.url', 'data.task_result.video_url', 'data.video_url', 'video_url', 'url'],
      errorPaths: ['data.task_status_msg', 'message', 'error'],
      successStatuses: ['succeed', 'success', 'completed', 'succeeded'],
      failureStatuses: ['failed', 'error'],
    },
  });
}

// ==================== OpenAI 官方视频格式 (sora-2) ====================
// OpenAI 兼容中转: POST /v1/videos (FormData) + GET /v1/videos/{taskId}

/**
 * Convert aspect ratio + resolution to Sora pixel size (e.g. '1280x720')
 */
function toSoraSize(aspectRatio?: string, resolution?: string): string {
  const isPortrait = aspectRatio === '9:16' || aspectRatio === '3:4';
  const is1080 = (resolution || '').toLowerCase().includes('1080');
  if (is1080) return isPortrait ? '1080x1920' : '1920x1080';
  return isPortrait ? '720x1280' : '1280x720';
}

async function callOpenAIOfficialVideoApi(
  apiKey: string,
  prompt: string,
  baseUrl: string,
  model: string,
  aspectRatio: string,
  duration?: number,
  videoResolution?: string,
  onProgress?: (progress: number) => void,
  keyManager?: { handleError: (status: number, errorText?: string) => boolean },
  signal?: AbortSignal,
): Promise<string> {
  const submitUrl = `${baseUrl}/v1/videos`;
  console.log('[VideoGen] OpenAI Official format → POST /v1/videos', { model, size: toSoraSize(aspectRatio, videoResolution) });

  return runBackendVideoTask({
    provider: 'OpenAI 官方视频',
    model,
    route: '/v1/videos',
    label: `openai-video:${model}`,
    submitUrl,
    submitHeaders: { 'Authorization': `Bearer ${apiKey}` },
    submitFormData: [
      { name: 'model', value: model },
      { name: 'prompt', value: prompt },
      { name: 'size', value: toSoraSize(aspectRatio, videoResolution) },
      { name: 'seconds', value: String(duration || 10) },
    ],
    pollUrl: `${baseUrl}/v1/videos/{taskId}`,
    pollHeaders: { 'Authorization': `Bearer ${apiKey}` },
    fallbackUrl: `${baseUrl}/v1/videos/{taskId}/content`,
    intervalMs: 5000,
    onProgress,
    signal,
  });
}

// ==================== Replicate 视频格式 ====================
// OpenAI 兼容中转: POST /replicate/v1/predictions + GET /replicate/v1/predictions/{id}

async function callReplicateVideoApi(
  apiKey: string,
  prompt: string,
  baseUrl: string,
  model: string,
  aspectRatio: string,
  imageWithRoles: Array<{ url: string; role: string }>,
  duration?: number,
  videoResolution?: string,
  onProgress?: (progress: number) => void,
  keyManager?: { handleError: (status: number, errorText?: string) => boolean },
  signal?: AbortSignal,
): Promise<string> {
  // rootBase: strip /v1 suffix for /replicate/ prefix path
  const rootBase = baseUrl.replace(/\/v\d+$/, '');

  const input: Record<string, unknown> = { prompt };
  if (aspectRatio) input.aspect_ratio = aspectRatio;
  if (duration) input.duration = duration;
  if (videoResolution) input.resolution = videoResolution;

  // Image-to-video: attach first frame inside input
  const firstFrame = imageWithRoles.find(img => img.role === 'first_frame');
  if (firstFrame?.url) input.image = firstFrame.url;
  const lastFrame = imageWithRoles.find(img => img.role === 'last_frame');
  if (lastFrame?.url) input.tail_image = lastFrame.url;

  const submitUrl = `${rootBase}/replicate/v1/predictions`;
  console.log('[VideoGen] Replicate format → POST /replicate/v1/predictions', { model });

  return runBackendVideoTask({
    provider: 'Replicate',
    model,
    route: '/replicate/v1/predictions',
    label: `replicate-video:${model}`,
    submitUrl,
    submitHeaders: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    submitBody: JSON.stringify({ model, input }),
    pollUrl: `${rootBase}/replicate/v1/predictions/{taskId}`,
    pollHeaders: { 'Authorization': `Bearer ${apiKey}` },
    intervalMs: 5000,
    onProgress,
    signal,
    parse: {
      successStatuses: ['succeeded', 'completed', 'success'],
      failureStatuses: ['failed', 'error', 'canceled', 'cancelled'],
      errorPaths: ['error', 'message'],
    },
  });
}

// Save video to local and return the local URL
export async function saveVideoLocally(videoUrl: string, sceneId: number): Promise<string> {
  try {
    const filename = `scene_${sceneId + 1}_${Date.now()}.mp4`;
    const localUrl = await saveVideoToLocal(videoUrl, filename);
    console.log('[VideoGen] Video saved locally:', localUrl);
    return localUrl;
  } catch (e) {
    console.warn('[VideoGen] Failed to save video locally, using URL:', e);
    return videoUrl;
  }
}

/**
 * Extract the last frame from a video URL as base64 image
 * Uses video element + canvas for frame extraction
 * @param videoUrl - Video URL (HTTP or local)
 * @param seekOffset - Seconds before end to extract (default 0.1s from end)
 * @returns Base64 data URL of the frame, or null on failure
 */
export async function extractLastFrameFromVideo(
  videoUrl: string,
  seekOffset: number = 0.1
): Promise<string | null> {
  // local-image:// 由平台媒体适配器解析，不需要转换为 file://。
  const resolvedUrl = videoUrl.startsWith('local-image://')
    ? await window.imageStorage?.getImagePath(videoUrl) || videoUrl
    : videoUrl;
  console.log('[VideoGen] Loading video for frame extraction:', resolvedUrl);
  
  return new Promise((resolve) => {
    const video = document.createElement('video');
    // local-image:// 由同一平台适配器提供，不需要 crossOrigin。
    if (!resolvedUrl.startsWith('local-image://') && !resolvedUrl.startsWith('file://')) {
      video.crossOrigin = 'anonymous';
    }
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    
    let hasResolved = false;
    let targetTime = -1; // -1 表示还未设置
    let isSeekStarted = false;
    
    const cleanup = () => {
      video.onloadedmetadata = null;
      video.onloadeddata = null;
      video.oncanplaythrough = null;
      video.onseeked = null;
      video.onerror = null;
      video.ontimeupdate = null;
      video.pause();
      video.src = '';
      video.load();
    };
    
    const timeoutId = setTimeout(() => {
      if (!hasResolved) {
        hasResolved = true;
        console.warn('[VideoGen] extractLastFrameFromVideo timeout');
        cleanup();
        resolve(null);
      }
    }, 30000); // 30s timeout
    
    const captureFrame = () => {
      if (hasResolved) return;
      
      // 确保视频尺寸有效
      if (video.videoWidth === 0 || video.videoHeight === 0) {
        console.warn('[VideoGen] Video dimensions not ready, waiting...');
        setTimeout(captureFrame, 100);
        return;
      }
      
      try {
        video.pause();
        
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        
        if (!ctx) {
          console.warn('[VideoGen] Cannot get canvas context');
          hasResolved = true;
          clearTimeout(timeoutId);
          cleanup();
          resolve(null);
          return;
        }
        
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
        
        console.log('[VideoGen] Extracted last frame:', {
          width: canvas.width,
          height: canvas.height,
          duration: video.duration,
          currentTime: video.currentTime,
          targetWas: targetTime,
        });
        
        hasResolved = true;
        clearTimeout(timeoutId);
        cleanup();
        resolve(dataUrl);
      } catch (e) {
        console.warn('[VideoGen] Failed to extract frame:', e);
        hasResolved = true;
        clearTimeout(timeoutId);
        cleanup();
        resolve(null);
      }
    };
    
    // 开始 seek 的函数
    const startSeek = () => {
      if (hasResolved || isSeekStarted) return;
      
      const duration = video.duration;
      if (!duration || duration <= 0 || !isFinite(duration)) {
        console.warn('[VideoGen] Invalid video duration:', duration);
        return;
      }
      
      isSeekStarted = true;
      targetTime = Math.max(0.1, duration - seekOffset);
      console.log('[VideoGen] Starting seek, duration:', duration, 'target:', targetTime);
      
      video.currentTime = targetTime;
    };
    
    // 方法：使用 timeupdate 监听播放进度，当接近目标时间时捕获
    video.ontimeupdate = () => {
      if (hasResolved || targetTime < 0) return; // 未开始 seek 时忽略
      
      // 当播放到目标时间附近时捕获帧
      if (video.currentTime >= targetTime - 0.05) {
        console.log('[VideoGen] timeupdate reached target, currentTime:', video.currentTime, 'target:', targetTime);
        captureFrame();
      }
    };
    
    // 当 seek 完成时捕获
    video.onseeked = () => {
      if (hasResolved || targetTime < 0) return;
      console.log('[VideoGen] onseeked fired, currentTime:', video.currentTime, 'target:', targetTime);
      
      // 检查是否真的 seek 到了目标位置
      if (Math.abs(video.currentTime - targetTime) < 0.5) {
        // seek 成功，等待一下再捕获
        setTimeout(captureFrame, 200);
      } else {
        // seek 可能失败，尝试播放到目标位置
        console.log('[VideoGen] Seek may have failed, trying play approach...');
        video.playbackRate = 16; // 快速播放
        video.play().catch(() => {
          // 如果播放失败，直接捕获当前帧
          console.warn('[VideoGen] Play failed, capturing current frame');
          captureFrame();
        });
      }
    };
    
    // 当视频数据加载完成时尝试 seek
    video.onloadeddata = () => {
      if (hasResolved) return;
      console.log('[VideoGen] onloadeddata, readyState:', video.readyState, 'duration:', video.duration);
      startSeek();
    };
    
    // 当可以播放时也尝试 seek（备选）
    video.oncanplaythrough = () => {
      if (hasResolved) return;
      console.log('[VideoGen] oncanplaythrough, readyState:', video.readyState, 'duration:', video.duration);
      startSeek();
    };
    
    video.onerror = (e) => {
      if (!hasResolved) {
        hasResolved = true;
        console.warn('[VideoGen] Video load error:', e);
        clearTimeout(timeoutId);
        cleanup();
        resolve(null);
      }
    };
    
    video.src = resolvedUrl;
    video.load();
  });
}

// ==================== 聚鑫API Grok Video Generation ====================

/**
 * Convert aspect ratio to Grok format
 */
function toGrokAspectRatio(aspectRatio: string): string {
  // Grok supports: 2:3, 3:2, 1:1
  if (aspectRatio === '9:16' || aspectRatio === '3:4') return '2:3';
  if (aspectRatio === '1:1') return '1:1';
  // 16:9, 4:3, 21:9 → 3:2 (closest landscape)
  return '3:2';
}

/**
 * Call JuxinAPI (Grok) video generation API
 * API Documentation: https://juxinapi.apifox.cn/doc-7302525
 * 
 * Create video: POST /v1/video/create
 * Query task: GET /v1/video/query?id={taskId}
 */
export async function callJuxinVideoGenerationApi(
  apiKey: string,
  prompt: string,
  aspectRatio: string,
  imageWithRoles: Array<{ url: string; role: 'first_frame' | 'last_frame' }>,
  onProgress?: (progress: number) => void,
  keyManager?: { getCurrentKey?: () => string | null; handleError: (status: number, errorText?: string) => boolean; getAvailableKeyCount: () => number; getTotalKeyCount: () => number },
  baseUrl?: string,
  model?: string,
  signal?: AbortSignal,
): Promise<string> {
  const apiBaseUrl = baseUrl?.replace(/\/+$/, '');
  if (!apiBaseUrl) {
    throw new Error('请先在设置中配置视频生成服务映射');
  }
  if (!model) {
    throw new Error('请先在设置中配置视频生成模型');
  }
  console.log('[VideoGen] Using JuxinAPI (Grok) for video generation');
  
  // Extract first frame URL for Grok
  const images: string[] = [];
  const firstFrame = imageWithRoles.find(img => img.role === 'first_frame');
  if (firstFrame?.url) {
    images.push(firstFrame.url);
  }
  
  const requestBody = {
    model,
    prompt,
    aspect_ratio: toGrokAspectRatio(aspectRatio),
    size: '720P', // Currently only 720P is supported
    images,
  };
  
  console.log('[VideoGen] Grok request:', requestBody);

  const currentApiKey = keyManager?.getCurrentKey?.() || apiKey;
  return runBackendVideoTask({
    provider: 'Grok',
    model,
    route: '/v1/video/create',
    label: `grok-video:${model}`,
    submitUrl: `${apiBaseUrl}/v1/video/create`,
    submitHeaders: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${currentApiKey}`,
    },
    submitBody: JSON.stringify(requestBody),
    pollUrl: `${apiBaseUrl}/v1/video/query?id={taskId}`,
    pollHeaders: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${currentApiKey}`,
    },
    intervalMs: 5000,
    onProgress,
    signal,
  });
}
