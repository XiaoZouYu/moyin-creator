// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.

import { readImageAsBase64 } from '@/lib/image-storage';
import {
  blobToDataUrl,
  isHttpMediaUrl,
  mediaUrlToDataUrl,
  normalizeImageDataUrlForApi,
  normalizeMediaUrl,
  resolveImageToHttpUrl,
  resolveMediaReferenceToHttpUrl,
} from '@/lib/media-url-resolver';
import { corsFetch } from '@/lib/cors-fetch';
import { createProviderError } from '@/lib/ai/provider-errors';

export type VideoApiFormat =
  | 'openai_official'
  | 'unified'
  | 'agnes'
  | 'volc'
  | 'volc_ark'
  | 'wan'
  | 'kling'
  | 'replicate';

export type VideoImageRole = 'first_frame' | 'last_frame';
export type VideoImageInputMode = 'http_url' | 'base64_data_uri';

export interface VideoImageInput {
  url: string;
  role: VideoImageRole;
  sourceUrl?: string;
  uploadName?: string;
}

export interface PreparedVideoImageInput extends VideoImageInput {
  inputMode: VideoImageInputMode;
}

export interface PreparedVideoMediaInputs {
  images: PreparedVideoImageInput[];
  videoRefs?: string[];
  audioRefs?: string[];
  imageInputMode: VideoImageInputMode;
}

interface PrepareVideoMediaInputsOptions {
  format: VideoApiFormat;
  imageWithRoles: VideoImageInput[];
  videoRefs?: string[];
  audioRefs?: string[];
  provider?: string;
  model?: string;
  logPrefix?: string;
}

const VIDEO_MEDIA_PROFILES: Record<VideoApiFormat, { imageInputMode: VideoImageInputMode }> = {
  openai_official: { imageInputMode: 'http_url' },
  unified: { imageInputMode: 'http_url' },
  agnes: { imageInputMode: 'http_url' },
  volc: { imageInputMode: 'base64_data_uri' },
  volc_ark: { imageInputMode: 'base64_data_uri' },
  wan: { imageInputMode: 'http_url' },
  kling: { imageInputMode: 'http_url' },
  replicate: { imageInputMode: 'http_url' },
};

function imageRoleLabel(role?: string): string {
  return role === 'last_frame' ? '尾帧图' : '首帧图';
}

