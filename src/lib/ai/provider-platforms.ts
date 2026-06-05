// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.

import type { IProvider, ModelApiFormat, ModelCapability } from '@/lib/api-key-manager';

export const CHUNFENG_PLATFORM = 'chunfeng';
export const CHUNFENG_NAME = '春风';
export const CHUNFENG_BASE_URL = 'https://chunfeng.mentalout.top/v1';

export const AUTO_VIP_PLATFORM = 'auto-vip';
export const AUTO_VIP_NAME = 'auto-vip';
export const AUTO_VIP_BASE_URL = 'https://vip.auto-code.net/v1';

export const AGNES_PLATFORM = 'agnes-ai';
export const AGNES_NAME = 'Agnes AI';
export const AGNES_BASE_URL = 'https://apihub.agnes-ai.com/v1';
export const AGNES_TEXT_MODELS = ['agnes-2.0-flash', 'agnes-1.5-flash'] as const;
export const AGNES_IMAGE_MODELS = ['agnes-image-2.1-flash', 'agnes-image-2.0-flash'] as const;
export const AGNES_VIDEO_MODEL = 'agnes-video-v2.0';
export const AGNES_VIDEO_LAST_FRAME_UNSUPPORTED_MESSAGE =
  'Agnes Video v2.0 目前只接入提示词、首帧图、时长、画幅和清晰度，不支持尾帧或其他扩展输入；请移除不支持的内容，或在服务映射中选择支持这些输入的视频模型。';
export const AGNES_DEFAULT_MODELS = [
  ...AGNES_TEXT_MODELS,
  ...AGNES_IMAGE_MODELS,
  AGNES_VIDEO_MODEL,
] as const;

export const LEGACY_AGGREGATOR_PLATFORM = 'aggregator';

export function isChunfengPlatform(platform?: string): boolean {
  return platform === CHUNFENG_PLATFORM;
}

export function isAutoVipPlatform(platform?: string): boolean {
  return platform === AUTO_VIP_PLATFORM || platform === LEGACY_AGGREGATOR_PLATFORM;
}

export function isAgnesPlatform(platform?: string | null): boolean {
  return platform === AGNES_PLATFORM;
}

export function isChunfengProvider(platform?: string): boolean {
  return isChunfengPlatform(platform);
}

export function isAutoVipProvider(platform?: string): boolean {
  return isAutoVipPlatform(platform);
}

export function isAgnesProvider(platform?: string | null): boolean {
  return isAgnesPlatform(platform);
}

export function isFixedBaseUrlProviderPlatform(platform?: string): boolean {
  return isChunfengPlatform(platform) || platform === AUTO_VIP_PLATFORM || isAgnesPlatform(platform);
}

export function isPricingMetadataProviderPlatform(platform?: string): boolean {
  return isAutoVipPlatform(platform);
}

export function isAgnesTextModel(model?: string | null): boolean {
  if (!model) return false;
  const name = model.trim().toLowerCase();
  return (AGNES_TEXT_MODELS as readonly string[]).includes(name);
}

export function isAgnesImageModel(model?: string | null): boolean {
  if (!model) return false;
  const name = model.trim().toLowerCase();
  return (AGNES_IMAGE_MODELS as readonly string[]).includes(name);
}

export function isAgnesVideoModel(model?: string | null): boolean {
  if (!model) return false;
  return model.trim().toLowerCase() === AGNES_VIDEO_MODEL;
}

export function normalizeAgnesModelList(models?: readonly string[] | null): string[] {
  const incoming = (models || []).map((model) => model.trim()).filter(Boolean);
  if (incoming.length === 0) return [...AGNES_DEFAULT_MODELS];

  const incomingSet = new Set(incoming);
  const orderedKnown = AGNES_DEFAULT_MODELS.filter((model) => incomingSet.has(model));
  const knownSet = new Set<string>(AGNES_DEFAULT_MODELS);
  const extras = incoming.filter((model) => !knownSet.has(model));

  return orderedKnown.length > 0 ? [...orderedKnown, ...extras] : incoming;
}

