// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.

export type ProviderMediaKind = 'image' | 'video' | 'audio' | 'media';
export type ProviderOperationStage = 'prepare' | 'download' | 'submit' | 'poll' | 'parse';
export type ProviderErrorCategory =
  | 'auth'
  | 'quota'
  | 'rate_limit'
  | 'content_moderation'
  | 'bad_request'
  | 'not_found'
  | 'server'
  | 'transport'
  | 'unknown';

export interface ProviderErrorContext {
  mediaKind: ProviderMediaKind;
  stage: ProviderOperationStage;
  status?: number;
  errorText?: string;
  provider?: string;
  model?: string;
  route?: string;
  fallbackMessage?: string;
  originalError?: unknown;
}

export interface ProviderErrorDetails {
  category: ProviderErrorCategory;
  status?: number;
  code?: string;
  rawMessage?: string;
  message: string;
}

type ProviderError = Error & {
  status?: number;
  code?: string;
  category?: ProviderErrorCategory;
  providerStage?: ProviderOperationStage;
};

const AUTH_KEYWORDS = [
  'authentication',
  'unauthenticated',
  'unauthorized',
  'forbidden',
  'permission denied',
  'invalid api key',
  'incorrect api key',
  'api key format is incorrect',
  'apikey',
  'api_key',
  'api key',
  'access token',
  'bearer token',
  '认证',
  '鉴权',
  '密钥',
  '未授权',
  '认证失败',
  '鉴权失败',
  'api key 无效',
  'api key 已过期',
  'key 无效',
  'key 已过期',
  '密钥无效',
  '密钥已过期',
] as const;

const QUOTA_KEYWORDS = [
  'accountoverdue',
  'overdue balance',
  'insufficient_quota',
  'insufficient quota',
  'quota exceeded',
  '余额不足',
  '欠费',
  '额度不足',
] as const;

const RATE_LIMIT_KEYWORDS = [
  'rate limit',
  'too many requests',
  'resource_exhausted',
  'qps',
  '请求过于频繁',
  '限流',
] as const;

const CONTENT_MODERATION_KEYWORDS = [
  'moderation',
  'content_sensitive',
  'sensitive',
  'policy',
  'refused',
  'rejected',
  'inappropriate',
  'blocked',
  'prohibited',
  'not_allowed',
  'unsafe',
  '内容审核',
  '违规',
  '敏感',
  '禁止',
  '拒绝',
  '不合规',
] as const;

function includesAny(value: string, keywords: readonly string[]): boolean {
  const lower = value.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword.toLowerCase()));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(record: Record<string, unknown> | null | undefined, key: string): string | undefined {
  if (!record) return undefined;
  const value = record[key];
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number') return String(value);
  return undefined;
}

function firstString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

function parseProviderErrorBody(errorText?: string): { code?: string; message?: string } {
  if (!errorText?.trim()) return {};
  try {
    const data = JSON.parse(errorText);
    const root = asRecord(data);
    const error = asRecord(root?.error);
    const dataRecord = asRecord(root?.data);
    const dataError = asRecord(dataRecord?.error);
    const response = asRecord(root?.response);
    const responseError = asRecord(response?.error);
    const result = asRecord(root?.result);
    const resultError = asRecord(result?.error);

    return {
      code: firstString(
        error?.code,
        root?.code,
        dataError?.code,
        responseError?.code,
        resultError?.code,
        stringField(dataRecord, 'code'),
      ),
      message: firstString(
        error?.message,
        root?.message,
        root?.msg,
        dataError?.message,
        stringField(dataRecord, 'message'),
        responseError?.message,
        resultError?.message,
        root?.detail,
      ),
    };
  } catch {
    const compact = errorText.trim().replace(/\s+/g, ' ');
    return compact ? { message: compact.slice(0, 500) } : {};
  }
}

function getOriginalErrorMessage(error: unknown): string | undefined {
  if (!error) return undefined;
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

function classifyProviderError(status: number | undefined, code: string | undefined, rawMessage: string): ProviderErrorCategory {
  const normalized = `${code || ''} ${rawMessage}`.toLowerCase();
  if (status === 401 || status === 403 || includesAny(normalized, AUTH_KEYWORDS)) return 'auth';
  if (includesAny(normalized, QUOTA_KEYWORDS)) return 'quota';
  if (status === 429 || includesAny(normalized, RATE_LIMIT_KEYWORDS)) return 'rate_limit';
  if (includesAny(normalized, CONTENT_MODERATION_KEYWORDS)) return 'content_moderation';
  if (status === 404) return 'not_found';
  if (status && status >= 500) return 'server';
  if (status && status >= 400) return 'bad_request';
  if (!status && rawMessage) return 'transport';
  return 'unknown';
}

export function normalizeProviderError(context: ProviderErrorContext): ProviderErrorDetails {
  const parsed = parseProviderErrorBody(context.errorText);
  const originalMessage = getOriginalErrorMessage(context.originalError);
  const rawMessage = context.errorText?.trim() || originalMessage || context.fallbackMessage || parsed.message || '';
  const category = classifyProviderError(context.status, parsed.code, rawMessage);

  return {
    category,
    status: context.status,
    code: parsed.code,
    rawMessage,
    message: rawMessage || `HTTP ${context.status ?? 'unknown'}`,
  };
}

export function createProviderError(context: ProviderErrorContext): ProviderError {
  const normalized = normalizeProviderError(context);
  const error = new Error(normalized.message) as ProviderError;
  error.status = normalized.status;
  error.code = normalized.code;
  error.category = normalized.category;
  error.providerStage = context.stage;
  return error;
}

export async function throwUpstreamResponseError(response: Response): Promise<never> {
  const errorText = await response.text();
  const error = new Error(errorText.trim() || `HTTP ${response.status}`) as ProviderError;
  error.status = response.status;
  throw error;
}

export function isProviderContentModerationError(error: unknown): boolean {
  const err = error as Partial<ProviderError> | undefined;
  if (err?.category === 'content_moderation') return true;
  const message = error instanceof Error ? error.message : String(error || '');
  return includesAny(message, CONTENT_MODERATION_KEYWORDS);
}
