// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
/**
 * Unified media URL resolver for AI image/video workflows.
 *
 * External image URLs are a frequent source of browser CORS and provider-side
 * fetch failures. Keep all conversion and upload decisions here instead of
 * scattering raw fetch(url) calls across panels.
 */

import { isImageHostConfigured, uploadToImageHost } from '@/lib/image-host';
export {
  blobToDataUrl,
  dataUrlToBlob,
  isBlobUrl,
  isDataUrl,
  isHttpMediaUrl,
  isLocalMediaSource,
  mediaUrlToBlob,
  mediaUrlToDataUrl,
  normalizeMediaUrl,
} from '@/lib/media-source';
import {
  isBlobUrl,
  isDataUrl,
  isHttpMediaUrl,
  isLocalMediaSource,
  mediaUrlToDataUrl,
  normalizeMediaUrl,
} from '@/lib/media-source';

export function isDiscouragedExternalImageUrl(value?: string | null): boolean {
  if (typeof value !== 'string' || !isHttpMediaUrl(value)) return false;
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === 'bmp.ovh' || hostname.endsWith('.bmp.ovh');
  } catch {
    return false;
  }
}

async function ensureDataUrlMinDimension(dataUrl: string, minDimension?: number): Promise<string> {
  if (!minDimension || minDimension <= 0 || typeof document === 'undefined') return dataUrl;

  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('无法解码图片'));
    img.src = dataUrl;
  });

  if (image.naturalWidth >= minDimension && image.naturalHeight >= minDimension) {
    return dataUrl;
  }

  const scale = Math.max(minDimension / image.naturalWidth, minDimension / image.naturalHeight);
  const width = Math.ceil(image.naturalWidth * scale);
  const height = Math.ceil(image.naturalHeight * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL('image/png');
}

const SUPPORTED_API_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/bmp',
  'image/tiff',
  'image/gif',
  'image/heic',
  'image/heif',
]);

function normalizeApiImageMimeType(mimeType: string | undefined, payload: string): string {
  const normalized = (mimeType || '').trim().toLowerCase();
  if (normalized === 'image/jpg') return 'image/jpeg';
  if (SUPPORTED_API_IMAGE_MIME_TYPES.has(normalized)) return normalized;

  const prefix = payload.slice(0, 32);
  if (prefix.startsWith('/9j/')) return 'image/jpeg';
  if (prefix.startsWith('iVBORw0KGgo')) return 'image/png';
  if (prefix.startsWith('UklGR')) return 'image/webp';
  if (prefix.startsWith('R0lGOD')) return 'image/gif';
  if (prefix.startsWith('Qk')) return 'image/bmp';
  if (prefix.startsWith('SUkq') || prefix.startsWith('TU0A')) return 'image/tiff';
  if (prefix.includes('ZnR5cGhlaWM')) return 'image/heic';
  if (prefix.includes('ZnR5cGhlaWY')) return 'image/heif';

  return 'image/png';
}

export function normalizeImageDataUrlForApi(dataUrl: string): string {
  const match = dataUrl.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/is);
  if (!match) {
    throw new Error('图片 data URL 格式无效，必须是 base64 data URI');
  }

  const payload = match[2].replace(/\s+/g, '');
  if (!payload) {
    throw new Error('图片 data URL 内容为空');
  }

  return `data:${normalizeApiImageMimeType(match[1], payload)};base64,${payload}`;
}

export interface ResolveImageToHttpUrlOptions {
  localFallback?: string | null;
  uploadName?: string;
  frameLabel?: string;
  minDimension?: number;
  preferLocalFallback?: boolean;
  forceReuploadHttp?: boolean;
  logPrefix?: string;
}

async function uploadDataUrlToImageHost(dataUrl: string, options: ResolveImageToHttpUrlOptions): Promise<string> {
  const preparedDataUrl = await ensureDataUrlMinDimension(dataUrl, options.minDimension);
  const result = await uploadToImageHost(preparedDataUrl, {
    name: options.uploadName?.trim() || `media_ref_${Date.now()}`,
    expiration: 15552000,
  });

  if (!result.success || !result.url) {
    throw new Error(result.error || '图片上传失败');
  }

  return result.url;
}

