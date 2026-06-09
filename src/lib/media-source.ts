// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
/**
 * Low-level media source reader.
 *
 * Keep URL/blob/dataURL reads here so UI panels do not call raw fetch(url)
 * for external generated media.
 */

import { corsFetch } from '@/lib/cors-fetch';
import { readImageAsBase64 } from '@/lib/image-storage';
import { getUserScopedMediaCategory } from '@/lib/user-session';

export function normalizeMediaUrl(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return normalizeMediaUrl(value[0]);
  return '';
}

export function isHttpMediaUrl(value?: string | null): boolean {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

export function isLocalMediaSource(value?: string | null): boolean {
  return typeof value === 'string' && value.length > 0 && !isHttpMediaUrl(value);
}

export function isDataUrl(value?: string | null): boolean {
  return typeof value === 'string' && /^data:/i.test(value);
}

export function isBlobUrl(value?: string | null): boolean {
  return typeof value === 'string' && /^blob:/i.test(value);
}

function filenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const base = decodeURIComponent(parsed.pathname).split('/').pop()?.trim();
    if (base) return base.replace(/[<>:"/\\|?*]/g, '_');
  } catch {
    // Use fallback below.
  }
  return `remote-${Date.now()}`;
}

async function ingestHttpMediaToLocal(url: string): Promise<string | null> {
  if (typeof window === 'undefined' || !window.imageStorage?.saveImage) return null;
  const result = await window.imageStorage.saveImage(
    url,
    getUserScopedMediaCategory('external'),
    filenameFromUrl(url),
  );
  return result.success && result.localPath ? result.localPath : null;
}

export function dataUrlToBlob(dataUrl: string, fallbackMimeType = 'application/octet-stream'): Blob {
  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex < 0) {
    throw new Error('data URL 格式无效');
  }

  const header = dataUrl.slice(0, commaIndex);
  const payload = dataUrl.slice(commaIndex + 1);
  const mimeType = header.match(/^data:([^;,]+)/i)?.[1] || fallbackMimeType;
  const isBase64 = /;base64/i.test(header);
  const binary = isBase64 ? atob(payload) : decodeURIComponent(payload);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new Blob([bytes], { type: mimeType });
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export async function mediaUrlToBlob(source: string): Promise<Blob> {
  const url = normalizeMediaUrl(source);
  if (!url) throw new Error('媒体地址为空');

  if (isDataUrl(url)) {
    return dataUrlToBlob(url);
  }

  if (url.startsWith('local-image://')) {
    const dataUrl = await readImageAsBase64(url);
    if (!dataUrl) throw new Error('无法读取本地图片');
    return dataUrlToBlob(dataUrl);
  }

  if (isBlobUrl(url)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`无法读取 blob URL: HTTP ${response.status}`);
    return response.blob();
  }

  if (isHttpMediaUrl(url)) {
    try {
      const localPath = await ingestHttpMediaToLocal(url);
      if (localPath && localPath !== url) {
        return mediaUrlToBlob(localPath);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`后端媒体摄取失败：${message}`);
    }
  }

  try {
    const response = await corsFetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.blob();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`外部媒体读取失败：${message}`);
  }
}

export async function mediaUrlToDataUrl(source: string): Promise<string> {
  const url = normalizeMediaUrl(source);
  if (!url) throw new Error('媒体地址为空');
  if (isDataUrl(url)) return url;

  if (url.startsWith('local-image://')) {
    const dataUrl = await readImageAsBase64(url);
    if (!dataUrl) throw new Error('无法读取本地图片');
    return dataUrl;
  }

  return blobToDataUrl(await mediaUrlToBlob(url));
}
