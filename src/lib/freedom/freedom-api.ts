// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.

/**
 * Freedom Panel API Client
 * Wraps santi-creator's existing AI infrastructure for single-shot generation
 * Features: smart endpoint routing, retry with exponential backoff
 */

import {
  getAllFeatureConfigs,
  getFeatureConfig,
  getFeatureNotConfiguredMessage,
  type FeatureConfig,
} from '@/lib/ai/feature-router';
import { submitGridImageRequest } from '@/lib/ai/image-generator';
import { resolveImageApiFormat } from '@/lib/api-key-manager';
import {
  AGNES_VIDEO_LAST_FRAME_UNSUPPORTED_MESSAGE,
  isAgnesImageModel,
  isAgnesProvider,
  isAgnesVideoModel,
  isImage2ModelName,
  resolveProviderImageApiFormat,
} from '@/lib/ai/provider-platforms';
import { corsFetch } from '@/lib/cors-fetch';
import { mediaUrlToBlob, mediaUrlToDataUrl, resolveImageToHttpUrl } from '@/lib/media-url-resolver';
import { uploadBase64Image } from '@/lib/utils/image-upload';
import { isVeoModel, resolveVeoUploadCapability } from '@/lib/freedom/veo-capability';
import { type AIFeature, useAPIConfigStore } from '@/stores/api-config-store';
import { useMediaStore } from '@/stores/media-store';
import { useProjectStore } from '@/stores/project-store';
import { buildVolcVideoTaskUrls, isVolcArkVideoPlatform } from '@/lib/volc-ark-video';
import { toast } from 'sonner';

// ==================== Types ====================

export interface FreedomImageParams {
  prompt: string;
  model?: string;
  size?: string;
  aspectRatio?: string;
  resolution?: string;
  width?: number;
  height?: number;
  negativePrompt?: string;
  referenceImages?: FreedomImageReference[];
  extraParams?: Record<string, any>;
}

export interface FreedomImageReference {
  url: string;
  purpose: string;
  name?: string;
}

export type FreedomVideoUploadRole = 'single' | 'first' | 'last' | 'reference';

export interface FreedomVideoUploadFile {
  role: FreedomVideoUploadRole;
  dataUrl: string;
  fileName?: string;
  mimeType?: string;
}

export interface FreedomVideoParams {
  prompt: string;
  model?: string;
  aspectRatio?: string;
  duration?: number;
  resolution?: string;
  uploadFiles?: FreedomVideoUploadFile[];
}

export interface GenerationResult {
  url: string;
  taskId?: string;
  mediaId?: string;
}

// ==================== Constants ====================

const IMAGE_POLL_INTERVAL = 2000;
const IMAGE_POLL_MAX_ATTEMPTS = 300; // 10 minutes at 2s intervals
const VIDEO_POLL_INTERVAL = 2000;
const VIDEO_POLL_MAX_ATTEMPTS = 120;

// Retry config
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY = 3000;

type FreedomKeyManager = {
  getCurrentKey: () => string | null;
  handleError: (status: number, errorText?: string) => boolean;
};

// ==================== Retry Logic ====================

/**
 * Check if an error is retryable (rate limit / service unavailable / upstream overload)
 */
function isRetryableError(error: unknown): boolean {
  if (!error) return false;
  const err = error as any;
  if (err.status === 429 || err.status === 500 || err.status === 502 || err.status === 503 || err.status === 529) return true;
  if (err.code === 429 || err.code === 500 || err.code === 502 || err.code === 503 || err.code === 529) return true;
  const message = (err.message || '').toLowerCase();
  return (
    message.includes('429') ||
    message.includes('500') ||
    message.includes('502') ||
    message.includes('503') ||
    message.includes('529') ||
    message.includes('rate') ||
    message.includes('quota') ||
    message.includes('too many requests') ||
    message.includes('service unavailable') ||
    message.includes('temporarily unavailable') ||
    message.includes('internal server error') ||
    message.includes('overloaded') ||
    message.includes('上游负载') ||
    message.includes('上游服务') ||
    message.includes('饱和') ||
    message.includes('负载已满') ||
    message.includes('暂时不可用') ||
    message.includes('服务暂时不可用') ||
    message.includes('无可用渠道') ||
    message.includes('no available channel') ||
    message.includes('server error')
  );
}

/**
 * Retry an operation with exponential backoff for retryable errors.
 * 支持 keyManager：遇到可重试错误时先触发 key 轮换，下次重试自动使用新 key。
 */
