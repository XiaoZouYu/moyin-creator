// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
/**
 * useResolvedImageUrl — Resolve image URLs for display in <img> tags.
 *
 * Handles URL formats:
 * - `https://...` / `http://...` → ingested by backend media storage, then resolved
 * - `data:image/...` → pass through (legacy base64)
 * - `local-image://...` → resolved through the platform image storage bridge
 * - `null/undefined/''` → null
 *
 * The Web platform adapter resolves `local-image://` values to displayable
 * object URLs or cloud media URLs before rendering.
 */

import { useEffect, useState } from 'react';
import { resolveImagePath, saveImageToLocal } from '@/lib/image-storage';

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * React hook to resolve an image URL for rendering.
 * All supported URL formats are returned synchronously.
 */
export function useResolvedImageUrl(rawUrl: string | null | undefined): string | null {
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(rawUrl || null);

  useEffect(() => {
    let cancelled = false;

    if (!rawUrl) {
      setResolvedUrl(null);
      return () => {
        cancelled = true;
      };
    }

    if (isHttpUrl(rawUrl)) {
      setResolvedUrl(null);
      saveImageToLocal(rawUrl, 'shots', `display-${Date.now()}.png`)
        .then((localPath) => {
          if (isHttpUrl(localPath) && localPath === rawUrl) {
            throw new Error('后端媒体摄取失败');
          }
          return resolveImagePath(localPath);
        })
        .then((url) => {
          if (!cancelled) setResolvedUrl(url);
        })
        .catch(() => {
          if (!cancelled) setResolvedUrl(null);
        });
      return () => {
        cancelled = true;
      };
    }

    if (!rawUrl.startsWith('local-image://')) {
      setResolvedUrl(rawUrl);
      return () => {
        cancelled = true;
      };
    }

    setResolvedUrl(null);
    resolveImagePath(rawUrl)
      .then((url) => {
        if (!cancelled) setResolvedUrl(url);
      })
      .catch(() => {
        if (!cancelled) setResolvedUrl(rawUrl);
      });

    return () => {
      cancelled = true;
    };
  }, [rawUrl]);

  return resolvedUrl;
}
