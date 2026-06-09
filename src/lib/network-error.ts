// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.

const RAW_NETWORK_FAILURE_PATTERNS = [
  /failed to fetch/i,
  /fetch failed/i,
  /load failed/i,
  /networkerror/i,
  /network error/i,
  /err_failed/i,
  /econnreset/i,
  /econnrefused/i,
  /etimedout/i,
  /socket hang up/i,
  /connection terminated/i,
];

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  return String(error || '');
}

export function isRawNetworkFailureMessage(message: string): boolean {
  return RAW_NETWORK_FAILURE_PATTERNS.some((pattern) => pattern.test(message));
}

export function normalizeNetworkErrorMessage(error: unknown, operation = '网络请求'): string {
  const message = getErrorMessage(error).trim();
  if (!message) return `${operation}失败：没有收到可用响应`;

  try {
    const data = JSON.parse(message) as { error?: unknown; detail?: unknown; message?: unknown };
    const detail = getErrorMessage(data.detail || data.message || data.error).trim();
    if (detail && detail !== message) {
      return normalizeNetworkErrorMessage(detail, operation);
    }
  } catch {
    // Not a JSON error body.
  }

  if (isRawNetworkFailureMessage(message)) {
    return `${operation}失败：请求已经走后端代理，但后端或浏览器没有拿到上游可用响应。常见原因是上游服务不可达、代理/Nginx 超时、DNS/证书错误或连接被重置。`;
  }

  return message;
}

export function normalizeError(error: unknown, operation = '网络请求'): Error {
  const normalized = normalizeNetworkErrorMessage(error, operation);
  if (error instanceof Error && error.message === normalized) return error;
  const next = new Error(normalized);
  if (error instanceof Error) {
    next.name = error.name;
    next.stack = error.stack;
    Object.assign(next, error);
  }
  return next;
}