async function freedomRetry<T>(
  operation: () => Promise<T>,
  label: string,
  keyManager?: { handleError: (status: number, errorText?: string) => boolean } | null,
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      if (!isRetryableError(error)) throw error;

      // 触发 key 轮换（如果有 keyManager）
      const errStatus = (error as any)?.status;
      if (keyManager && typeof errStatus === 'number') {
        const rotated = keyManager.handleError(errStatus);
        if (rotated) {
          console.log(`[Freedom] ${label}: key rotated due to ${errStatus}`);
        }
      }

      if (attempt < RETRY_MAX_ATTEMPTS - 1) {
        const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
        console.warn(
          `[Freedom] ${label} hit retryable error, retrying in ${delay}ms... ` +
          `(Attempt ${attempt + 1}/${RETRY_MAX_ATTEMPTS}): ${lastError.message}`
        );
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

// ==================== Helpers: Endpoint Building ====================

function buildEndpoint(baseUrl: string, path: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  return /\/v\d+$/.test(normalized) ? `${normalized}/${path}` : `${normalized}/v1/${path}`;
}

function getRootBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  return normalized.replace(/\/v\d+$/, '');
}

function pickFeatureConfig(feature: AIFeature, requestedModel?: string): FeatureConfig | null {
  const all = getAllFeatureConfigs(feature);
  if (all.length === 0) return null;
  if (requestedModel) {
    const exact = all.find((c) => c.model === requestedModel);
    if (exact) return exact;
    // UI 展开的变体模型（如 gemini-3.1-pro 从绑定的 gemini-3-pro 展开而来）不会
    // 精确匹配到任何 config.model，此时回退到轮询配置而非返回 null，
    // 避免用户选了可用变体却报"未配置"错误
  }
  return getFeatureConfig(feature) ?? all[0];
}

function resolveFreedomFeatureConfig(
  feature: 'freedom_image' | 'freedom_video',
  fallback: 'character_generation' | 'video_generation',
  requestedModel?: string,
): { config: FeatureConfig | null; source: string } {
  const primary = pickFeatureConfig(feature, requestedModel);
  if (primary) return { config: primary, source: feature };

  const fb = pickFeatureConfig(fallback, requestedModel);
  if (fb) return { config: fb, source: `${fallback} (fallback)` };

  return { config: null, source: feature };
}

type FreedomImageRoute = 'midjourney' | 'ideogram' | 'agnes' | 'kling_image' | 'openai_chat' | 'openai_responses_image' | 'openai_images' | 'replicate';

type FreedomImageReferenceMode = 'midjourney_base64' | 'openai_multimodal' | 'generic_image_urls' | 'none';

interface ResolvedFreedomImageReference extends FreedomImageReference {
  inputUrl: string;
}

function isFreedomGptImageModel(model: string): boolean {
  const lower = model.toLowerCase();
  return isImage2ModelName(model) || /^gpt-image(?:$|[-_.])/.test(lower) || lower.includes('chatgpt-image');
}

function detectFreedomImageRoute(
  model: string,
  endpointTypes?: string[],
  platform?: string,
  baseUrl?: string,
): FreedomImageRoute {
  const hasEndpoint = (re: RegExp) => (endpointTypes || []).some((t) => re.test(t));
  const hasExactEndpoint = (name: string) => (endpointTypes || []).includes(name);

  if (/^mj_/i.test(model) || /midjourney/i.test(model) || /^niji-/i.test(model) || hasEndpoint(/midjourney/i)) {
    return 'midjourney';
  }
  if (/^ideogram_/i.test(model)) {
    return 'ideogram';
  }
  if (isAgnesProvider(platform) && isAgnesImageModel(model)) {
    return 'agnes';
  }
  // Kling image: 模型名检测 + 端点元数据检测
  if (/^kling-(image|omni-image)/i.test(model) || hasExactEndpoint('kling生图') || hasExactEndpoint('omni-image') || hasExactEndpoint('文生图')) {
    return 'kling_image';
  }

  // Replicate: endpoint type uses '{org}/{model}异步' pattern (contains '/' before '异步')
  if ((endpointTypes || []).some(t => t.includes('/') && t.endsWith('异步'))) {
    return 'replicate';
  }

  const baseRoute = resolveProviderImageApiFormat({
    platform,
    model,
    apiFormat: resolveImageApiFormat(endpointTypes, model),
  });
  if (baseRoute === 'openai_responses_image') return 'openai_responses_image';
  return baseRoute === 'openai_chat' ? 'openai_chat' : 'openai_images';
}

function getFreedomImageReferenceMode(
  route: FreedomImageRoute,
  model: string,
  endpointTypes?: string[],
): FreedomImageReferenceMode {
  if (route === 'midjourney') return 'midjourney_base64';
  if (route === 'agnes') return 'generic_image_urls';
  if (route === 'openai_chat' || route === 'openai_responses_image') return 'openai_multimodal';
  if (route === 'openai_images') {
    if (isFreedomGptImageModel(model)) return 'generic_image_urls';
    const supportsGenericRefs = (endpointTypes || []).some((type) => /vidu生图|aigc-image|参考|reference|图生图|image.?to.?image|i2i|edit/i.test(type));
    return supportsGenericRefs ? 'generic_image_urls' : 'none';
  }
  if (route === 'kling_image' && (model === 'kling-omni-image' || (endpointTypes || []).includes('omni-image'))) {
    return 'generic_image_urls';
  }
  return 'none';
}

function getReferenceUnsupportedError(params: FreedomImageParams, mode: FreedomImageReferenceMode): string | undefined {
  if (!params.referenceImages || params.referenceImages.length === 0 || mode !== 'none') return undefined;
  return '当前生图模型不支持产品参考图，请在设置中选择支持参考图的生图模型';
}

async function resolveFreedomImageReferences(
  referenceImages?: FreedomImageReference[],
  options: { preferHttpUrl?: boolean; forceDataUrl?: boolean } = {},
): Promise<ResolvedFreedomImageReference[]> {
  const refs = referenceImages || [];
  const resolved: ResolvedFreedomImageReference[] = [];

  for (const ref of refs) {
    if (!ref.url) continue;

    let inputUrl = ref.url;
    if (options.forceDataUrl && !ref.url.startsWith('data:image/')) {
      inputUrl = await mediaUrlToDataUrl(ref.url);
    } else if (!/^https?:\/\//i.test(ref.url) && !ref.url.startsWith('data:image/')) {
      inputUrl = await mediaUrlToDataUrl(ref.url);
    }

    if (options.preferHttpUrl && !/^https?:\/\//i.test(inputUrl)) {
      try {
        inputUrl = await resolveImageToHttpUrl(inputUrl, {
          uploadName: ref.name,
          logPrefix: 'Freedom',
        });
      } catch (error) {
        console.warn('[Freedom] Failed to upload reference image, falling back to original input:', error);
      }
    }

    resolved.push({ ...ref, inputUrl });
  }

  return resolved;
}

type FreedomVideoRoute = 'openai_official' | 'unified' | 'agnes' | 'volc' | 'volc_ark' | 'wan' | 'kling' | 'replicate';

const FREEDOM_VIDEO_ROUTE_MAP: Record<string, FreedomVideoRoute> = {
  'openAI官方视频格式': 'openai_official',
  'openAI视频格式': 'openai_official',
  '豆包视频异步': 'volc',  // OpenAI 兼容中转的 doubao-seedance 路由；火山方舟官方平台按 platform 单独分流
  '异步': 'wan',
  '文生视频': 'kling',
  '图生视频': 'kling',
  '视频延长': 'kling',
  'omni-video': 'kling',
  '动作控制': 'kling',
  '多模态视频编辑': 'kling',
  '数字人': 'kling',
  '对口型': 'kling',
  '视频特效': 'kling',
  'openai': 'unified', // 某些自定义供应商把视频模型标为通用 openai
  '视频统一格式': 'unified',
  'grok视频': 'unified',
  'openai-response': 'unified',
  '海螺视频生成': 'unified',
  'luma视频生成': 'unified',
  'luma视频扩展': 'unified',
  'runway图生视频': 'unified',
  'aigc-video': 'unified',
  'wan视频生成': 'unified',  // wan2.6 models use aggregator /v1/video/generations
  // Vidu endpoint types (all route to unified /v1/video/generations)
  'vidu文生视频': 'unified',
  'vidu图生视频': 'unified',
  'vidu参考生视频': 'unified',
  'vidu首尾帧': 'unified',
  'luma视频延长': 'unified',  // luma extend uses 延长 (file 04 naming)
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
 * 图片端点路径映射（端点类型 → 提交/轮询 URL 路径）
 * 仅用于需要自定义路径的端点类型，其余走默认 /v1/images/generations
 */
const IMAGE_ENDPOINT_PATHS: Record<string, { submit: string; poll: (id: string) => string }> = {
  'aigc-image': { submit: '/tencent-vod/v1/aigc-image', poll: (id) => `/tencent-vod/v1/aigc-image/${id}` },
  'vidu生图':   { submit: '/ent/v2/reference2image',    poll: (id) => `/ent/v2/task?task_id=${id}` },
};
const DEFAULT_IMAGE_ENDPOINT = { submit: '/v1/images/generations', poll: (id: string) => `/v1/images/generations/${id}` };

function getImageEndpointPaths(endpointTypes: string[]): { submit: string; poll: (id: string) => string } {
  for (const t of endpointTypes) {
    if (IMAGE_ENDPOINT_PATHS[t]) return IMAGE_ENDPOINT_PATHS[t];
  }
  return DEFAULT_IMAGE_ENDPOINT;
}

function getUnifiedEndpointPaths(endpointTypes: string[]): { submit: string; poll: (id: string) => string } {
  for (const t of endpointTypes) {
    if (UNIFIED_ENDPOINT_PATHS[t]) return UNIFIED_ENDPOINT_PATHS[t];
  }
  return DEFAULT_UNIFIED_ENDPOINT;
}

function detectFreedomVideoRoute(model: string, endpointTypes?: string[], platform?: string): FreedomVideoRoute {
  if (isAgnesProvider(platform) && isAgnesVideoModel(model)) return 'agnes';
  if (isVolcArkVideoPlatform(platform)) return 'volc_ark';

  if (endpointTypes && endpointTypes.length > 0) {
    // 优先级：官方 Sora -> Kling -> Volc -> Wan -> Replicate -> Unified
    for (const t of endpointTypes) {
      if (FREEDOM_VIDEO_ROUTE_MAP[t] === 'openai_official') return 'openai_official';
    }
    for (const t of endpointTypes) {
      if (FREEDOM_VIDEO_ROUTE_MAP[t] === 'kling') return 'kling';
    }
    for (const t of endpointTypes) {
      if (FREEDOM_VIDEO_ROUTE_MAP[t] === 'volc') return 'volc';
    }
    for (const t of endpointTypes) {
      if (FREEDOM_VIDEO_ROUTE_MAP[t] === 'wan') return 'wan';
    }
    // Replicate: endpoint type uses '{org}/{model}异步' pattern (contains '/' before '异步')
    if (endpointTypes.some(t => t.includes('/') && t.endsWith('异步'))) return 'replicate';
    for (const t of endpointTypes) {
      if (FREEDOM_VIDEO_ROUTE_MAP[t] === 'unified') return 'unified';
    }
  }

  const m = model.toLowerCase();
  if (m.includes('sora-2')) return 'openai_official';
  if (m.includes('kling')) return 'kling';
  if (m.includes('seedance') || m.includes('doubao')) return 'volc';
  if (m.includes('wan')) return 'wan';
  return 'unified';
}

// ==================== Image Generation ====================

export async function generateFreedomImage(
  params: FreedomImageParams
): Promise<GenerationResult> {
  const { config } = resolveFreedomFeatureConfig('freedom_image', 'character_generation', params.model);
  return freedomRetry(() => _generateFreedomImageInner(params), 'Image generation', config?.keyManager);
}

async function _generateFreedomImageInner(
  params: FreedomImageParams
): Promise<GenerationResult> {
  const { config, source: configSource } = resolveFreedomFeatureConfig(
    'freedom_image',
    'character_generation',
    params.model,
  );
  if (!config) {
    const msg = getFeatureNotConfiguredMessage('character_generation');
    toast.error('自由板块图片生成未配置：请在设置中配置「自由板块-图片」或「图片生成」服务映射');
    throw new Error(msg);
  }
  console.log(`[Freedom] Image config source: ${configSource}`);

  const { baseUrl, model: defaultModel } = config;
  // 每次重试动态取当前 key（利用 keyManager rotate 后的新 key）
  const apiKey = config.keyManager?.getCurrentKey?.() || config.apiKey;
  // 模型 ID 直接透传：UI 选的就是供应商原始 ID，无需转换
  const model = (params.model || defaultModel || '').trim();
  if (!model) {
    const message = '自由板块图片生成未选择模型：请在设置的服务映射中为「自由板块-图片」或「图片生成」选择具体模型';
    toast.error(message);
    throw new Error(message);
  }
  if (isAgnesProvider(config.platform) && !isAgnesImageModel(model)) {
    const message = '当前自由板块图片服务选择的是 Agnes AI，但所选模型不是 Agnes 图片模型。请改用 agnes-image-2.1-flash / agnes-image-2.0-flash，或选择其他支持图片生成的供应商。';
    toast.error(message);
    throw new Error(message);
  }
  const normalizedBase = baseUrl.replace(/\/+$/, '');

  // ── Smart Routing: choose endpoint based on model metadata ──
  const endpointTypes = useAPIConfigStore.getState().modelEndpointTypes[model];
  const route = detectFreedomImageRoute(model, endpointTypes, config.platform, normalizedBase);
  const referenceMode = getFreedomImageReferenceMode(route, model, endpointTypes);
  const referenceError = getReferenceUnsupportedError(params, referenceMode);
  if (referenceError) {
    toast.error(referenceError);
    throw new Error(referenceError);
  }
  console.log('[Freedom] Generating image:', {
    model,
    route,
    endpointTypes,
    referenceMode,
    referenceCount: params.referenceImages?.length || 0,
    prompt: params.prompt.slice(0, 50),
  });

  if (route === 'midjourney') {
    return generateViaMidjourneyEndpoint(params, model, apiKey, normalizedBase);
  }
  if (route === 'ideogram') {
    return generateViaIdeogramEndpoint(params, model, apiKey, normalizedBase);
  }
  if (route === 'agnes') {
    return generateViaAgnesImagesEndpoint(params, model, apiKey, normalizedBase);
  }
  if (route === 'openai_responses_image') {
    return generateViaResponsesImage(params, model, apiKey, normalizedBase, config.keyManager, config.platform);
  }
  if (route === 'openai_chat') {
    return generateViaChatCompletions(params, model, apiKey, normalizedBase);
  }
  if (route === 'kling_image') {
    return generateViaKlingImagesEndpoint(params, model, apiKey, normalizedBase);
  }
  if (route === 'replicate') {
    return generateViaReplicateImageEndpoint(params, model, apiKey, normalizedBase);
  }
  return generateViaImagesEndpoint(params, model, apiKey, normalizedBase, endpointTypes, config.keyManager);
}

/**
 * Generate image via /v1/chat/completions (for Gemini, GPT-image, etc.)
 */
async function generateViaChatCompletions(
  params: FreedomImageParams,
  model: string,
  apiKey: string,
  baseUrl: string,
): Promise<GenerationResult> {
  const endpoint = buildEndpoint(baseUrl, 'chat/completions');
  const aspectRatio = params.aspectRatio || '1:1';
  const referenceImages = await resolveFreedomImageReferences(params.referenceImages);

  const userContent: Array<{ type: string; text?: string; image_url?: { url: string; detail?: 'high' | 'auto' } }> = [
    { type: 'text', text: `Generate an image with aspect ratio ${aspectRatio}: ${params.prompt}` },
  ];
  for (const [index, ref] of referenceImages.entries()) {
    userContent.push({
      type: 'text',
      text: `Reference image ${index + 1}: purpose=${ref.purpose}${ref.name ? `, name=${ref.name}` : ''}. Preserve product identity from this image.`,
    });
    userContent.push({
      type: 'image_url',
      image_url: {
        url: ref.inputUrl,
        detail: ref.purpose === 'usage_scene' ? 'auto' : 'high',
      },
    });
  }

  const requestBody = {
    model,
    messages: [{ role: 'user', content: userContent }],
    max_tokens: 4096,
  };

  console.log('[Freedom] Submitting via chat completions:', { model, endpoint, referenceCount: referenceImages.length });

  const response = await corsFetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    let msg = `图片生成 API 错误: ${response.status}`;
    try { const j = JSON.parse(errorText); msg = j.error?.message || msg; } catch {}
    throw toHttpError(msg, response.status, errorText);
  }

  const data = await response.json();
  const imageUrl = extractChatCompletionsImage(data);

  if (!imageUrl) {
    throw new Error('未能从聊天响应中提取图片 URL');
  }

  const mediaId = saveToMediaLibrary(imageUrl, params.prompt, 'ai-image');
  return { url: imageUrl, mediaId };
}

/**
 * Generate IMAGE2 / gpt-image-2 via Responses API + image_generation tool.
 */
async function generateViaResponsesImage(
  params: FreedomImageParams,
  model: string,
  apiKey: string,
  baseUrl: string,
  keyManager?: FreedomKeyManager,
  providerPlatform?: string,
): Promise<GenerationResult> {
  const referenceImages = await resolveFreedomImageReferences(params.referenceImages);
  const result = await submitGridImageRequest({
    model,
    prompt: params.prompt,
    apiKey,
    baseUrl,
    providerPlatform,
    aspectRatio: params.aspectRatio || '1:1',
    resolution: params.resolution,
    referenceImages: referenceImages.map((ref) => ref.inputUrl),
    extraParams: {
      ...params.extraParams,
      ...(params.size ? { size: params.size } : {}),
    },
    keyManager,
  });

  if (!result.imageUrl) {
    throw new Error('Responses 图片生成完成但未返回图片结果');
  }

  const mediaId = saveToMediaLibrary(result.imageUrl, params.prompt, 'ai-image');
  return { url: result.imageUrl, taskId: result.taskId, mediaId };
}

/**
 * Extract image URL from chat completions response (multiple formats)
 */
function extractChatCompletionsImage(data: any): string | null {
  const choice = data.choices?.[0];
  if (!choice) return null;

  const message = choice.message;

  // Format 1: content is array with image parts (OpenAI multimodal)
  if (Array.isArray(message?.content)) {
    for (const part of message.content) {
      if (part.type === 'image_url' && part.image_url?.url) {
        return part.image_url.url;
      }
      if (part.type === 'image' && part.image?.url) {
        return part.image.url;
      }
      if (part.type === 'image' && part.data) {
        return `data:image/png;base64,${part.data}`;
      }
    }
  }

  // Format 2: content is string with markdown image link or base64
  if (typeof message?.content === 'string') {
    const mdMatch = message.content.match(/!\[.*?\]\((https?:\/\/[^)]+)\)/);
    if (mdMatch) return mdMatch[1];
    const b64Match = message.content.match(/(data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)/);
    if (b64Match) return b64Match[1];
  }

  return null;
}

