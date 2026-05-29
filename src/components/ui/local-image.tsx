// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
"use client";

/**
 * LocalImage Component
 * Handles displaying images that may be stored locally (local-image://) or remotely
 * The local-image:// protocol is handled by Electron's custom protocol handler
 */

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useResolvedImageUrl } from "@/hooks/use-resolved-image-url";

interface LocalImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  src: string;
  fallback?: string;
}

export function LocalImage({ src, fallback, className, alt, ...props }: LocalImageProps) {
  const [useFallback, setUseFallback] = useState(false);
  const resolvedSrc = useResolvedImageUrl(src);
  const resolvedFallback = useResolvedImageUrl(fallback);
  const currentSrc = useFallback ? resolvedFallback : resolvedSrc;

  useEffect(() => {
    setUseFallback(false);
  }, [src]);

  const handleError = () => {
    setUseFallback(true);
  };

  if ((useFallback && !fallback) || !currentSrc) {
    return (
      <div 
        className={cn(
          "flex items-center justify-center bg-muted text-muted-foreground text-xs",
          className
        )}
        style={props.style}
      >
        图片加载失败
      </div>
    );
  }

  return (
    <img
      src={currentSrc}
      alt={alt}
      className={className}
      onError={handleError}
      {...props}
    />
  );
}
