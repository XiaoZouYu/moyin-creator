// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
import { useCharacterLibraryStore } from "@/stores/character-library-store";
import { getFeatureConfig } from "@/lib/ai/feature-router";
import { imageUrlToBase64, submitGridImageRequest } from "@/lib/ai/image-generator";
import { mediaUrlToDataUrl, prepareImageReferencesForApi } from "@/lib/media-url-resolver";
import type { SplitScene, ShotSizeType } from "@/stores/director-store";

// Helper to normalize URL (handle array format)
export function normalizeUrl(url: unknown): string | undefined {
  if (!url) return undefined;
  if (Array.isArray(url)) return url[0] || undefined;
  if (typeof url === 'string') return url;
  return undefined;
}

// Process reference images to API-compatible format
export async function processReferenceImages(urls: string[], maxCount: number = 4): Promise<string[]> {
  return prepareImageReferencesForApi(urls, {
    maxCount,
    requireBase64DataUrl: true,
    logPrefix: 'ImageGen',
  });
}

// Get API configuration for image generation
export function getImageApiConfig() {
  return getFeatureConfig('character_generation');
}

// Collect character reference images (supports wardrobe variation mapping)
// Fallback chain: variation referenceImage → views[0] → skip
export function getCharacterReferenceImages(
  characterIds: string[],
  variationMap?: Record<string, string>,
): string[] {
  const { characters } = useCharacterLibraryStore.getState();
  const refs: string[] = [];
  
  for (const charId of characterIds) {
    const char = characters.find(c => c.id === charId);
    if (!char) continue;

    // 1. Check variation mapping
    const varId = variationMap?.[charId];
    if (varId) {
      const variation = char.variations?.find(v => v.id === varId);
      if (variation?.referenceImage) {
        refs.push(variation.referenceImage);
        continue;
      }
      // Variation not found or has no image → fallback to base
    }

    // 2. Fallback: base view
    const view = char.views[0];
    if (view) {
      const imageRef = view.imageBase64 || view.imageUrl;
      if (imageRef) {
        refs.push(imageRef);
      }
    }
    // 3. No image at all → skip this character
  }
  
  return refs;
}

// Call image generation API
export async function callImageGenerationApi(
  apiKey: string,
  prompt: string,
  aspectRatio: '16:9' | '9:16',
  referenceImages: string[] = [],
  onProgress?: (progress: number) => void,
  signal?: AbortSignal,
): Promise<{ imageUrl: string; httpUrl: string }> {
  const featureConfig = getImageApiConfig();
  if (!featureConfig) {
    throw new Error('请先在设置中配置图片生成服务映射');
  }
  const platform = featureConfig.platform;
  const model = featureConfig.models?.[0];
  if (!model) {
    throw new Error('请先在设置中配置图片生成模型');
  }
  const apiKeyToUse = apiKey || featureConfig.keyManager?.getCurrentKey?.() || '';
  if (!apiKeyToUse) {
    throw new Error('请先在设置中配置图片生成服务映射');
  }
  const imageBaseUrl = featureConfig.baseUrl?.replace(/\/+$/, '');
  if (!imageBaseUrl) {
    throw new Error('请先在设置中配置图片生成服务映射');
  }
  // Call image generation API with smart routing (auto-selects chat/completions or images/generations)
  const imageKeyManager = featureConfig.keyManager;
  const apiResult = await submitGridImageRequest({
    model,
    prompt,
    apiKey: apiKeyToUse,
    baseUrl: imageBaseUrl,
    providerPlatform: platform,
    aspectRatio,
    referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
    keyManager: imageKeyManager,
    signal,
    onProgress,
  });

  if (apiResult.imageUrl) {
    let finalImageUrl = apiResult.imageUrl;
    try {
      finalImageUrl = await imageUrlToBase64(apiResult.imageUrl);
    } catch (e) {
      console.warn('[ImageGen] Failed to convert to base64:', e);
    }
    return { imageUrl: finalImageUrl, httpUrl: apiResult.imageUrl };
  }

  throw new Error('后端图片任务完成但没有图片 URL');
}

// ===== Grid generation utilities =====
type Angle = 'Back View' | 'Over-the-Shoulder (OTS)' | 'POV' | 'Low Angle (Heroic)' | 'High Angle (Vulnerable)' | 'Dutch Angle (Tilted)';

export function allowedShotFromSize(shot?: ShotSizeType | null): string {
  switch (shot) {
    case 'ecu': return 'Extreme Close-up (ECU)';
    case 'cu':
    case 'mcu':
    case 'ms':
    case 'mls': return 'Upper Body Shot (Chest-up)';
    case 'ls': return 'Full Body Shot';
    case 'ws': return 'Wide Angle Full Shot';
    default: return 'Upper Body Shot (Chest-up)';
  }
}