/**
 * Generate image via standard /v1/images/generations endpoint
 */
async function generateViaImagesEndpoint(
  params: FreedomImageParams,
  model: string,
  apiKey: string,
  baseUrl: string,
  endpointTypes?: string[],
  keyManager?: FreedomKeyManager,
): Promise<GenerationResult> {
  if (isFreedomGptImageModel(model)) {
    const referenceImages = await resolveFreedomImageReferences(params.referenceImages, { forceDataUrl: true });
    const baseRequest = {
      model,
      prompt: params.prompt,
      apiKey,
      baseUrl,
      aspectRatio: params.aspectRatio || '1:1',
      resolution: params.resolution,
      extraParams: {
        ...params.extraParams,
        ...(params.size ? { size: params.size } : {}),
      },
      keyManager,
    };
    const result = await submitGridImageRequest({
      ...baseRequest,
      referenceImages: referenceImages.map((ref) => ref.inputUrl),
    });
    if (!result.imageUrl) {
      throw new Error('官方图片 API 响应未包含图片结果');
    }
    const mediaId = saveToMediaLibrary(result.imageUrl, params.prompt, 'ai-image');
    return { url: result.imageUrl, taskId: result.taskId, mediaId };
  }

  const referenceImages = await resolveFreedomImageReferences(params.referenceImages, { preferHttpUrl: true });
  const body: Record<string, any> = {
    prompt: params.prompt,
    model,
  };

  if (params.aspectRatio) body.aspect_ratio = params.aspectRatio;
  if (params.resolution) body.resolution = params.resolution;
  if (params.width) body.width = params.width;
  if (params.height) body.height = params.height;
  if (params.negativePrompt) body.negative_prompt = params.negativePrompt;
  if (referenceImages.length > 0) {
    body.image_urls = referenceImages.map((ref) => ref.inputUrl);
  }
  if (params.extraParams) {
    Object.assign(body, params.extraParams);
  }

  const imagePaths = getImageEndpointPaths(endpointTypes || []);
  const rootBase = getRootBaseUrl(baseUrl);
  const submitUrl = `${rootBase}${imagePaths.submit}`;
  const response = await corsFetch(submitUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw toHttpError('Image generation failed', response.status, errText);
  }

  const data = await response.json();

  // Try to get image URL directly
  let imageUrl = extractImageUrl(data);

  // If async task, poll for result
  if (!imageUrl && data.task_id) {
    const pollUrl = `${rootBase}${imagePaths.poll(String(data.task_id))}`;
    imageUrl = await pollForResult(
      pollUrl,
      apiKey,
      IMAGE_POLL_INTERVAL,
      IMAGE_POLL_MAX_ATTEMPTS
    );
  }

  if (!imageUrl) {
    throw new Error('No image URL in response');
  }

  const mediaId = saveToMediaLibrary(imageUrl, params.prompt, 'ai-image');
  return { url: imageUrl, taskId: data.task_id, mediaId };
}

function getAgnesImageInput(referenceImages: ResolvedFreedomImageReference[]): string | string[] | undefined {
  const images = referenceImages.map((ref) => ref.inputUrl).filter(Boolean);
  if (images.length === 0) return undefined;
  return images.length === 1 ? images[0] : images;
}

function getAgnesImageSize(params: FreedomImageParams): string {
  if (params.size) return params.size;
  if (params.width && params.height) return `${params.width}x${params.height}`;
  const ratio = params.aspectRatio || '1:1';
  const isPortrait = ratio === '9:16' || ratio === '3:4';
  const isWide = ratio === '16:9' || ratio === '4:3' || ratio === '21:9';
  if (isPortrait) return '1024x1536';
  if (isWide) return '1536x1024';
  return '1024x1024';
}

function assertFreedomAgnesImageInputsSupported(params: FreedomImageParams): void {
  const unsupported: string[] = [];
  if ((params.referenceImages || []).filter((ref) => !!ref.url).length > 1) {
    unsupported.push('多张参考图');
  }
  if (params.negativePrompt?.trim()) {
    unsupported.push('负面提示词');
  }

  const extraParams = params.extraParams || {};
  const allowedExtraParams = new Set(['size', 'n']);
  for (const key of Object.keys(extraParams)) {
    if (!allowedExtraParams.has(key)) unsupported.push(`高级参数 ${key}`);
  }
  if (extraParams.n != null && Number(extraParams.n) !== 1) {
    unsupported.push('多图数量 n>1');
  }

  if (unsupported.length === 0) return;
  throw new Error(`Agnes Image 目前只接入单张参考图、size 和 n=1；当前请求包含不支持的内容：${unsupported.join('、')}。请移除这些内容，或选择支持它们的图片模型。`);
}

async function generateViaAgnesImagesEndpoint(
  params: FreedomImageParams,
  model: string,
  apiKey: string,
  baseUrl: string,
): Promise<GenerationResult> {
  assertFreedomAgnesImageInputsSupported(params);
  const endpoint = buildEndpoint(baseUrl, 'images/generations');
  const referenceImages = await resolveFreedomImageReferences(params.referenceImages, { preferHttpUrl: true });
  const body: Record<string, any> = {
    model,
    prompt: params.prompt,
    n: 1,
    size: getAgnesImageSize(params),
  };
  const imageInput = getAgnesImageInput(referenceImages);
  if (imageInput) body.image = imageInput;
  if (params.extraParams) Object.assign(body, params.extraParams);

  const response = await corsFetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw toHttpError('Agnes image generation failed', response.status, await response.text());
  }

  const data = await response.json();
  let imageUrl = extractImageUrl(data);
  const taskId = data.task_id || data.id || data.data?.[0]?.task_id || data.data?.[0]?.id;
  if (!imageUrl && taskId) {
    imageUrl = await pollForResult(
      buildEndpoint(baseUrl, `images/generations/${taskId}`),
      apiKey,
      IMAGE_POLL_INTERVAL,
      IMAGE_POLL_MAX_ATTEMPTS,
    );
  }
  if (!imageUrl) throw new Error('Agnes 图片接口未返回图片 URL');

  const mediaId = saveToMediaLibrary(imageUrl, params.prompt, 'ai-image');
  return { url: imageUrl, taskId: taskId ? String(taskId) : undefined, mediaId };
}

/**
 * Resolve kling model name for API requests.
 * Composite IDs like 'kling-image-v1-5' → 'kling-v1-5' (OpenAI 兼容中转 version ID).
 * Video version IDs (kling-v2-6) pass through unchanged.
 */
function resolveKlingModelName(model: string): string {
  const match = model.match(/^kling-image-(v.+)$/);
  return match ? `kling-${match[1]}` : model;
}

/**
 * Generate image via Kling's native /kling/v1/images/* endpoints
 * Falls back to standard /v1/images/generations if native endpoint fails
 */
