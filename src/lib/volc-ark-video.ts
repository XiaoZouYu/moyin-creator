// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.

export const VOLC_ARK_VIDEO_PLATFORM = "volc_ark_video";
export const VOLC_ARK_VIDEO_NAME = "火山方舟视频生成";
export const VOLC_ARK_VIDEO_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
export const VOLC_ARK_SEEDANCE_1_0_LITE_I2V_MODEL_ID = "doubao-seedance-1-0-lite-i2v-250428";
export const VOLC_ARK_SEEDANCE_1_0_LITE_T2V_MODEL_ID = "doubao-seedance-1-0-lite-t2v-250428";
export const VOLC_ARK_SEEDANCE_1_0_PRO_MODEL_ID = "doubao-seedance-1-0-pro-250528";
export const VOLC_ARK_SEEDANCE_1_0_PRO_FAST_MODEL_ID = "doubao-seedance-1-0-pro-fast-251015";
export const VOLC_ARK_SEEDANCE_1_5_PRO_MODEL_ID = "doubao-seedance-1-5-pro-251215";
export const VOLC_ARK_SEEDANCE_2_0_MODEL_ID = "doubao-seedance-2-0-260128";
export const VOLC_ARK_SEEDANCE_2_0_PRO_MODEL_ID = "doubao-seedance-2-0-pro";
export const VOLC_ARK_SEEDANCE_MODEL_ID = VOLC_ARK_SEEDANCE_1_0_PRO_MODEL_ID;
export const VOLC_ARK_SEEDANCE_FALLBACK_MODEL_ID = VOLC_ARK_SEEDANCE_1_0_PRO_FAST_MODEL_ID;
export const VOLC_ARK_SEEDANCE_DISPLAY_NAME = "Seedance 1.0 Pro";
export const VOLC_ARK_LEGACY_DEFAULT_MODEL_IDS = [
  VOLC_ARK_SEEDANCE_1_0_LITE_I2V_MODEL_ID,
  VOLC_ARK_SEEDANCE_1_0_LITE_T2V_MODEL_ID,
  VOLC_ARK_SEEDANCE_2_0_MODEL_ID,
  VOLC_ARK_SEEDANCE_2_0_PRO_MODEL_ID,
] as const;

export const VOLC_ARK_VIDEO_MODEL_OPTIONS = [
  {
    id: VOLC_ARK_SEEDANCE_1_0_PRO_MODEL_ID,
    label: "Seedance 1.0 Pro",
    description: "方舟官方 1.0 通用视频生成模型",
  },
  {
    id: VOLC_ARK_SEEDANCE_1_0_PRO_FAST_MODEL_ID,
    label: "Seedance 1.0 Pro Fast",
    description: "方舟官方 1.0 快速视频生成模型",
  },
  {
    id: VOLC_ARK_SEEDANCE_1_5_PRO_MODEL_ID,
    label: "Seedance 1.5 Pro",
    description: "需要账号开通对应模型权限",
  },
  {
    id: VOLC_ARK_SEEDANCE_2_0_MODEL_ID,
    label: "Seedance 2.0",
    description: "需要账号开通对应模型权限",
  },
] as const;
export const VOLC_ARK_SEEDANCE_KNOWN_MODEL_IDS = VOLC_ARK_VIDEO_MODEL_OPTIONS.map((option) => option.id);

export function isVolcArkVideoPlatform(platform?: string | null): boolean {
  return platform === VOLC_ARK_VIDEO_PLATFORM;
}

export function normalizeVolcArkVideoModelList(models?: readonly string[] | null): string[] {
  const normalized = Array.from(new Set((models || []).map((model) => model.trim()).filter(Boolean)));
  const allowed = new Set<string>(VOLC_ARK_SEEDANCE_KNOWN_MODEL_IDS);
  const supported = normalized.filter((model) => allowed.has(model));
  return supported.length > 0 ? supported : [VOLC_ARK_SEEDANCE_MODEL_ID];
}

export function isLegacyVolcArkDefaultModel(model?: string | null): boolean {
  if (!model) return false;
  return (VOLC_ARK_LEGACY_DEFAULT_MODEL_IDS as readonly string[]).includes(model.trim());
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