function sourceKind(source: string): string {
  if (/^https?:\/\//i.test(source)) return 'http';
  if (/^data:/i.test(source)) return 'data';
  if (/^blob:/i.test(source)) return 'blob';
  if (source.startsWith('local-image://')) return 'local-image';
  if (source.startsWith('file://')) return 'file';
  return 'local';
}

function normalizeProviderImageDataUrl(dataUrl: string, label: string, contentType?: string): string {
  try {
    return normalizeImageDataUrlForApi(dataUrl);
  } catch (error) {
    const mimeType = contentType || dataUrl.match(/^data:([^;,]+)/i)?.[1] || 'unknown';
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}返回的不是支持图片：content-type=${mimeType}，${message}`);
  }
}

function formatFetchError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /failed to fetch/i.test(message) ? '网络请求失败' : message;
}

async function readProviderImageDataUrl(source: string, label: string): Promise<string> {
  if (typeof window !== 'undefined' && window.imageStorage?.readAsBase64) {
    const dataUrl = await readImageAsBase64(source);
    if (dataUrl) return normalizeProviderImageDataUrl(dataUrl, label);
  }

  if (isHttpMediaUrl(source)) {
    let response: Response;
    try {
      response = await corsFetch(source);
    } catch (error) {
      throw new Error(`${label}下载失败：${formatFetchError(error)}`);
    }
    if (!response.ok) {
      throw new Error(`${label}下载失败：HTTP ${response.status} ${response.statusText || ''}`.trim());
    }
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    const blob = await response.blob();
    return normalizeProviderImageDataUrl(await blobToDataUrl(blob), label, contentType || blob.type);
  }

  return normalizeProviderImageDataUrl(await mediaUrlToDataUrl(source), label);
}

async function prepareImageAsDataUrl(
  img: VideoImageInput,
  context: Pick<PrepareVideoMediaInputsOptions, 'provider' | 'model' | 'logPrefix'>,
): Promise<PreparedVideoImageInput> {
  const sources = [...new Set([img.url, img.sourceUrl].map(normalizeMediaUrl).filter(Boolean))];
  const label = imageRoleLabel(img.role);
  const errors: string[] = [];

  for (const source of sources) {
    try {
      const url = await readProviderImageDataUrl(source, label);
      return {
        ...img,
        url,
        inputMode: 'base64_data_uri',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      console.warn(`[${context.logPrefix || 'VideoMediaPrep'}] image source conversion failed, trying fallback`, {
        label,
        sourceKind: sourceKind(source),
        error: message,
      });
    }
  }

  throw createProviderError({
    mediaKind: 'video',
    stage: 'prepare',
    provider: context.provider,
    model: context.model,
    fallbackMessage: errors.join('；') || `${label}读取失败：没有可用图片地址`,
  });
}

async function prepareImageAsHttpUrl(
  img: VideoImageInput,
  context: Pick<PrepareVideoMediaInputsOptions, 'provider' | 'model' | 'logPrefix'>,
): Promise<PreparedVideoImageInput> {
  const label = imageRoleLabel(img.role);
  try {
    const url = await resolveImageToHttpUrl(img.url, {
      localFallback: img.sourceUrl,
      uploadName: img.uploadName || `video_${img.role}_${Date.now()}`,
      frameLabel: label,
      minDimension: 300,
      forceReuploadHttp: false,
      preferLocalFallback: false,
      logPrefix: context.logPrefix || 'VideoMediaPrep',
    });
    if (!url) {
      throw new Error(`${label}为空`);
    }
    return {
      ...img,
      url,
      inputMode: 'http_url',
    };
  } catch (error) {
    throw createProviderError({
      mediaKind: 'video',
      stage: 'prepare',
      provider: context.provider,
      model: context.model,
      originalError: error,
    });
  }
}

async function prepareImageInput(
  img: VideoImageInput,
  inputMode: VideoImageInputMode,
  context: Pick<PrepareVideoMediaInputsOptions, 'provider' | 'model' | 'logPrefix'>,
): Promise<PreparedVideoImageInput> {
  return inputMode === 'base64_data_uri'
    ? prepareImageAsDataUrl(img, context)
    : prepareImageAsHttpUrl(img, context);
}

async function prepareHttpMediaRefs(
  refs: string[] | undefined,
  mediaKind: 'video' | 'audio',
  context: Pick<PrepareVideoMediaInputsOptions, 'provider' | 'model' | 'logPrefix'>,
): Promise<string[] | undefined> {
  const prepared: string[] = [];
  for (let index = 0; index < (refs || []).length; index += 1) {
    const rawRef = refs![index];
    const ref = normalizeMediaUrl(rawRef);
    if (!ref) continue;
    try {
      const url = await resolveMediaReferenceToHttpUrl(ref, {
        mediaKind,
        label: `${mediaKind === 'video' ? '视频' : '音频'}引用 #${index + 1}`,
        logPrefix: context.logPrefix || 'VideoMediaPrep',
      });
      if (url) prepared.push(url);
    } catch (error) {
      throw createProviderError({
        mediaKind,
        stage: 'prepare',
        provider: context.provider,
        model: context.model,
        originalError: error,
      });
    }
  }
  return prepared.length > 0 ? prepared : undefined;
}

export function getVideoImageInputMode(format: VideoApiFormat): VideoImageInputMode {
  return VIDEO_MEDIA_PROFILES[format]?.imageInputMode || 'http_url';
}

export async function prepareVideoMediaInputs(options: PrepareVideoMediaInputsOptions): Promise<PreparedVideoMediaInputs> {
  const imageInputMode = getVideoImageInputMode(options.format);
  const context = {
    provider: options.provider,
    model: options.model,
    logPrefix: options.logPrefix,
  };

  const images = await Promise.all(
    options.imageWithRoles
      .filter((img) => normalizeMediaUrl(img.url))
      .map((img) => prepareImageInput(img, imageInputMode, context)),
  );

  const [videoRefs, audioRefs] = await Promise.all([
    prepareHttpMediaRefs(options.videoRefs, 'video', context),
    prepareHttpMediaRefs(options.audioRefs, 'audio', context),
  ]);

  return {
    images,
    videoRefs,
    audioRefs,
    imageInputMode,
  };
}