async function generateViaKlingImagesEndpoint(
  params: FreedomImageParams,
  model: string,
  apiKey: string,
  baseUrl: string,
): Promise<GenerationResult> {
  const rootBase = getRootBaseUrl(baseUrl);
  const referenceImages = await resolveFreedomImageReferences(params.referenceImages, { preferHttpUrl: true });
  const nativePath = model === 'kling-omni-image'
    ? 'kling/v1/images/omni-image'
    : 'kling/v1/images/generations';

  const body: Record<string, any> = { prompt: params.prompt, model: resolveKlingModelName(model) };
  if (params.aspectRatio) body.aspect_ratio = params.aspectRatio;
  if (params.negativePrompt) body.negative_prompt = params.negativePrompt;
  if (referenceImages.length > 0) {
    body.image_urls = referenceImages.map((ref) => ref.inputUrl);
  }
  if (params.extraParams) Object.assign(body, params.extraParams);

  let response: Response;
  try {
    response = await corsFetch(`${rootBase}/${nativePath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
  } catch {
    return generateViaImagesEndpoint(params, model, apiKey, baseUrl);
  }

  if (!response.ok) {
    return generateViaImagesEndpoint(params, model, apiKey, baseUrl);
  }

  const data = await response.json();
  let imageUrl = extractImageUrl(data);

  if (!imageUrl && data.task_id) {
    imageUrl = await pollForResult(
      `${rootBase}/${nativePath}/${data.task_id}`,
      apiKey,
      IMAGE_POLL_INTERVAL,
      IMAGE_POLL_MAX_ATTEMPTS,
    );
  }

  if (!imageUrl) {
    return generateViaImagesEndpoint(params, model, apiKey, baseUrl);
  }

  const mediaId = saveToMediaLibrary(imageUrl, params.prompt, 'ai-image');
  return { url: imageUrl, taskId: data.task_id, mediaId };
}

function formatHttpErrorMessage(prefix: string, status: number, body: string): string {
  try {
    const data = JSON.parse(body);
    const code = data.error?.code || data.code;
    const message = data.error?.message || data.message || body;
    const normalized = `${code || ''} ${message || ''}`.toLowerCase();

    if (code === 'AccountOverdueError' || normalized.includes('overdue balance')) {
      return `火山方舟账号欠费或余额不足（${status}${code ? ` ${code}` : ''}），请到火山方舟控制台充值或结清欠款后重试。`;
    }
    if (code === 'AuthenticationError' || status === 401) {
      return `API Key 无效或未授权（${status}${code ? ` ${code}` : ''}）：${message}`;
    }
    return `${prefix}: ${status}${code ? ` ${code}` : ''} ${message}`;
  } catch {
    return `${prefix}: ${status} ${body}`;
  }
}

function toHttpError(prefix: string, status: number, body: string): Error & { status: number } {
  const err = new Error(formatHttpErrorMessage(prefix, status, body)) as Error & { status: number };
  err.status = status;
  return err;
}

function previewJson(value: unknown, maxLength = 240): string {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
  } catch {
    return String(value);
  }
}

function normalizeVideoUrl(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return normalizeVideoUrl(value[0]);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return normalizeVideoUrl(record.url || record.video_url || record.output_url);
  }
  return undefined;
}

function getVolcTaskStatus(data: any): string {
  return String(
    data.status ||
    data.state ||
    data.task_status ||
    data.data?.status ||
    data.data?.task_status ||
    data.output?.status ||
    data.output?.task_status ||
    data.result?.status ||
    data.result?.task_status ||
    '',
  ).toLowerCase();
}

function getVolcTaskErrorMessage(data: any): string {
  const candidates = [
    data.error?.message,
    data.error?.code,
    data.error,
    data.message,
    data.data?.error?.message,
    data.data?.error,
    data.output?.message,
    data.output?.error,
    data.result?.message,
    data.result?.error,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return 'Volc 视频生成失败';
}

function buildMidjourneyPrompt(params: FreedomImageParams): string {
  let prompt = params.prompt;
  const extra = params.extraParams || {};
  const aspect = params.aspectRatio;
  const stylization = typeof extra.stylization === 'number' ? extra.stylization : undefined;
  const weirdness = typeof extra.weirdness === 'number' ? extra.weirdness : undefined;

  if (aspect && !/\s--ar\s+\S+/i.test(prompt)) {
    prompt += ` --ar ${aspect}`;
  }
  if (stylization !== undefined && !/\s--s(tylize)?\s+\S+/i.test(prompt)) {
    prompt += ` --s ${stylization}`;
  }
  if (weirdness !== undefined && !/\s--weird\s+\S+/i.test(prompt)) {
    prompt += ` --weird ${weirdness}`;
  }
  return prompt;
}

function mapMidjourneyMode(speed: unknown): string[] | undefined {
  if (typeof speed !== 'string') return undefined;
  const normalized = speed.toLowerCase();
  if (normalized === 'relaxed') return ['RELAX'];
  if (normalized === 'fast') return ['FAST'];
  if (normalized === 'turbo') return ['TURBO'];
  return undefined;
}

async function generateViaMidjourneyEndpoint(
  params: FreedomImageParams,
  model: string,
  apiKey: string,
  baseUrl: string,
): Promise<GenerationResult> {
  const rootBase = getRootBaseUrl(baseUrl);
  const submitUrl = `${rootBase}/mj/submit/imagine`;
  const extra = params.extraParams || {};
  const referenceImages = await resolveFreedomImageReferences(params.referenceImages, { forceDataUrl: true });
  const requestBody: Record<string, any> = {
    prompt: buildMidjourneyPrompt(params),
  };
  const modes = mapMidjourneyMode(extra.speed);
  if (modes) requestBody.accountFilter = { modes };
  if (/niji/i.test(model)) requestBody.botType = 'NIJI_JOURNEY';
  // 垫图：base64Array（图片引导，格式 data:image/png;base64,xxx）
  const base64Array = [
    ...(Array.isArray(extra.base64Array) ? extra.base64Array : []),
    ...referenceImages
      .map((ref) => ref.inputUrl)
      .filter((url) => url.startsWith('data:image/')),
  ];
  if (base64Array.length > 0) {
    requestBody.base64Array = base64Array;
  }

  const submitResp = await corsFetch(submitUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });
  if (!submitResp.ok) {
    throw toHttpError('Midjourney submit failed', submitResp.status, await submitResp.text());
  }

  const submitData = await submitResp.json();
  // MJ API 成功时 code === 1；其他值表示 API 层错误（即使 HTTP 200）
  if (submitData.code !== undefined && submitData.code !== 1) {
    throw new Error(submitData.description || submitData.error || `Midjourney 提交失败 (code=${submitData.code})`);
  }
  const taskId = submitData.result || submitData.task_id || submitData.id;
  if (!taskId) throw new Error('Midjourney 返回空任务 ID');

  const pollUrl = `${rootBase}/mj/task/${taskId}/fetch`;
  for (let i = 0; i < IMAGE_POLL_MAX_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const pollResp = await corsFetch(pollUrl, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (!pollResp.ok) continue;
    const pollData = await pollResp.json();
    const status = String(pollData.status || '').toLowerCase();
    if (status === 'success' || status === 'succeeded' || status === 'completed') {
      const imageUrl =
        pollData.imageUrl ||
        pollData.image_url ||
        pollData.url ||
        pollData.data?.imageUrl ||
        pollData.data?.image_url;
      if (!imageUrl) throw new Error('Midjourney 成功但未返回图片 URL');
      const mediaId = saveToMediaLibrary(imageUrl, params.prompt, 'ai-image');
      return { url: imageUrl, taskId: String(taskId), mediaId };
    }
    if (status === 'failure' || status === 'failed' || status === 'error') {
      throw new Error(pollData.failReason || pollData.message || 'Midjourney 生成失败');
    }
  }

  throw new Error('Midjourney 生成超时');
}

function toIdeogramAspectRatio(model: string, aspectRatio?: string): string | undefined {
  if (!aspectRatio) return undefined;

  // V1/V2 使用 ASPECT_16_9；V3 使用 16x9
  if (/_V_[12](_|$)/i.test(model)) {
    return `ASPECT_${aspectRatio.replace(':', '_')}`;
  }
  return aspectRatio.replace(':', 'x');
}

function toIdeogramRenderSpeed(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const normalized = input.toLowerCase();
  if (normalized === 'turbo') return 'TURBO';
  if (normalized === 'quality') return 'QUALITY';
  if (normalized === 'balanced') return 'DEFAULT';
  return input.toUpperCase();
}

/**
 * 从 model 名后缀自动提取 rendering_speed
 * e.g. ideogram_generate_V_3_TURBO → 'TURBO'
 */
function toIdeogramRenderSpeedFromModel(model: string): string | undefined {
  const match = model.match(/_(TURBO|DEFAULT|QUALITY|FLASH)$/i);
  return match ? match[1].toUpperCase() : undefined;
}

async function generateViaIdeogramEndpoint(
  params: FreedomImageParams,
  model: string,
  apiKey: string,
  baseUrl: string,
): Promise<GenerationResult> {
  // Ideogram 原生路径：/ideogram/v1/ideogram-v3/generate（不是 /v1/ideogram-v3/generate）
  const rootBase = getRootBaseUrl(baseUrl);
  const endpoint = `${rootBase}/ideogram/v1/ideogram-v3/generate`;
  const extra = params.extraParams || {};
  const form = new FormData();
  form.append('model', model);
  form.append('prompt', params.prompt);

  const aspect = toIdeogramAspectRatio(model, params.aspectRatio);
  if (aspect) form.append('aspect_ratio', aspect);

  // extraParams 优先；无则从 model 名后缀推断（e.g. ideogram_generate_V_3_TURBO）
  const speed = toIdeogramRenderSpeed(extra.render_speed || extra.rendering_speed)
    ?? toIdeogramRenderSpeedFromModel(model);
  if (speed) form.append('rendering_speed', speed);

  if (typeof extra.style === 'string') form.append('style_type', extra.style.toUpperCase());
  if (typeof params.negativePrompt === 'string' && params.negativePrompt.trim()) {
    form.append('negative_prompt', params.negativePrompt);
  }
  if (typeof extra.num_images === 'number') form.append('num_images', String(extra.num_images));

  const response = await corsFetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
    body: form,
  });

  if (!response.ok) {
    throw toHttpError('Ideogram generate failed', response.status, await response.text());
  }

  const data = await response.json();
  const imageUrl = extractImageUrl(data);
  if (!imageUrl) throw new Error('Ideogram 响应未包含图片 URL');
  const mediaId = saveToMediaLibrary(imageUrl, params.prompt, 'ai-image');
  return { url: imageUrl, mediaId };
}

/**
 * Generate image via Replicate's /replicate/v1/predictions endpoint
 * Request body: { model, input: { prompt, aspect_ratio, ... } }
 * Poll until status === 'succeeded' / 'failed' / 'canceled'
 */
async function generateViaReplicateImageEndpoint(
  params: FreedomImageParams,
  model: string,
  apiKey: string,
  baseUrl: string,
): Promise<GenerationResult> {
  const rootBase = getRootBaseUrl(baseUrl);
  const submitUrl = `${rootBase}/replicate/v1/predictions`;

  const input: Record<string, any> = { prompt: params.prompt };
  if (params.aspectRatio) input.aspect_ratio = params.aspectRatio;
  if (params.resolution) input.resolution = params.resolution;
  if (params.width) input.width = params.width;
  if (params.height) input.height = params.height;
  if (params.negativePrompt) input.negative_prompt = params.negativePrompt;
  if (params.extraParams) Object.assign(input, params.extraParams);

  const submitResp = await corsFetch(submitUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input }),
  });
  if (!submitResp.ok) {
    throw toHttpError('Replicate submit failed', submitResp.status, await submitResp.text());
  }

  const submitData = await submitResp.json();
  const directUrl = extractImageUrl(submitData);
  if (directUrl) {
    const mediaId = saveToMediaLibrary(directUrl, params.prompt, 'ai-image');
    return { url: directUrl, mediaId };
  }

  const predictionId = submitData.id;
  if (!predictionId) throw new Error('Replicate 返回空 prediction ID');

  const pollUrl = `${rootBase}/replicate/v1/predictions/${predictionId}`;
  for (let i = 0; i < IMAGE_POLL_MAX_ATTEMPTS; i++) {
    await new Promise(r => setTimeout(r, IMAGE_POLL_INTERVAL));
    const pollResp = await corsFetch(pollUrl, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (!pollResp.ok) continue;
    const pollData = await pollResp.json();
    const status = String(pollData.status || '').toLowerCase();
    if (status === 'succeeded') {
      const imageUrl = extractImageUrl(pollData);
      if (!imageUrl) throw new Error('Replicate 成功但未返回图片 URL');
      const mediaId = saveToMediaLibrary(imageUrl, params.prompt, 'ai-image');
      return { url: imageUrl, taskId: String(predictionId), mediaId };
    }
    if (status === 'failed' || status === 'canceled') {
      throw new Error(pollData.error || 'Replicate 图片生成失败');
    }
  }
  throw new Error('Replicate 图片生成超时');
}

// ==================== Video Generation ====================

export async function generateFreedomVideo(
  params: FreedomVideoParams
): Promise<GenerationResult> {
  const { config } = resolveFreedomFeatureConfig('freedom_video', 'video_generation', params.model);
  return freedomRetry(() => _generateFreedomVideoInner(params), 'Video generation', config?.keyManager);
}

async function _generateFreedomVideoInner(
  params: FreedomVideoParams
): Promise<GenerationResult> {
  const { config, source: configSource } = resolveFreedomFeatureConfig(
    'freedom_video',
    'video_generation',
    params.model,
  );
  if (!config) {
    const msg = getFeatureNotConfiguredMessage('video_generation');
    toast.error('自由板块视频生成未配置：请在设置中配置「自由板块-视频」或「视频生成」服务映射');
    throw new Error(msg);
  }
  console.log(`[Freedom] Video config source: ${configSource}`);

  const { baseUrl, model: defaultModel } = config;
  // 每次重试动态取当前 key（利用 keyManager rotate 后的新 key）
  const apiKey = config.keyManager?.getCurrentKey?.() || config.apiKey;
  // 模型 ID 直接透传：UI 选的就是供应商原始 ID，无需转换
  const model = (params.model || defaultModel || '').trim();
  if (!model) {
    const message = '自由板块视频生成未选择模型：请在设置的服务映射中为「自由板块-视频」或「视频生成」选择具体模型';
    toast.error(message);
    throw new Error(message);
  }
  if (isAgnesProvider(config.platform) && !isAgnesVideoModel(model)) {
    const message = '当前自由板块视频服务选择的是 Agnes AI，但所选模型不是 Agnes Video v2.0。请改用 agnes-video-v2.0，或选择其他支持视频生成的供应商。';
    toast.error(message);
    throw new Error(message);
  }

  const endpointTypes = useAPIConfigStore.getState().modelEndpointTypes[model];
  const route = detectFreedomVideoRoute(model, endpointTypes, config.platform);
  console.log('[Freedom] Generating video:', {
    model,
    route,
    endpointTypes,
    prompt: params.prompt.slice(0, 50),
  });

  let result: GenerationResult;
  switch (route) {
    case 'openai_official':
      result = await generateVideoViaOpenAIOfficial(params, model, apiKey, baseUrl);
      break;
    case 'agnes':
      result = await generateVideoViaAgnes(params, model, apiKey, baseUrl);
      break;
    case 'volc':
      result = await generateVideoViaVolc(params, model, apiKey, baseUrl, false);
      break;
    case 'volc_ark':
      result = await generateVideoViaVolc(params, model, apiKey, baseUrl, true);
      break;
    case 'wan':
      result = await generateVideoViaWan(params, model, apiKey, baseUrl);
      break;
    case 'kling':
      result = await generateVideoViaKling(params, model, apiKey, baseUrl);
      break;
    case 'replicate':
      result = await generateVideoViaReplicate(params, model, apiKey, baseUrl);
      break;
    default:
      result = await generateVideoViaUnified(params, model, apiKey, baseUrl);
      break;
  }

  const mediaId = saveToMediaLibrary(result.url, params.prompt, 'ai-video');
  return { ...result, mediaId };
}

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

function toSoraSize(aspectRatio?: string, resolution?: string): string {
  const isPortrait = aspectRatio === '9:16' || aspectRatio === '3:4';
  const is1080 = (resolution || '').toLowerCase().includes('1080');
  if (is1080) return isPortrait ? '1080x1920' : '1920x1080';
  return isPortrait ? '720x1280' : '1280x720';
}

function toVeoOpenAIVideoSize(aspectRatio?: string): string {
  const isPortrait = aspectRatio === '9:16' || aspectRatio === '3:4';
  return isPortrait ? '1080x1920' : '1920x1080';
}

function groupVideoUploadFiles(uploadFiles?: FreedomVideoUploadFile[]) {
  const grouped: {
    single?: FreedomVideoUploadFile;
    first?: FreedomVideoUploadFile;
    last?: FreedomVideoUploadFile;
    references: FreedomVideoUploadFile[];
  } = { references: [] };

  for (const file of uploadFiles || []) {
    if (file.role === 'single' && !grouped.single) grouped.single = file;
    if (file.role === 'first' && !grouped.first) grouped.first = file;
    if (file.role === 'last' && !grouped.last) grouped.last = file;
    if (file.role === 'reference') grouped.references.push(file);
  }

  return grouped;
}

function countVideoUploadFiles(grouped: ReturnType<typeof groupVideoUploadFiles>): number {
  return (
    (grouped.single ? 1 : 0) +
    (grouped.first ? 1 : 0) +
    (grouped.last ? 1 : 0) +
    grouped.references.length
  );
}

function validateVeoVideoUploads(
  model: string,
  endpointTypes: string[] | undefined,
  uploadFiles?: FreedomVideoUploadFile[],
): ReturnType<typeof groupVideoUploadFiles> {
  const capability = resolveVeoUploadCapability(model, endpointTypes);
  const grouped = groupVideoUploadFiles(uploadFiles);
  const total = countVideoUploadFiles(grouped);

  if (!capability.isVeo) return grouped;

  if (capability.mode === 'none') {
    if (total > 0) throw new Error(`模型 ${model} 不支持上传文件输入`);
    return grouped;
  }

  if (capability.mode === 'single') {
    const file = grouped.single || grouped.first;
    if (capability.minFiles > 0 && !file) {
      throw new Error(`模型 ${model} 需要上传 1 张图片`);
    }
    if (grouped.references.length > 0 || !!grouped.last || (!!grouped.single && !!grouped.first)) {
      throw new Error(`模型 ${model} 仅支持 1 张图片输入`);
    }
    return grouped;
  }

  if (capability.mode === 'first_last') {
    if (grouped.references.length > 0 || !!grouped.single) {
      throw new Error(`模型 ${model} 仅支持首帧/尾帧输入`);
    }
    if (capability.minFiles > 0 && !grouped.first) {
      throw new Error(`模型 ${model} 需要上传首帧图片`);
    }
    if (!grouped.first && grouped.last) {
      throw new Error(`模型 ${model} 仅上传尾帧无效，请先上传首帧`);
    }
    if (total > capability.maxFiles) {
      throw new Error(`模型 ${model} 最多支持 2 张图片（首帧/尾帧）`);
    }
    return grouped;
  }

  if (capability.mode === 'multi') {
    if (!!grouped.single || !!grouped.first || !!grouped.last) {
      throw new Error(`模型 ${model} 仅支持多参考图输入`);
    }
    if (grouped.references.length < capability.minFiles) {
      throw new Error(`模型 ${model} 至少需要上传 1 张参考图`);
    }
    if (grouped.references.length > capability.maxFiles) {
      throw new Error(`模型 ${model} 最多支持 ${capability.maxFiles} 张参考图`);
    }
    return grouped;
  }

  return grouped;
}

async function toUploadHttpUrl(file: FreedomVideoUploadFile): Promise<string> {
  if (/^https?:\/\//i.test(file.dataUrl)) return file.dataUrl;
  try {
    return await uploadBase64Image(file.dataUrl);
  } catch (error) {
    console.error('[Freedom] Video reference image upload failed', {
      role: file.role,
      fileName: file.fileName,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function dataUrlToBlob(dataUrl: string, mimeHint?: string): Blob {
  const match = dataUrl.match(/^data:(.*?);base64,(.*)$/);
  if (!match) throw new Error('上传文件格式无效，必须是 data URL 或 http(s) URL');
  const mime = match[1] || mimeHint || 'image/png';
  const b64 = match[2];
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: mime });
}

async function toUploadBlob(file: FreedomVideoUploadFile): Promise<Blob> {
  if (/^https?:\/\//i.test(file.dataUrl)) {
    return mediaUrlToBlob(file.dataUrl);
  }
  return dataUrlToBlob(file.dataUrl, file.mimeType);
}

async function appendVeoMultipartReferences(
  form: FormData,
  model: string,
  endpointTypes: string[] | undefined,
  uploadFiles?: FreedomVideoUploadFile[],
) {
  const capability = resolveVeoUploadCapability(model, endpointTypes);
  if (!capability.isVeo) return;

  const grouped = validateVeoVideoUploads(model, endpointTypes, uploadFiles);
  const ordered: FreedomVideoUploadFile[] = [];

  if (capability.mode === 'single') {
    const single = grouped.single || grouped.first;
    if (single) ordered.push(single);
  } else if (capability.mode === 'first_last') {
    if (grouped.first) ordered.push(grouped.first);
    if (grouped.last) ordered.push(grouped.last);
  } else if (capability.mode === 'multi') {
    ordered.push(...grouped.references.slice(0, capability.maxFiles));
  }

  for (let i = 0; i < ordered.length; i++) {
    const file = ordered[i];
    const blob = await toUploadBlob(file);
    const fileName = file.fileName || `veo-reference-${i + 1}.png`;
    form.append('input_reference', blob, fileName);
  }
}

async function buildVeoUnifiedVideoBody(
  params: FreedomVideoParams,
  model: string,
  endpointTypes: string[] | undefined,
): Promise<Record<string, any>> {
  const capability = resolveVeoUploadCapability(model, endpointTypes);
  const grouped = validateVeoVideoUploads(model, endpointTypes, params.uploadFiles);
  const body: Record<string, any> = {
    model,
    prompt: params.prompt,
  };
  const metadata: Record<string, any> = {};

  if (params.duration) body.duration = params.duration;
  if (params.aspectRatio) metadata.aspectRatio = params.aspectRatio;
  if (params.resolution) metadata.resolution = params.resolution.toLowerCase();

  if (capability.mode === 'single') {
    const single = grouped.single || grouped.first;
    if (single) body.image = await toUploadHttpUrl(single);
  } else if (capability.mode === 'first_last') {
    if (grouped.first) body.image = await toUploadHttpUrl(grouped.first);
    if (grouped.last) {
      metadata.lastFrame = { url: await toUploadHttpUrl(grouped.last) };
    }
  } else if (capability.mode === 'multi') {
    const refs = grouped.references.slice(0, capability.maxFiles);
    metadata.referenceImages = await Promise.all(
      refs.map(async (f) => ({ url: await toUploadHttpUrl(f) })),
    );
  }

  if (Object.keys(metadata).length > 0) body.metadata = metadata;
  return body;
}

async function generateVideoViaOpenAIOfficial(
  params: FreedomVideoParams,
  model: string,
  apiKey: string,
  baseUrl: string,
): Promise<GenerationResult> {
  const endpoint = buildEndpoint(baseUrl, 'videos');
  const endpointTypes = useAPIConfigStore.getState().modelEndpointTypes[model];
  const isVeo = isVeoModel(model);
  const form = new FormData();
  form.append('model', model);
  form.append('prompt', params.prompt);
  form.append('size', isVeo ? toVeoOpenAIVideoSize(params.aspectRatio) : toSoraSize(params.aspectRatio, params.resolution));
  form.append('seconds', String(params.duration || (isVeo ? 8 : 10)));
  if (isVeo) {
    await appendVeoMultipartReferences(form, model, endpointTypes, params.uploadFiles);
  }

  const submitResp = await corsFetch(endpoint, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: form,
  });
  if (!submitResp.ok) {
    throw toHttpError('Sora submit failed', submitResp.status, await submitResp.text());
  }

  const submitData = await submitResp.json();
  const taskId = submitData.id || submitData.video_id;
  const directUrl = extractVideoUrl(submitData);
  if (directUrl) return { url: directUrl, taskId: taskId ? String(taskId) : undefined };
  if (!taskId) throw new Error('Sora 返回空任务 ID');

  const pollUrl = buildEndpoint(baseUrl, `videos/${taskId}`);
  for (let i = 0; i < VIDEO_POLL_MAX_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, VIDEO_POLL_INTERVAL));
    const pollResp = await corsFetch(pollUrl, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (!pollResp.ok) continue;
    const pollData = await pollResp.json();
    const status = String(pollData.status || '').toLowerCase();
    if (status === 'completed' || status === 'succeeded' || status === 'success') {
      const videoUrl = extractVideoUrl(pollData) || buildEndpoint(baseUrl, `videos/${taskId}/content`);
      return { url: videoUrl, taskId: String(taskId) };
    }
    if (status === 'failed' || status === 'error') {
      throw new Error(pollData.error?.message || pollData.error || pollData.message || 'Sora 生成失败');
    }
  }

  throw new Error('Sora 生成超时');
}

function getAgnesVideoTaskId(data: any): string | undefined {
  return (
    data.task_id ||
    data.id ||
    data.video_id ||
    data.data?.task_id ||
    data.data?.id ||
    data.response?.task_id ||
    data.response?.id ||
    data.result?.task_id ||
    data.result?.id
  )?.toString();
}

function assertFreedomAgnesVideoInputsSupported(grouped: ReturnType<typeof groupVideoUploadFiles>): void {
  const unsupported: string[] = [];
  if (grouped.last) unsupported.push('尾帧图');
  if (grouped.references.length > 0) unsupported.push('参考图');
  if (grouped.single && grouped.first) unsupported.push('同时上传单图和首帧图');
  if (unsupported.length === 0) return;
  throw new Error(`${AGNES_VIDEO_LAST_FRAME_UNSUPPORTED_MESSAGE} 当前请求包含不支持的内容：${unsupported.join('、')}。`);
}

async function generateVideoViaAgnes(
  params: FreedomVideoParams,
  model: string,
  apiKey: string,
  baseUrl: string,
): Promise<GenerationResult> {
  const grouped = groupVideoUploadFiles(params.uploadFiles);
  assertFreedomAgnesVideoInputsSupported(grouped);
  const primaryFile = grouped.single || grouped.first;
  const body: Record<string, any> = {
    model,
    prompt: params.prompt,
  };
  if (primaryFile) body.image = await toUploadHttpUrl(primaryFile);
  if (params.duration) body.duration = params.duration;
  if (params.aspectRatio) body.aspect_ratio = params.aspectRatio;
  if (params.resolution) body.resolution = params.resolution.toLowerCase();

  const submitResp = await corsFetch(buildEndpoint(baseUrl, 'videos'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!submitResp.ok) {
    throw toHttpError('Agnes video submit failed', submitResp.status, await submitResp.text());
  }

  const submitData = await submitResp.json();
  const directUrl = extractVideoUrl(submitData);
  const taskId = getAgnesVideoTaskId(submitData);
  if (directUrl) return { url: directUrl, taskId };
  if (!taskId) throw new Error('Agnes 视频接口返回空任务 ID');

  const pollUrl = buildEndpoint(baseUrl, `videos/${taskId}`);
  for (let i = 0; i < VIDEO_POLL_MAX_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, VIDEO_POLL_INTERVAL));
    const pollResp = await corsFetch(pollUrl, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (!pollResp.ok) continue;
    const pollData = await pollResp.json();
    const status = String(pollData.status || pollData.state || pollData.data?.status || '').toLowerCase();
    if (status === 'completed' || status === 'succeeded' || status === 'success') {
      const videoUrl =
        normalizeVideoUrl(extractVideoUrl(pollData)) ||
        normalizeVideoUrl(pollData.content?.video_url) ||
        normalizeVideoUrl(pollData.output?.video_url) ||
        normalizeVideoUrl(pollData.output?.url) ||
        normalizeVideoUrl(pollData.data?.video_url) ||
        normalizeVideoUrl(pollData.data?.url) ||
        buildEndpoint(baseUrl, `videos/${taskId}/content`);
      return { url: videoUrl, taskId };
    }
    if (status === 'failed' || status === 'error' || status === 'cancelled' || status === 'canceled') {
      throw new Error(pollData.error?.message || pollData.error || pollData.message || 'Agnes 视频生成失败');
    }
  }

  throw new Error('Agnes 视频生成超时');
}

async function generateVideoViaUnified(
  params: FreedomVideoParams,
  model: string,
  apiKey: string,
  baseUrl: string,
): Promise<GenerationResult> {
  const endpointTypes = useAPIConfigStore.getState().modelEndpointTypes[model];

  let body: Record<string, any>;
  if (isVeoModel(model)) {
    body = await buildVeoUnifiedVideoBody(params, model, endpointTypes);
  } else {
    const isLuma = (endpointTypes || []).some(t => /luma/i.test(t));
    const isRunway = (endpointTypes || []).some(t => /runway/i.test(t));
    const isGrok = (endpointTypes || []).some(t => /grok/i.test(t)) || /grok/i.test(model);

    body = { model, prompt: params.prompt };
    const metadata: Record<string, any> = {};

    // Duration: Luma requires string with unit ("5s"), other models use number
    if (params.duration) {
      body.duration = isLuma ? `${params.duration}s` : params.duration;
    }

    // AspectRatio 处理策略（各模型格式不同，按模型分别处理）：
    // - Runway: metadata.ratio（像素格式 1280:720）
    // - Grok: 顶层 aspect_ratio（xAI 官方格式，支持 16:9/9:16/4:3/3:4/3:2/2:3/1:1）
    // - 其他统一格式模型: metadata.aspect_ratio
    if (params.aspectRatio) {
      if (isRunway) {
        metadata.ratio = toRunwayRatio(params.aspectRatio);
      } else if (isGrok) {
        body.aspect_ratio = params.aspectRatio;
      } else {
        metadata.aspect_ratio = params.aspectRatio;
      }
    }

    // Resolution: Grok uses top-level "720p"/"480p"; others via metadata
    if (params.resolution) {
      if (isRunway) {
        // Runway doesn't use resolution field
      } else if (isGrok) {
        body.resolution = params.resolution;
      } else {
        metadata.resolution = params.resolution;
      }
    }

    // Image inputs (wan2.6, doubao, luma, vidu, minimax, runway, etc.)
    const grouped = groupVideoUploadFiles(params.uploadFiles);
    if (grouped.single || grouped.first) {
      body.image = await toUploadHttpUrl((grouped.single || grouped.first)!);
    }
    if (grouped.last) {
      metadata.image_end = await toUploadHttpUrl(grouped.last);
    }
    // Reference images: vidu参考生视频 and similar models
    if (grouped.references.length > 0) {
      metadata.reference_images = await Promise.all(
        grouped.references.map(async (f) => ({ url: await toUploadHttpUrl(f) }))
      );
    }

    if (Object.keys(metadata).length > 0) body.metadata = metadata;
  }

  // 直接使用端点类型对应的 URL（绝对路径，从域名根拼接）
  const endpointPaths = getUnifiedEndpointPaths(endpointTypes || []);
  const rootBase = getRootBaseUrl(baseUrl);
  const submitUrl = `${rootBase}${endpointPaths.submit}`;

  const resp = await corsFetch(submitUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw toHttpError('Unified video submit failed', resp.status, text);
  }
  const submitData = await resp.json();

  const taskId =
    submitData.task_id ||
    submitData.id ||
    submitData.request_id ||
    submitData.data?.task_id ||
    submitData.data?.id ||
    submitData.response?.task_id ||
    submitData.response?.id ||
    submitData.result?.task_id ||
    submitData.result?.id ||
    submitData.output?.task_id ||
    submitData.output?.id;
  const directUrl = extractVideoUrl(submitData);
  if (directUrl) return { url: directUrl, taskId: taskId ? String(taskId) : undefined };
  if (!taskId) throw new Error('统一视频接口返回空任务 ID');

  // 轮询：直接使用端点类型对应的 URL
  const pollUrl = `${rootBase}${endpointPaths.poll(String(taskId))}`;

  for (let i = 0; i < VIDEO_POLL_MAX_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, VIDEO_POLL_INTERVAL));
    const pollResp = await corsFetch(pollUrl, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (!pollResp.ok) continue;
    const pollData = await pollResp.json();
    const status = String(pollData.status || pollData.state || pollData.data?.status || '').toLowerCase();
    if (status === 'completed' || status === 'succeeded' || status === 'success') {
      const videoUrl = extractVideoUrl(pollData);
      if (videoUrl) return { url: videoUrl, taskId: String(taskId) };
    }
    if (status === 'failed' || status === 'error' || status === 'cancelled') {
      throw new Error(pollData.error?.message || pollData.error || pollData.message || '视频生成失败');
    }
  }

  throw new Error('视频生成超时');
}

async function generateVideoViaVolc(
  params: FreedomVideoParams,
  model: string,
  apiKey: string,
  baseUrl: string,
  officialArk: boolean,
): Promise<GenerationResult> {
  const taskUrls = buildVolcVideoTaskUrls(baseUrl, officialArk);
  const promptParts = [params.prompt];
  if (!officialArk) {
    if (params.resolution) promptParts.push(`--rs ${params.resolution.toLowerCase()}`);
    if (params.aspectRatio) promptParts.push(`--rt ${params.aspectRatio}`);
    if (params.duration) promptParts.push(`--dur ${params.duration}`);
  }

  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: promptParts.join(' ') },
  ];

  // 附加上传图片：首帧 / 可选尾帧 / 产品参考图。
  // Seedance 2.0 总图片上限按 9 张控制，调用方可进一步限制输入数量。
  const grouped = groupVideoUploadFiles(params.uploadFiles);
  const primaryFile = grouped.single || grouped.first;
  if (primaryFile) {
    const url = await toUploadHttpUrl(primaryFile);
    content.push({ type: 'image_url', image_url: { url }, role: 'first_frame' });
  }
  if (grouped.last) {
    const url = await toUploadHttpUrl(grouped.last);
    content.push({ type: 'image_url', image_url: { url }, role: 'last_frame' });
  }
  const remainingImageSlots = Math.max(0, 9 - content.filter((item) => item.type === 'image_url').length);
  for (const reference of grouped.references.slice(0, remainingImageSlots)) {
    const url = await toUploadHttpUrl(reference);
    content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' });
  }

  const body = officialArk
    ? {
        model,
        content,
        ...(params.duration ? { duration: params.duration } : {}),
        generate_audio: false,
        ...(params.aspectRatio ? { ratio: params.aspectRatio } : {}),
      }
    : { model, content };

  console.log(`[Freedom] Volc video route → POST ${taskUrls.routeLabel}`, {
    model,
    officialArk,
    duration: params.duration,
    ratio: params.aspectRatio,
    imageCount: content.filter((item) => item.type === 'image_url').length,
    imageRoles: content
      .filter((item) => item.type === 'image_url')
      .map((item) => item.role),
  });

  const submitResp = await corsFetch(taskUrls.submit, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!submitResp.ok) {
    throw toHttpError('Volc submit failed', submitResp.status, await submitResp.text());
  }

  const submitData = await submitResp.json();
  const taskId = submitData.id || submitData.task_id || submitData.data?.id || submitData.data?.task_id;
  if (!taskId) throw new Error('Volc 返回空任务 ID');

  const pollUrl = taskUrls.poll(String(taskId));
  let lastPollDetail = '';
  let lastTaskStatus = '';
  for (let i = 0; i < VIDEO_POLL_MAX_ATTEMPTS; i++) {
    const attempt = i + 1;
    await new Promise((r) => setTimeout(r, VIDEO_POLL_INTERVAL));

    let pollResp: Response;
    try {
      pollResp = await corsFetch(pollUrl, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
    } catch (error) {
      lastPollDetail = `第 ${attempt}/${VIDEO_POLL_MAX_ATTEMPTS} 次查询网络错误：${error instanceof Error ? error.message : String(error)}`;
      console.warn('[Freedom] Volc video poll request failed', {
        taskId,
        attempt,
        maxAttempts: VIDEO_POLL_MAX_ATTEMPTS,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (!pollResp.ok) {
      const text = await pollResp.text().catch(() => '');
      lastPollDetail = `第 ${attempt}/${VIDEO_POLL_MAX_ATTEMPTS} 次查询 HTTP ${pollResp.status}${text ? `：${previewJson(text)}` : ''}`;
      console.warn('[Freedom] Volc video poll HTTP failed', {
        taskId,
        attempt,
        maxAttempts: VIDEO_POLL_MAX_ATTEMPTS,
        status: pollResp.status,
        body: previewJson(text),
      });
      continue;
    }

    let pollData: any;
    try {
      pollData = await pollResp.json();
    } catch (error) {
      lastPollDetail = `第 ${attempt}/${VIDEO_POLL_MAX_ATTEMPTS} 次查询响应 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`;
      console.warn('[Freedom] Volc video poll JSON parse failed', {
        taskId,
        attempt,
        maxAttempts: VIDEO_POLL_MAX_ATTEMPTS,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const status = getVolcTaskStatus(pollData);
    lastTaskStatus = status || 'unknown';
    if (attempt === 1 || attempt % 10 === 0) {
      console.log('[Freedom] Volc video poll status', {
        taskId,
        attempt,
        maxAttempts: VIDEO_POLL_MAX_ATTEMPTS,
        status: lastTaskStatus,
      });
    }

    if (status === 'succeeded' || status === 'completed' || status === 'success') {
      const videoUrl =
        normalizeVideoUrl(pollData.content?.video_url) ||
        normalizeVideoUrl(pollData.content) ||
        normalizeVideoUrl(pollData.outputs) ||
        normalizeVideoUrl(pollData.output?.video_url) ||
        normalizeVideoUrl(pollData.output?.url) ||
        normalizeVideoUrl(pollData.data?.video_url) ||
        normalizeVideoUrl(pollData.data?.output) ||
        normalizeVideoUrl(extractVideoUrl(pollData));
      if (!videoUrl) throw new Error(`Volc 成功但无视频 URL：${previewJson(pollData)}`);
      return { url: videoUrl, taskId: String(taskId) };
    }
    if (status === 'failed' || status === 'expired' || status === 'cancelled' || status === 'error') {
      throw new Error(getVolcTaskErrorMessage(pollData));
    }
  }

  const waitedSeconds = Math.round((VIDEO_POLL_INTERVAL * VIDEO_POLL_MAX_ATTEMPTS) / 1000);
  const lastDetail = lastPollDetail || (lastTaskStatus ? `最后业务状态：${lastTaskStatus}` : '未获取到有效查询状态');
  throw new Error(`Volc 视频生成超时（已等待约 ${waitedSeconds}s，taskId: ${taskId}；${lastDetail}）`);
}

async function generateVideoViaWan(
  params: FreedomVideoParams,
  model: string,
  apiKey: string,
  baseUrl: string,
): Promise<GenerationResult> {
  const rootBase = getRootBaseUrl(baseUrl);
  const body: Record<string, any> = {
    model,
    input: { prompt: params.prompt },
    parameters: {
      resolution: (params.resolution || '720P').toUpperCase(),
      prompt_extend: true,
      audio: true,
    },
  };
  if (params.duration) body.parameters.duration = Math.max(3, params.duration);

  const submitResp = await corsFetch(
    `${rootBase}/alibailian/api/v1/services/aigc/video-generation/video-synthesis`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    },
  );
  if (!submitResp.ok) {
    throw toHttpError('Wan submit failed', submitResp.status, await submitResp.text());
  }

  const submitData = await submitResp.json();
  const taskId = submitData.output?.task_id;
  if (!taskId) throw new Error('Wan 返回空任务 ID');

  const pollUrl = `${rootBase}/alibailian/api/v1/tasks/${taskId}`;
  for (let i = 0; i < VIDEO_POLL_MAX_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, VIDEO_POLL_INTERVAL));
    const pollResp = await corsFetch(pollUrl, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (!pollResp.ok) continue;
    const pollData = await pollResp.json();
    const status = String(pollData.output?.task_status || '').toUpperCase();
    if (status === 'SUCCEEDED' || status === 'COMPLETED') {
      const videoUrl = pollData.output?.video_url || extractVideoUrl(pollData);
      if (!videoUrl) throw new Error('Wan 成功但无视频 URL');
      return { url: videoUrl, taskId: String(taskId) };
    }
    if (status === 'FAILED' || status === 'ERROR' || status === 'CANCELLED') {
      throw new Error(pollData.output?.message || pollData.output?.error || 'Wan 视频生成失败');
    }
  }

  throw new Error('Wan 视频生成超时');
}

// Native Kling endpoint paths (relative to /kling/v1/videos/)
// kling-video is handled dynamically: text2video vs image2video based on uploads
const KLING_VIDEO_PATH_MAP: Record<string, string> = {
  'kling-omni-video': 'omni-video',
  'kling-video-extend': 'video-extend',
  'kling-motion-control': 'motion-control',
  'kling-multi-elements': 'multi-elements',
  'kling-avatar-image2video': 'avatar/image2video',
  'kling-advanced-lip-sync': 'advanced-lip-sync',
  'kling-effects': 'effects',
};

async function generateVideoViaKling(
  params: FreedomVideoParams,
  model: string,
  apiKey: string,
  baseUrl: string,
): Promise<GenerationResult> {
  const rootBase = getRootBaseUrl(baseUrl);
  const uploads = params.uploadFiles || [];
  const firstFrame = uploads.find((f) => f.role === 'single' || f.role === 'first');
  const lastFrame = uploads.find((f) => f.role === 'last');

  // Determine the endpoint path
  // Specialized models have a fixed path; all kling-video variants (kling-v2-1-master,
  // kling-v2-6-pro, kling-v3-0-pro, etc.) fall through to text2video / image2video.
  let endpointPath: string;
  const specialPath = KLING_VIDEO_PATH_MAP[model];
  if (specialPath) {
    endpointPath = specialPath;
  } else {
    endpointPath = firstFrame ? 'image2video' : 'text2video';
  }

  const body: Record<string, any> = {
    model_name: resolveKlingModelName(model),
    prompt: params.prompt,
    aspect_ratio: params.aspectRatio || '16:9',
    duration: String(params.duration ? Math.min(10, Math.max(5, params.duration)) : 5),
    mode: 'std',
  };

  // Attach image URLs for image-based endpoints
  if (endpointPath === 'image2video' && firstFrame) {
    body.image_url = await toUploadHttpUrl(firstFrame);
    if (lastFrame) body.tail_image_url = await toUploadHttpUrl(lastFrame);
  } else if (endpointPath === 'avatar/image2video' && firstFrame) {
    body.image_url = await toUploadHttpUrl(firstFrame);
  }

  const submitUrl = `${rootBase}/kling/v1/videos/${endpointPath}`;
  const submitResp = await corsFetch(submitUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!submitResp.ok) {
    throw toHttpError('Kling submit failed', submitResp.status, await submitResp.text());
  }

  const submitData = await submitResp.json();
  const taskId = submitData.data?.task_id;
  if (!taskId) throw new Error('Kling 返回空任务 ID');

  // Poll URL mirrors the submit path: GET /kling/v1/videos/{path}/{task_id}
  const pollUrl = `${rootBase}/kling/v1/videos/${endpointPath}/${taskId}`;
  for (let i = 0; i < VIDEO_POLL_MAX_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, VIDEO_POLL_INTERVAL));
    const pollResp = await corsFetch(pollUrl, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (!pollResp.ok) continue;
    const pollData = await pollResp.json();
    const status = String(pollData.data?.task_status || '').toLowerCase();
    if (status === 'succeed' || status === 'success' || status === 'completed') {
      const videoUrl =
        pollData.data?.task_result?.videos?.[0]?.url ||
        pollData.data?.task_result?.video_url ||
        extractVideoUrl(pollData);
      if (!videoUrl) throw new Error('Kling 成功但无视频 URL');
      return { url: videoUrl, taskId: String(taskId) };
    }
    if (status === 'failed' || status === 'error') {
      throw new Error(pollData.data?.task_status_msg || pollData.message || 'Kling 视频生成失败');
    }
  }

  throw new Error('Kling 视频生成超时');
}

/**
 * Generate video via Replicate's /replicate/v1/predictions endpoint
 * Request body: { model, input: { prompt, aspect_ratio, ... } }
 * Poll until status === 'succeeded' / 'failed' / 'canceled'
 */
async function generateVideoViaReplicate(
  params: FreedomVideoParams,
  model: string,
  apiKey: string,
  baseUrl: string,
): Promise<GenerationResult> {
  const rootBase = getRootBaseUrl(baseUrl);
  const submitUrl = `${rootBase}/replicate/v1/predictions`;

  const input: Record<string, any> = { prompt: params.prompt };
  if (params.aspectRatio) input.aspect_ratio = params.aspectRatio;
  if (params.duration) input.duration = params.duration;
  if (params.resolution) input.resolution = params.resolution;

  // Image-to-video: attach upload files inside input
  const grouped = groupVideoUploadFiles(params.uploadFiles);
  const primaryFile = grouped.single || grouped.first;
  if (primaryFile) input.image = await toUploadHttpUrl(primaryFile);
  if (grouped.last) input.tail_image = await toUploadHttpUrl(grouped.last);

  const submitResp = await corsFetch(submitUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input }),
  });
  if (!submitResp.ok) {
    throw toHttpError('Replicate video submit failed', submitResp.status, await submitResp.text());
  }

  const submitData = await submitResp.json();
  const directUrl = extractVideoUrl(submitData);
  if (directUrl) return { url: directUrl };

  const predictionId = submitData.id;
  if (!predictionId) throw new Error('Replicate 返回空 prediction ID');

  const pollUrl = `${rootBase}/replicate/v1/predictions/${predictionId}`;
  for (let i = 0; i < VIDEO_POLL_MAX_ATTEMPTS; i++) {
    await new Promise(r => setTimeout(r, VIDEO_POLL_INTERVAL));
    const pollResp = await corsFetch(pollUrl, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (!pollResp.ok) continue;
    const pollData = await pollResp.json();
    const status = String(pollData.status || '').toLowerCase();
    if (status === 'succeeded') {
      const videoUrl = extractVideoUrl(pollData);
      if (!videoUrl) throw new Error('Replicate 成功但未返回视频 URL');
      return { url: videoUrl, taskId: String(predictionId) };
    }
    if (status === 'failed' || status === 'canceled') {
      throw new Error(pollData.error || 'Replicate 视频生成失败');
    }
  }
  throw new Error('Replicate 视频生成超时');
}

// ==================== Helpers ====================

function extractImageUrl(data: any): string | null {
  // Handle multiple response formats
  if (data.data?.[0]?.url) return data.data[0].url;
  if (data.data?.[0]?.b64_json) return `data:image/png;base64,${data.data[0].b64_json}`;
  if (data.url) return data.url;
  if (data.output?.url) return data.output.url;
  // Replicate: output as direct string URL or array of URLs
  if (typeof data.output === 'string' && data.output.startsWith('http')) return data.output;
  if (Array.isArray(data.output) && typeof data.output[0] === 'string') return data.output[0];
  if (data.outputs?.[0]) return data.outputs[0];
  // Chat completions format
  if (data.choices?.[0]?.message?.content) {
    const content = data.choices[0].message.content;
    const mdMatch = content.match(/!\[.*?\]\((https?:\/\/[^)]+)\)/);
    if (mdMatch) return mdMatch[1];
    if (content.startsWith('http')) return content.trim();
  }
  return null;
}

function extractVideoUrl(data: any): string | null {
  if (data.data?.[0]?.url) return data.data[0].url;
  if (data.url) return data.url;
  if (data.output?.url) return data.output.url;
  // Replicate: output as direct string URL or array of URLs (minimax/video-01, etc.)
  if (typeof data.output === 'string' && data.output.startsWith('http')) return data.output;
  if (Array.isArray(data.output) && typeof data.output[0] === 'string') return data.output[0];
  if (data.outputs?.[0]) return data.outputs[0];
  if (data.video_url) return data.video_url;
  if (typeof data.remixed_from_video_id === 'string' && data.remixed_from_video_id.startsWith('http')) return data.remixed_from_video_id;
  if (data.response?.url) return data.response.url;  // doubao, jimeng, grok, wan2.6
  return null;
}

async function pollForResult(
  pollUrl: string,
  apiKey: string,
  interval: number,
  maxAttempts: number
): Promise<string | null> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, interval));

    try {
      const response = await corsFetch(pollUrl, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });

      if (!response.ok) continue;

      const data = await response.json();
      const status = (data.status || data.state || '').toLowerCase();

      // Check completion - triple status normalization from Higgsfield
      if (status === 'completed' || status === 'succeeded' || status === 'success') {
        return extractImageUrl(data) || extractVideoUrl(data);
      }

      // Check failure
      if (status === 'failed' || status === 'error' || status === 'cancelled') {
        throw new Error(`Generation failed: ${data.error || data.message || status}`);
      }

      // Still processing
      console.log(`[Freedom] Polling attempt ${i + 1}/${maxAttempts}, status: ${status}`);
    } catch (err: any) {
      if (err.message?.startsWith('Generation failed')) throw err;
      console.warn(`[Freedom] Poll error (attempt ${i + 1}):`, err.message);
    }
  }

  return null;
}

function saveToMediaLibrary(
  url: string,
  prompt: string,
  source: 'ai-image' | 'ai-video'
): string | undefined {
  try {
    const mediaStore = useMediaStore.getState();
    const projectId = useProjectStore.getState().activeProjectId;
    const name = prompt.slice(0, 30).replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_') || 'freedom';
    const type = source === 'ai-image' ? 'image' : 'video';
    
    const mediaId = mediaStore.addMediaFromUrl({
      url,
      name: `${name}_${Date.now()}`,
      type: type as any,
      source,
      projectId: projectId || undefined,
    });

    return mediaId;
  } catch (err) {
    console.warn('[Freedom] Failed to save to media library:', err);
    return undefined;
  }
}