export function allocateAngles(count: number, preselected: (string | undefined)[]): Angle[] {
  const result: Angle[] = new Array(count);
  const quotas: Record<Angle, number> = {
    'Back View': 2,
    'Over-the-Shoulder (OTS)': 3,
    'POV': 2,
    'Low Angle (Heroic)': 1,
    'High Angle (Vulnerable)': 1,
    'Dutch Angle (Tilted)': 0,
  };
  
  const normalize = (s?: string) => (s || '').toLowerCase();
  for (let i = 0; i < count; i++) {
    const u = normalize(preselected[i]);
    let matched: Angle | undefined;
    if (u.includes('over') && u.includes('shoulder')) matched = 'Over-the-Shoulder (OTS)';
    else if (u.includes('pov') || u.includes('point of view')) matched = 'POV';
    else if (u.includes('back')) matched = 'Back View';
    else if (u.includes('low angle')) matched = 'Low Angle (Heroic)';
    else if (u.includes('high angle')) matched = 'High Angle (Vulnerable)';
    else if (u.includes('dutch')) matched = 'Dutch Angle (Tilted)';
    if (matched) {
      result[i] = matched;
      quotas[matched] = Math.max(0, (quotas[matched] || 0) - 1);
    }
  }
  
  const fillOrder: Angle[] = [
    'Over-the-Shoulder (OTS)', 'POV', 'Back View',
    'Low Angle (Heroic)', 'High Angle (Vulnerable)', 'Dutch Angle (Tilted)'
  ];
  for (let i = 0; i < count; i++) {
    if (result[i]) continue;
    for (const angle of fillOrder) {
      if ((quotas[angle] || 0) > 0) {
        result[i] = angle;
        quotas[angle]!--;
        break;
      }
    }
    if (!result[i]) result[i] = 'Over-the-Shoulder (OTS)';
  }
  return result;
}

export function buildAnchorPhrase(_styleTokens?: string[]): string {
  // styleTokens 不再注入（校准后的 prompt 已包含风格描述，避免双重注入）
  const noTextConstraint = 'IMPORTANT: NO TEXT, NO WORDS, NO LETTERS, NO CAPTIONS, NO SPEECH BUBBLES, NO DIALOGUE BOXES, NO SUBTITLES, NO WRITING of any kind.';
  return `Keep character appearance, wardrobe and facial features consistent. Keep lighting and color grading consistent. ${noTextConstraint}`;
}

export function composeTilePrompt(scene: SplitScene, angle: Angle, aspect: '16:9'|'9:16', styleTokens?: string[]): string {
  const base = scene.imagePromptZh?.trim() || scene.imagePrompt?.trim() || scene.videoPromptZh?.trim() || scene.videoPrompt?.trim() || '';
  const shot = allowedShotFromSize(scene.shotSize);
  const vertical = aspect === '9:16' ? 'vertical composition, tighter framing, avoid letterboxing, ' : '';
  const cameraPart = `${angle}, ${shot}`;
  const anchor = buildAnchorPhrase(styleTokens);
  // styleTokens 不再末尾追加（校准后的 imagePrompt 已包含风格描述）
  
  const charCount = scene.characterIds?.length || 0;
  const charCountPhrase = charCount === 0 
    ? 'NO human figures in this frame, empty scene or environment only.' 
    : charCount === 1 
      ? 'EXACTLY ONE person in frame, single character only, do NOT duplicate the character.'
      : `EXACTLY ${charCount} distinct people in frame, no more no less, each person appears only ONCE.`;
  
  const prompt = `${cameraPart}, ${vertical}${charCountPhrase} ${base}. ${anchor}.`.replace(/\s+/g, ' ').trim();
  return prompt;
}

// Slice grid image into individual tiles
export async function sliceGridImage(gridImageUrl: string, count: number): Promise<string[]> {
  const cols = 3;
  const rows = Math.ceil(count / cols);
  const imageSource = await mediaUrlToDataUrl(gridImageUrl);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const tileW = Math.floor(img.width / cols);
      const tileH = Math.floor(img.height / rows);
      const results: string[] = [];
      
      for (let i = 0; i < count; i++) {
        const row = Math.floor(i / cols);
        const col = i % cols;
        const canvas = document.createElement('canvas');
        canvas.width = tileW;
        canvas.height = tileH;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, col * tileW, row * tileH, tileW, tileH, 0, 0, tileW, tileH);
        results.push(canvas.toDataURL('image/png'));
      }
      resolve(results);
    };
    img.onerror = () => reject(new Error('加载九宫格图片失败'));
    img.src = imageSource;
  });
}

// Build grid prompt for batch generation
export function buildGridPrompt(
  scenes: SplitScene[],
  isEndFrame: boolean,
  styleTokens: string[]
): string {
  const cols = 3;
  const rows = Math.ceil(scenes.length / cols);
  
  const gridPromptParts: string[] = [];
  gridPromptParts.push(`Generate a ${rows}x${cols} grid image with ${scenes.length} panels, each panel separated by thin white lines.`);
  gridPromptParts.push(`Layout: ${rows} rows, ${cols} columns, reading order left-to-right, top-to-bottom.`);
  
  scenes.forEach((s, idx) => {
    const row = Math.floor(idx / cols) + 1;
    const col = (idx % cols) + 1;
    let desc = '';
    if (isEndFrame) {
      desc = s.endFramePromptZh?.trim() || s.endFramePrompt?.trim() || (s.imagePromptZh || s.imagePrompt || '') + ' end state';
    } else {
      desc = s.imagePromptZh?.trim() || s.imagePrompt?.trim() || s.videoPromptZh?.trim() || s.videoPrompt?.trim() || `scene ${idx + 1}`;
    }
    const charCount = s.characterIds?.length || 0;
    const charConstraint = charCount === 0 
      ? '(no people)' 
      : charCount === 1 
        ? '(exactly 1 person, do NOT duplicate)' 
        : `(exactly ${charCount} distinct people, each appears once)`;
    gridPromptParts.push(`Panel [row ${row}, col ${col}] ${charConstraint}: ${desc}`);
  });
  
  // styleTokens 不再注入（校准后的各 panel prompt 已包含风格描述）
  gridPromptParts.push('Keep consistent character appearance, lighting, and color grading across all panels.');
  gridPromptParts.push('CRITICAL: NO TEXT, NO WORDS, NO LETTERS, NO CAPTIONS, NO SPEECH BUBBLES, NO DIALOGUE BOXES, NO SUBTITLES in any panel.');
  
  return gridPromptParts.join(' ');
}
