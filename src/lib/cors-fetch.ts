// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
/**
 * CORS-safe fetch wrapper
 *
 * Web 运行时：
 * - 同源/非 HTTP 请求 → 直接使用 fetch()
 * - 跨域 HTTP(S) 请求 → 通过 /__api_proxy 或 VITE_WEB_API_PROXY_URL 代理转发
 */

import { normalizeNetworkErrorMessage } from '@/lib/network-error';

const nativeFetch = globalThis.fetch?.bind(globalThis);
const GUARDED_FETCH_MARKER = '__moyinCreatorGuardedFetch';

function getNativeFetch(): typeof fetch {
  if (!nativeFetch) {
    throw new Error('当前运行环境不支持 fetch');
  }
  return nativeFetch;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function summarizeFetchTarget(targetUrl: string): string {
  try {
    const url = new URL(targetUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return targetUrl.slice(0, 120);
  }
}

function getRequestMethod(init?: RequestInit): string {
  return (init?.method || 'GET').toUpperCase();
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
    || error instanceof Error && error.name === 'AbortError';
}

function getFriendlyFetchFailure(error: unknown): string {
  return normalizeNetworkErrorMessage(error, '网络请求');
}

function createDirectFetchError(targetUrl: string, init: RequestInit | undefined, error: unknown): Error {
  return new Error(
    `网络请求失败：${getRequestMethod(init)} ${summarizeFetchTarget(targetUrl)}。${getFriendlyFetchFailure(error)}`,
  );
}

function createProxyFetchError(
  targetUrl: string,
  proxyUrl: string,
  init: RequestInit | undefined,
  error: unknown,
): Error {
  const configuredProxy = import.meta.env?.VITE_WEB_API_PROXY_URL;
  const target = `${getRequestMethod(init)} ${summarizeFetchTarget(targetUrl)}`;
  const reason = getFriendlyFetchFailure(error);
  return new Error(
    configuredProxy
      ? `跨域代理请求失败：${target}。代理 ${summarizeFetchTarget(proxyUrl)} 不可用或未正确允许 CORS/OPTIONS。${reason}`
      : `跨域代理 /__api_proxy 请求失败：${target}。请确认正式环境使用 scripts/web-server.mjs/Docker 服务，或配置 VITE_WEB_API_PROXY_URL。${reason}`,
  );
}

async function serializeFormData(formData: FormData): Promise<Array<{
  name: string;
  value?: string;
  fileName?: string;
  mimeType?: string;
  dataBase64?: string;
}>> {
  const fields: Array<{
    name: string;
    value?: string;
    fileName?: string;
    mimeType?: string;
    dataBase64?: string;
  }> = [];

  for (const [name, value] of formData.entries()) {
    if (typeof value === 'string') {
      fields.push({ name, value });
      continue;
    }

    fields.push({
      name,
      fileName: value instanceof File ? value.name : 'upload.bin',
      mimeType: value.type || 'application/octet-stream',
      dataBase64: arrayBufferToBase64(await value.arrayBuffer()),
    });
  }

  return fields;
}

function removeContentType(headers: Record<string, string>): Record<string, string> {
  const result = { ...headers };
  for (const key of Object.keys(result)) {
    if (key.toLowerCase() === 'content-type') {
      delete result[key];
    }
  }
  return result;
}

function isHttpUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

function shouldProxyUrl(targetUrl: string): boolean {
  if (!isHttpUrl(targetUrl)) return false;
  if (typeof window === 'undefined') return false;
  if (import.meta.env?.VITE_WEB_API_PROXY_URL) return true;
  try {
    return new URL(targetUrl).origin !== window.location.origin;
  } catch {
    return false;
  }
}

function buildProxyUrl(targetUrl: string): string {
  const configuredProxy = import.meta.env?.VITE_WEB_API_PROXY_URL;
  if (configuredProxy && typeof window !== 'undefined') {
    const proxyUrl = new URL(configuredProxy, window.location.origin);
    proxyUrl.searchParams.set('url', targetUrl);
    return proxyUrl.toString();
  }
  return `/__api_proxy?url=${encodeURIComponent(targetUrl)}`;
}

/**
 * Web CORS 安全 fetch 封装
 *
 * 自动将跨域 HTTP(S) 请求代理到 `/__api_proxy`
 * 或 VITE_WEB_API_PROXY_URL，由服务端转发请求以绕过 CORS 限制。
 *
 * @param url    目标 URL（与原生 fetch 参数相同）
 * @param init   请求选项（与原生 fetch 参数相同）
 * @returns      Response（与原生 fetch 返回值相同）
 */
export async function corsFetch(
  url: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const targetUrl = url.toString();

  // 同源/非 HTTP 请求：直连
  if (!shouldProxyUrl(targetUrl)) {
    try {
      return await getNativeFetch()(targetUrl, init);
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw createDirectFetchError(targetUrl, init, error);
    }
  }

  // 浏览器模式：跨域请求统一走代理，避免外部图片/图床/API CORS 失败
  const proxyUrl = buildProxyUrl(targetUrl);

  // 将原始 headers 序列化到 x-proxy-headers 头中
  // 这样代理中间件可以把它们转发给目标服务器
  const proxyHeaders = new Headers(init?.headers);

  // 把原始 headers 打包进一个特殊头，代理端负责解包
  let originalHeaders: Record<string, string> = {};
  proxyHeaders.forEach((value, key) => {
    originalHeaders[key] = value;
  });

  const transportHeaders: Record<string, string> = {};
  let proxyBody = init?.body;
  if (init?.body instanceof FormData) {
    originalHeaders = removeContentType(originalHeaders);
    transportHeaders['x-proxy-form-data'] = '1';
    transportHeaders['content-type'] = 'application/json';
    proxyBody = JSON.stringify(await serializeFormData(init.body));
  }
  transportHeaders['x-proxy-headers'] = JSON.stringify(originalHeaders);

  const proxyInit: RequestInit = {
    ...init,
    headers: transportHeaders,
    body: proxyBody,
  };

  let response: Response;
  try {
    response = await getNativeFetch()(proxyUrl, proxyInit);
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw createProxyFetchError(targetUrl, proxyUrl, init, error);
  }
  const configuredProxy = import.meta.env?.VITE_WEB_API_PROXY_URL;
  const contentType = response.headers.get('content-type') || '';
  if (!configuredProxy && response.status === 404 && contentType.includes('text/html')) {
    throw new Error('跨域代理 /__api_proxy 不可用，请检查线上反向代理配置');
  }
  if (!configuredProxy && response.ok && contentType.includes('text/html')) {
    throw new Error('跨域代理 /__api_proxy 返回 HTML，请检查线上反向代理配置');
  }
  return response;
}

async function requestToCorsFetch(input: Request, init?: RequestInit): Promise<Response> {
  const method = init?.method || input.method;
  const headers = init?.headers || input.headers;
  const shouldReadBody = method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD';
  const body = init?.body ?? (shouldReadBody ? await input.clone().blob() : undefined);

  return corsFetch(input.url, {
    ...init,
    method,
    headers,
    body,
    signal: init?.signal || input.signal,
  });
}

export function installGlobalFetchGuard(): void {
  if (typeof window === 'undefined') return;
  const currentFetch = window.fetch as typeof fetch & { [GUARDED_FETCH_MARKER]?: true };
  if (currentFetch?.[GUARDED_FETCH_MARKER]) return;

  const guardedFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (input instanceof Request) {
      return requestToCorsFetch(input, init);
    }
    return corsFetch(input instanceof URL ? input : String(input), init);
  }) as typeof fetch & { [GUARDED_FETCH_MARKER]?: true };

  guardedFetch[GUARDED_FETCH_MARKER] = true;
  window.fetch = guardedFetch;
}
