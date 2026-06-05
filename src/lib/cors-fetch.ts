// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
/**
 * CORS-safe fetch wrapper
 *
 * 自动检测运行环境：
 * - Electron 桌面模式 → 直接使用原生 fetch()（无 CORS 限制）
 * - 浏览器模式       → 对跨域 URL 通过 /__api_proxy 或 VITE_WEB_API_PROXY_URL 代理转发
 */

/** 检测是否在 Electron 环境中运行 */
function isElectron(): boolean {
  return !!(
    typeof window !== 'undefined' &&
    (
      (window as any).electron ||
      (window as any).ipcRenderer ||
      (window as any).electronAPI ||
      navigator.userAgent.includes('Electron')
    )
  );
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

async function serializeElectronBody(body: BodyInit | null | undefined): Promise<{
  body?: string;
  bodyBase64?: string;
  formData?: Array<{
    name: string;
    value?: string;
    fileName?: string;
    mimeType?: string;
    dataBase64?: string;
  }>;
}> {
  if (body === undefined || body === null) return {};
  if (typeof body === 'string') return { body };
  if (body instanceof URLSearchParams) return { body: body.toString() };
  if (body instanceof FormData) return { formData: await serializeFormData(body) };
  if (body instanceof Blob) return { bodyBase64: arrayBufferToBase64(await body.arrayBuffer()) };
  if (body instanceof ArrayBuffer) return { bodyBase64: arrayBufferToBase64(body) };
  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const copy = new Uint8Array(bytes);
    return { bodyBase64: arrayBufferToBase64(copy.buffer) };
  }
  return {};
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
 * CORS 安全的 fetch 封装
 *
 * 在浏览器模式下，自动将跨域 HTTP(S) 请求代理到 `/__api_proxy`
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

  if (typeof window !== 'undefined' && window.electronAPI?.apiFetch) {
    const requestHeaders = new Headers(init?.headers);
    const headers: Record<string, string> = {};
    requestHeaders.forEach((value, key) => {
      headers[key] = value;
    });

    const serializedBody = await serializeElectronBody(init?.body);
    const result = await window.electronAPI.apiFetch({
      url: targetUrl,
      method: init?.method,
      headers,
      ...serializedBody,
    });

    if (result.status === 0) {
      throw new TypeError(result.error || 'Electron main-process API request failed');
    }

    return new Response(result.body, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    });
  }

  // Electron 或同源/非 HTTP 请求：直连
  if (isElectron() || !shouldProxyUrl(targetUrl)) {
    return fetch(targetUrl, init);
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

  const response = await fetch(proxyUrl, proxyInit);
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