export async function resolveImageToHttpUrl(
  rawUrl: unknown,
  options: ResolveImageToHttpUrlOptions = {},
): Promise<string> {
  const url = normalizeMediaUrl(rawUrl);
  const localFallback = normalizeMediaUrl(options.localFallback);
  const label = options.frameLabel || 'Image';
  const logPrefix = options.logPrefix || 'MediaUrlResolver';

  if (!url) {
    if (localFallback) {
      if (!options.forceReuploadHttp && isHttpMediaUrl(localFallback)) return localFallback;
      return resolveImageToHttpUrl(localFallback, {
        ...options,
        localFallback: null,
        preferLocalFallback: false,
      });
    }
    console.warn(`[${logPrefix}] ${label}: empty image source`);
    return '';
  }

  if (isHttpMediaUrl(url)) {
    const canRefreshFromLocal = isLocalMediaSource(localFallback) && isImageHostConfigured();
    if (canRefreshFromLocal && (options.forceReuploadHttp || options.preferLocalFallback !== false || isDiscouragedExternalImageUrl(url))) {
      console.log(`[${logPrefix}] ${label}: re-uploading local fallback instead of reusing external URL`);
      return resolveImageToHttpUrl(localFallback, {
        ...options,
        localFallback: null,
        preferLocalFallback: false,
      });
    }

    if (options.forceReuploadHttp) {
      if (!isImageHostConfigured()) {
        throw new Error(`${label}需要重新上传外部 HTTP 图片，但图床未配置，请先在设置中启用 Catbox 或其他可用图床`);
      }
      console.log(`[${logPrefix}] ${label}: re-uploading external HTTP image before API submission`);
      return uploadDataUrlToImageHost(await mediaUrlToDataUrl(url), options);
    }

    if (isDiscouragedExternalImageUrl(url)) {
      console.warn(`[${logPrefix}] ${label}: using external URL without local fallback:`, url.substring(0, 80));
    }
    return url;
  }

  if (!isImageHostConfigured()) {
    throw new Error('图床未配置，请先在设置中启用 Catbox 或其他可用图床');
  }

  return uploadDataUrlToImageHost(await mediaUrlToDataUrl(url), options);
}

export interface PrepareImageReferencesForApiOptions {
  maxCount?: number;
  forceDataUrl?: boolean;
  requireBase64DataUrl?: boolean;
  logPrefix?: string;
}

export async function prepareImageReferencesForApi(
  references: string[],
  options: PrepareImageReferencesForApiOptions = {},
): Promise<string[]> {
  const maxCount = options.maxCount ?? references.length;
  const logPrefix = options.logPrefix || 'MediaUrlResolver';
  const prepared: string[] = [];

  for (const rawRef of references.slice(0, maxCount)) {
    const ref = normalizeMediaUrl(rawRef);
    if (!ref) continue;

    try {
      const input = options.forceDataUrl || !isHttpMediaUrl(ref)
        ? await mediaUrlToDataUrl(ref)
        : ref;

      if (options.requireBase64DataUrl && !isHttpMediaUrl(input)) {
        if (!input.startsWith('data:image/') || !input.includes(';base64,')) {
          console.warn(`[${logPrefix}] 跳过非 base64 图片引用:`, input.substring(0, 80));
          continue;
        }
      }

      prepared.push(input);
    } catch (error) {
      console.warn(`[${logPrefix}] 图片引用转换失败:`, ref.substring(0, 80), error);
    }
  }

  return prepared;
}

export interface ResolveMediaReferenceToHttpUrlOptions {
  fallbackHttpUrl?: string | null;
  mediaKind?: 'video' | 'audio' | 'media';
  label?: string;
  logPrefix?: string;
}

export async function resolveMediaReferenceToHttpUrl(
  rawUrl: unknown,
  options: ResolveMediaReferenceToHttpUrlOptions = {},
): Promise<string> {
  const url = normalizeMediaUrl(rawUrl);
  const fallbackHttpUrl = normalizeMediaUrl(options.fallbackHttpUrl);
  const mediaKind = options.mediaKind || 'media';
  const label = options.label || (mediaKind === 'media' ? '媒体引用' : `${mediaKind === 'video' ? '视频' : '音频'}引用`);
  const logPrefix = options.logPrefix || 'MediaUrlResolver';

  if (isHttpMediaUrl(url)) return url;
  if (isHttpMediaUrl(fallbackHttpUrl)) return fallbackHttpUrl;

  if (!url) {
    console.warn(`[${logPrefix}] ${label}: empty media source`);
    return '';
  }

  if (isDataUrl(url) || isBlobUrl(url) || isLocalMediaSource(url)) {
    throw new Error(`${label}不是可公网访问的 HTTP(S) 地址。视频/音频引用不能走图片图床转换，请使用已上传的远程媒体 URL。`);
  }

  throw new Error(`${label}必须是 HTTP(S) 地址`);
}
