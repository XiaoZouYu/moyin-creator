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

const SD2_COMPATIBLE_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
]);

function assertValidBase64Payload(payload: string): void {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.length % 4 === 1) {
    throw new Error('图片 data URL 包含无效 base64 内容');
  }
}

function decodeBase64Prefix(payload: string, maxBytes = 32): Uint8Array | null {
  const charCount = Math.min(payload.length, Math.ceil(maxBytes / 3) * 4);
  let prefix = payload.slice(0, charCount);
  const remainder = prefix.length % 4;
  if (remainder !== 0) {
    prefix += '='.repeat(4 - remainder);
  }

  try {
    const binary = atob(prefix);
    const length = Math.min(binary.length, maxBytes);
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

function bytesStartWith(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return '';
  let value = '';
  for (let i = offset; i < offset + length; i += 1) {
    value += String.fromCharCode(bytes[i]);
  }
  return value;
}

function inferApiImageMimeType(payload: string): string | null {
  const bytes = decodeBase64Prefix(payload);
  if (!bytes) return null;

  if (bytesStartWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (bytesStartWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (asciiAt(bytes, 0, 4) === 'RIFF' && asciiAt(bytes, 8, 4) === 'WEBP') return 'image/webp';
  if (asciiAt(bytes, 0, 6) === 'GIF87a' || asciiAt(bytes, 0, 6) === 'GIF89a') return 'image/gif';
  if (bytesStartWith(bytes, [0x42, 0x4d])) return 'image/bmp';
  if (
    bytesStartWith(bytes, [0x49, 0x49, 0x2a, 0x00]) ||
    bytesStartWith(bytes, [0x49, 0x49, 0x2b, 0x00]) ||
    bytesStartWith(bytes, [0x4d, 0x4d, 0x00, 0x2a]) ||
    bytesStartWith(bytes, [0x4d, 0x4d, 0x00, 0x2b])
  ) {
    return 'image/tiff';
  }

  if (asciiAt(bytes, 4, 4) === 'ftyp') {
    const brand = asciiAt(bytes, 8, 4).toLowerCase();
    if (['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs'].includes(brand)) {
      return 'image/heic';
    }
    if (['heif', 'mif1', 'msf1'].includes(brand)) {
      return 'image/heif';
    }
  }

  return null;
}

function normalizeApiImageMimeType(_mimeType: string | undefined, payload: string): string | null {
  const inferred = inferApiImageMimeType(payload);
  if (inferred && SUPPORTED_API_IMAGE_MIME_TYPES.has(inferred)) return inferred;
  return null;
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
  assertValidBase64Payload(payload);

  const mimeType = normalizeApiImageMimeType(match[1], payload);
  if (!mimeType) {
    throw new Error('图片 data URL 不是支持的图片格式');
  }

  return `data:${mimeType};base64,${payload}`;
}

function getDataUrlMimeType(dataUrl: string): string {
  return dataUrl.match(/^data:([^;,]+)/i)?.[1]?.toLowerCase() || '';
}

function normalizeOutputMimeType(mimeType?: string): 'image/png' | 'image/jpeg' {
  const normalized = (mimeType || '').toLowerCase();
  return normalized === 'image/jpeg' || normalized === 'image/jpg' ? 'image/jpeg' : 'image/png';
}

async function reencodeImageDataUrl(
  dataUrl: string,
  outputMimeType: 'image/png' | 'image/jpeg',
  quality = 0.92,
): Promise<string> {
  if (typeof document === 'undefined') {
    throw new Error('当前运行环境无法重新编码图片');
  }

  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('无法解码图片'));
    img.src = dataUrl;
  });

  if (!image.naturalWidth || !image.naturalHeight) {
    throw new Error('图片尺寸无效');
  }

  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建图片画布');
  if (outputMimeType === 'image/jpeg') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(image, 0, 0);
  return canvas.toDataURL(outputMimeType, quality);
}

export interface NormalizeImageSourceForApiOptions {
  outputMimeType?: 'image/png' | 'image/jpeg';
  compatibleMimeTypes?: Set<string>;
  forceReencode?: boolean;
}

export async function normalizeImageSourceToDataUrlForApi(
  source: string,
  options: NormalizeImageSourceForApiOptions = {},
): Promise<string> {
  const dataUrl = isDataUrl(source) ? source : await mediaUrlToDataUrl(source);
  const outputMimeType = normalizeOutputMimeType(options.outputMimeType);
  const compatibleMimeTypes = options.compatibleMimeTypes || SD2_COMPATIBLE_IMAGE_MIME_TYPES;

  let normalized: string | null = null;
  let normalizeError: unknown = null;
  try {
    normalized = normalizeImageDataUrlForApi(dataUrl);
    const mimeType = getDataUrlMimeType(normalized);
    if (!options.forceReencode && compatibleMimeTypes.has(mimeType)) {
      return normalized;
    }
  } catch (error) {
    normalizeError = error;
  }

  try {
    const reencoded = await reencodeImageDataUrl(dataUrl, outputMimeType);
    return normalizeImageDataUrlForApi(reencoded);
  } catch (error) {
    const normalizedMessage = normalizeError instanceof Error ? normalizeError.message : String(normalizeError || '');
    const reencodeMessage = error instanceof Error ? error.message : String(error);
    const detail = [normalizedMessage, reencodeMessage].filter(Boolean).join('；');
    throw new Error(`图片不是可解码的 SD2.0 兼容格式${detail ? `：${detail}` : ''}`);
  }
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
  const normalizedDataUrl = await normalizeImageSourceToDataUrlForApi(dataUrl);
  const preparedDataUrl = await ensureDataUrlMinDimension(normalizedDataUrl, options.minDimension);
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
      return uploadDataUrlToImageHost(await normalizeImageSourceToDataUrlForApi(url), options);
    }

    if (isDiscouragedExternalImageUrl(url)) {
      console.warn(`[${logPrefix}] ${label}: using external URL without local fallback:`, url.substring(0, 80));
    }
    return url;
  }

  if (!isImageHostConfigured()) {
    throw new Error('图床未配置，请先在设置中启用 Catbox 或其他可用图床');
  }

  return uploadDataUrlToImageHost(await normalizeImageSourceToDataUrlForApi(url), options);
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
      let input = options.forceDataUrl || options.requireBase64DataUrl || !isHttpMediaUrl(ref)
        ? await normalizeImageSourceToDataUrlForApi(ref)
        : ref;

      if (options.requireBase64DataUrl && !isHttpMediaUrl(input)) {
        try {
          input = normalizeImageDataUrlForApi(input);
        } catch {
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
