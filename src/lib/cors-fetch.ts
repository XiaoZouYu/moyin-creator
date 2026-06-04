// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
/**
 * CORS-safe fetch wrapper
 *
 * 自动检测运行环境：
 * - Electron 桌面模式 → 直接使用原生 fetch()（无 CORS 限制）
 * - 浏览器跨域请求   → 通过 /__api_proxy 或 VITE_WEB_API_PROXY_URL 代理转发
 * - 浏览器同源请求   → 直接使用原生 fetch()
 */

/** 检测是否在 Electron 环境中运行 */
function isElectron(): boolean {
  const electronWindow = typeof window !== 'undefined'
    ? window as Window & {
        electron?: unknown;
        ipcRenderer?: unknown;
        electronAPI?: unknown;
      }
    : undefined;

  return !!(
    electronWindow &&
    (
      electronWindow.electron ||
      electronWindow.ipcRenderer ||
      electronWindow.electronAPI ||
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

function getConfiguredProxyUrl(): string {
  return String(import.meta.env?.VITE_WEB_API_PROXY_URL || '').trim();
}

function shouldProxyUrl(targetUrl: string): boolean {
  if (!isHttpUrl(targetUrl) || typeof window === 'undefined') return false;

  if (getConfiguredProxyUrl()) return true;

  try {
    return new URL(targetUrl).origin !== window.location.origin;
  } catch {
    return false;
  }
}

function buildProxyUrl(targetUrl: string): string {
  const configuredProxy = getConfiguredProxyUrl();
  if (configuredProxy) {
    const proxyUrl = new URL(configuredProxy, window.location.origin);
    proxyUrl.searchParams.set('url', targetUrl);
    return proxyUrl.toString();
  }
  return `/__api_proxy?url=${encodeURIComponent(targetUrl)}`;
}

function headersToRecord(headers?: HeadersInit): Record<string, string> {
  const record: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

/**
 * CORS 安全的 fetch 封装
 *
 * 在浏览器中，自动将跨域请求代理到 `/__api_proxy` 或
 * `VITE_WEB_API_PROXY_URL`，由服务端转发请求以绕过 CORS 限制。
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

  // Electron、SSR、同源请求：直连
  if (isElectron() || typeof window === 'undefined' || !shouldProxyUrl(targetUrl)) {
    return fetch(targetUrl, init);
  }

  // 浏览器跨域请求：走服务端代理，避免生产 Web 版被 CORS 拦截。
  const proxyUrl = buildProxyUrl(targetUrl);
  let originalHeaders = headersToRecord(init?.headers);

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
  const contentType = response.headers.get('content-type') || '';
  const hasConfiguredProxy = !!getConfiguredProxyUrl();

  if (!hasConfiguredProxy && response.status === 404 && contentType.includes('text/html')) {
    throw new Error('Web API proxy /__api_proxy 不可用；请使用项目自带 web-server 部署，或配置 VITE_WEB_API_PROXY_URL');
  }

  if (!hasConfiguredProxy && response.ok && contentType.includes('text/html')) {
    throw new Error('Web API proxy /__api_proxy 返回了 HTML，说明当前静态服务器没有代理接口；请配置 VITE_WEB_API_PROXY_URL 或后端反向代理');
  }

  return response;
}
