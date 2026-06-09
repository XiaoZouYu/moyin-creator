// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
/**
 * Image Persist Utility
 * Saves scene images through the platform media adapter or OSS-backed HTTP URLs on Web.
 * Eliminates base64 data from Zustand state persistence.
 */

import { saveImageToLocal, type ImageCategory } from '@/lib/image-storage';
import { uploadToImageHost, isImageHostConfigured } from '@/lib/image-host';
import { getUserScopedMediaCategory } from '@/lib/user-session';

export interface PersistResult {
  /** Persisted local-image:// or OSS HTTP URL */
  localPath: string;
  /** HTTP URL for API reuse */
  httpUrl: string | null;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isWebBrowserRuntime(): boolean {
  return typeof window !== 'undefined'
    && !window.ipcRenderer
    && !(navigator.userAgent || '').includes('Electron');
}

async function saveImageForPersistence(
  imageData: string,
  category: ImageCategory,
  filename: string,
): Promise<string> {
  if (isWebBrowserRuntime()) {
    if (!window.imageStorage?.saveImage) {
      throw new Error('OSS 媒体上传失败：Web 图片存储接口未初始化');
    }
    const result = await window.imageStorage.saveImage(imageData, getUserScopedMediaCategory(category), filename);
    if (!result.success || !result.localPath) {
      throw new Error(result.error || 'OSS 媒体上传失败：Web 端不能保存浏览器本地图片，请检查生产环境 __cloud_media/OSS 配置');
    }
    return result.localPath;
  }

  return saveImageToLocal(imageData, category, filename);
}

async function resolvePublicUrlForPersistence(localPath: string): Promise<string | null> {
  if (isHttpUrl(localPath)) return localPath;
  const publicUrl = await window.imageStorage?.getPublicUrl?.(localPath);
  return publicUrl && isHttpUrl(publicUrl) ? publicUrl : null;
}

/**
 * Persist a scene image.
 *
 * Input can be:
 * - base64 data URI (data:image/...)
 * - HTTP URL (will be downloaded and re-hosted on Web)
 * - local-image:// (already persisted by a platform adapter; re-hosted on Web)
 *
 * @param imageData - The image data (base64 / URL / local-image://)
 * @param sceneId - Scene index for filename generation
 * @param frameType - 'first' for main image, 'end' for end-frame image
 * @param category - Storage category, defaults to 'shots'
 */
export async function persistSceneImage(
  imageData: string,
  sceneId: number,
  frameType: 'first' | 'end' = 'first',
  category: ImageCategory = 'shots'
): Promise<PersistResult> {
  const strictCloudMedia = isWebBrowserRuntime();

  // Already persisted by a native/platform adapter.
  if (!strictCloudMedia && imageData.startsWith('local-image://')) {
    return { localPath: imageData, httpUrl: null };
  }

  // Empty or invalid
  if (!imageData) {
    return { localPath: '', httpUrl: null };
  }

  const timestamp = Date.now();
  const filename = `scene_${sceneId}_${frameType}_${timestamp}.png`;

  // In Web this uploads to OSS and returns its HTTP URL.
  const localPath = await saveImageForPersistence(imageData, category, filename);

  if (strictCloudMedia) {
    const httpUrl = await resolvePublicUrlForPersistence(localPath);
    if (!httpUrl) {
      throw new Error('OSS 媒体上传成功但无法生成公网访问地址，请检查生产环境 __cloud_media/file 代理配置');
    }
    return { localPath, httpUrl };
  }

  // Optionally upload local images to an image host for API reuse.
  let httpUrl: string | null = null;
  if (isImageHostConfigured()) {
    try {
      const result = await uploadToImageHost(imageData, {
        name: filename,
        expiration: 15552000, // 180 days
      });
      if (result.success && result.url) {
        httpUrl = result.url;
      }
    } catch (error) {
      console.warn('[persistSceneImage] Image host upload failed:', error);
    }
  }

  return { localPath, httpUrl };
}

/**
 * Persist a reference image (e.g. scene reference, wardrobe reference).
 * Thin wrapper with 'scenes' as default category.
 */
export async function persistReferenceImage(
  imageData: string,
  label: string,
  category: ImageCategory = 'scenes'
): Promise<PersistResult> {
  const strictCloudMedia = isWebBrowserRuntime();

  if (!strictCloudMedia && imageData.startsWith('local-image://')) {
    return { localPath: imageData, httpUrl: null };
  }

  if (!imageData) {
    return { localPath: '', httpUrl: null };
  }

  const timestamp = Date.now();
  const filename = `ref_${label}_${timestamp}.png`;

  const localPath = await saveImageForPersistence(imageData, category, filename);

  if (strictCloudMedia) {
    const httpUrl = await resolvePublicUrlForPersistence(localPath);
    if (!httpUrl) {
      throw new Error('OSS 媒体上传成功但无法生成公网访问地址，请检查生产环境 __cloud_media/file 代理配置');
    }
    return { localPath, httpUrl };
  }

  let httpUrl: string | null = null;
  if (isImageHostConfigured()) {
    try {
      const result = await uploadToImageHost(imageData, {
        name: filename,
        expiration: 15552000,
      });
      if (result.success && result.url) {
        httpUrl = result.url;
      }
    } catch (error) {
      console.warn('[persistReferenceImage] Image host upload failed:', error);
    }
  }

  return { localPath, httpUrl };
}
