// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.

const VIDEO_PROMPT_SECTION_LABELS = [
  'Camera',
  'Lighting',
  'Subject',
  'Mood',
  'Narrative purpose',
  'Shot intent',
  'Atmosphere',
  'Setting',
  'Dialogue',
  'Ambient',
  'SFX',
  'Music',
  'Style',
] as const;

function compactText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function truncateCaption(value: string, maxLength = 900): string {
  const compacted = compactText(value);
  if (compacted.length <= maxLength) return compacted;
  return compacted.slice(0, maxLength - 1).trimEnd();
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function extractSection(prompt: string, label: string): string {
  const marker = `${label}:`;
  const start = prompt.indexOf(marker);
  if (start < 0) return '';

  const contentStart = start + marker.length;
  let contentEnd = prompt.length;
  for (const nextLabel of VIDEO_PROMPT_SECTION_LABELS) {
    if (nextLabel === label) continue;
    const nextMarker = `. ${nextLabel}:`;
    const nextIndex = prompt.indexOf(nextMarker, contentStart);
    if (nextIndex >= 0 && nextIndex < contentEnd) {
      contentEnd = nextIndex;
    }
  }

  return compactText(prompt.slice(contentStart, contentEnd).replace(/\.$/, ''));
}

function firstNonEmpty(...values: string[]): string {
  return values.map(compactText).find(Boolean) || '';
}

export function shouldRetryWithStructuredCaptionPrompt(errorText: string): boolean {
  const normalized = errorText.toLowerCase();
  return normalized.includes('style_caption') && normalized.includes('prompt format');
}

/**
 * Some Volc-compatible video models validate prompt as structured JSON captions.
 * Keep the natural language prompt as dense_caption/prompt while adding the
 * required caption fields so models that demand `style_caption` can parse it.
 */
export function ensureStructuredCaptionVideoPrompt(prompt: string): string {
  const trimmed = compactText(prompt);
  const existing = parseJsonObject(trimmed);

  if (existing) {
    const dense = firstNonEmpty(
      compactText(existing.dense_caption),
      compactText(existing.prompt),
      trimmed,
    );
    return JSON.stringify({
      ...existing,
      main_object_caption: firstNonEmpty(compactText(existing.main_object_caption), compactText(existing.subject_caption), dense),
      action_caption: firstNonEmpty(compactText(existing.action_caption), compactText(existing.motion_caption), dense),
      background_caption: firstNonEmpty(compactText(existing.background_caption), compactText(existing.scene_caption), dense),
      camera_caption: firstNonEmpty(compactText(existing.camera_caption), dense),
      style_caption: firstNonEmpty(compactText(existing.style_caption), 'cinematic, coherent visual style, high quality video'),
      dense_caption: dense,
      prompt: firstNonEmpty(compactText(existing.prompt), dense),
    });
  }

  const camera = extractSection(trimmed, 'Camera');
  const lighting = extractSection(trimmed, 'Lighting');
  const subject = extractSection(trimmed, 'Subject');
  const mood = extractSection(trimmed, 'Mood');
  const narrative = extractSection(trimmed, 'Narrative purpose');
  const shotIntent = extractSection(trimmed, 'Shot intent');
  const atmosphere = extractSection(trimmed, 'Atmosphere');
  const setting = extractSection(trimmed, 'Setting');
  const style = extractSection(trimmed, 'Style');

  const dense = truncateCaption(trimmed, 1800);
  const mainObject = firstNonEmpty(subject, shotIntent, dense);
  const action = firstNonEmpty(subject, narrative, mood, dense);
  const background = firstNonEmpty([setting, atmosphere].filter(Boolean).join(', '), dense);
  const cameraCaption = firstNonEmpty(camera, shotIntent, dense);
  const styleCaption = firstNonEmpty([style, lighting].filter(Boolean).join(', '), 'cinematic, coherent visual style, high quality video');

  return JSON.stringify({
    main_object_caption: truncateCaption(mainObject),
    action_caption: truncateCaption(action),
    background_caption: truncateCaption(background),
    camera_caption: truncateCaption(cameraCaption),
    style_caption: truncateCaption(styleCaption),
    dense_caption: dense,
    prompt: dense,
  });
}