export function getAgnesModelCapabilities(model?: string | null): ModelCapability[] {
  if (isAgnesTextModel(model)) return ['text'];
  if (isAgnesImageModel(model)) return ['image_generation'];
  if (isAgnesVideoModel(model)) return ['video_generation'];
  return [];
}

export function buildAgnesModelMetadata(models: readonly string[] = AGNES_DEFAULT_MODELS) {
  const modelEndpointTypes: Record<string, string[]> = {};
  const modelTypes: Record<string, string> = {};
  const modelTags: Record<string, string[]> = {};

  for (const model of models) {
    if (!model) continue;
    const capabilities = getAgnesModelCapabilities(model);
    if (capabilities.includes('image_generation')) {
      modelEndpointTypes[model] = ['image-generation'];
      modelTypes[model] = '图像';
      modelTags[model] = ['图片生成', 'Agnes'];
      continue;
    }
    if (capabilities.includes('video_generation')) {
      modelEndpointTypes[model] = ['agnes-video'];
      modelTypes[model] = '音视频';
      modelTags[model] = ['视频', 'Agnes'];
      continue;
    }
    if (!capabilities.includes('text')) continue;
    modelEndpointTypes[model] = ['openai'];
    modelTypes[model] = '文本';
    modelTags[model] = ['对话', 'Agnes'];
  }

  return { modelEndpointTypes, modelTypes, modelTags };
}

export function isImage2ModelName(model?: string): boolean {
  if (!model) return false;
  const name = model.trim().toLowerCase();
  return (
    /^gpt-image-2(?:$|[-_.])/.test(name) ||
    /^images?[-_]?2(?:\.0)?$/.test(name) ||
    name === 'images2.0'
  );
}

export function normalizeBuiltInProvider<T extends Omit<IProvider, 'id'> | IProvider>(provider: T): T {
  if (isChunfengPlatform(provider.platform)) {
    return {
      ...provider,
      name: provider.name?.trim() || CHUNFENG_NAME,
      baseUrl: CHUNFENG_BASE_URL,
    };
  }

  if (provider.platform === AUTO_VIP_PLATFORM) {
    return {
      ...provider,
      name: provider.name?.trim() || AUTO_VIP_NAME,
      baseUrl: AUTO_VIP_BASE_URL,
    };
  }

  if (isAgnesPlatform(provider.platform)) {
    return {
      ...provider,
      name: provider.name?.trim() || AGNES_NAME,
      baseUrl: AGNES_BASE_URL,
      model: normalizeAgnesModelList(provider.model),
      capabilities: provider.capabilities?.length
        ? provider.capabilities
        : ['text', 'image_generation', 'video_generation'],
    };
  }

  return provider;
}

export function migrateLegacyAggregatorProvider(provider: IProvider): IProvider {
  if (provider.platform !== LEGACY_AGGREGATOR_PLATFORM) return provider;

  return normalizeBuiltInProvider({
    ...provider,
    platform: AUTO_VIP_PLATFORM,
    name: provider.name?.trim() && provider.name !== 'AI 中转 API' ? provider.name : AUTO_VIP_NAME,
    baseUrl: provider.baseUrl?.trim() || AUTO_VIP_BASE_URL,
  }) as IProvider;
}

export function resolveProviderImageApiFormat(params: {
  platform?: string;
  model?: string;
  apiFormat: ModelApiFormat;
}): ModelApiFormat {
  const { platform, model, apiFormat } = params;

  // 只按显式 platform 区分内置栏目，避免自定义供应商被相同 URL 污染。
  if (isChunfengProvider(platform) && isImage2ModelName(model)) {
    return 'openai_images';
  }

  // auto-vip currently exposes gpt-image-2 through the standard Images API.
  // The Responses image tool path returns upstream 502s in production.
  if (isAutoVipProvider(platform) && isImage2ModelName(model)) {
    return 'openai_images';
  }

  if (isAgnesProvider(platform)) {
    return isAgnesImageModel(model) ? 'openai_images' : 'unsupported';
  }

  return apiFormat;
}
