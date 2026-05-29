// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.

export const VOLC_ARK_VIDEO_PLATFORM = "volc_ark_video";
export const VOLC_ARK_VIDEO_NAME = "火山方舟视频生成";
export const VOLC_ARK_VIDEO_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
export const VOLC_ARK_SEEDANCE_MODEL_ID = "doubao-seedance-2-0-260128";
export const VOLC_ARK_SEEDANCE_FALLBACK_MODEL_ID = "doubao-seedance-2-0-pro";
export const VOLC_ARK_SEEDANCE_DISPLAY_NAME = "Seedance 2.0";

export function isVolcArkVideoPlatform(platform?: string | null): boolean {
  return platform === VOLC_ARK_VIDEO_PLATFORM;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function getProxyRootBaseUrl(baseUrl: string): string {
  return normalizeBaseUrl(baseUrl).replace(/\/v\d+$/, "");
}

export function buildVolcVideoTaskUrls(baseUrl: string, officialArk: boolean) {
  if (officialArk) {
    const officialBase = normalizeBaseUrl(baseUrl || VOLC_ARK_VIDEO_BASE_URL);
    return {
      submit: `${officialBase}/contents/generations/tasks`,
      poll: (taskId: string) => `${officialBase}/contents/generations/tasks/${taskId}`,
      routeLabel: "/api/v3/contents/generations/tasks",
    };
  }

  const proxyBase = getProxyRootBaseUrl(baseUrl);
  return {
    submit: `${proxyBase}/volc/v1/contents/generations/tasks`,
    poll: (taskId: string) => `${proxyBase}/volc/v1/contents/generations/tasks/${taskId}`,
    routeLabel: "/volc/v1/contents/generations/tasks",
  };
}
