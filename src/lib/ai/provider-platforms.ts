// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.

import type { IProvider, ModelApiFormat } from '@/lib/api-key-manager';

export const CHUNFENG_PLATFORM = 'chunfeng';
export const CHUNFENG_NAME = '春风';
export const CHUNFENG_BASE_URL = 'https://chunfeng.mentalout.top/v1';

export const AUTO_VIP_PLATFORM = 'auto-vip';
export const AUTO_VIP_NAME = 'auto-vip';
export const AUTO_VIP_BASE_URL = 'https://vip.auto-code.net/v1';

export const LEGACY_AGGREGATOR_PLATFORM = 'aggregator';

export function isChunfengPlatform(platform?: string): boolean {
  return platform === CHUNFENG_PLATFORM;
}

export function isAutoVipPlatform(platform?: string): boolean {
  return platform === AUTO_VIP_PLATFORM || platform === LEGACY_AGGREGATOR_PLATFORM;
}

export function isChunfengProvider(platform?: string): boolean {
  return isChunfengPlatform(platform);
}

export function isAutoVipProvider(platform?: string): boolean {
  return isAutoVipPlatform(platform);
}

export function isFixedBaseUrlProviderPlatform(platform?: string): boolean {
  return isChunfengPlatform(platform) || platform === AUTO_VIP_PLATFORM;
}

export function isPricingMetadataProviderPlatform(platform?: string): boolean {
  return isAutoVipPlatform(platform);
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

  // auto-vip 继续使用项目原有 IMAGE2 Responses tool 流程。
  if (isAutoVipProvider(platform) && isImage2ModelName(model)) {
    return 'openai_responses_image';
  }

  return apiFormat;
}
