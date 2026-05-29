import { defineConfig, type Plugin } from 'vite'
import path from 'node:path'
import electron from 'vite-plugin-electron/simple'
import react from '@vitejs/plugin-react'

/**
 * Vite 插件：API CORS 代理
 *
 * 在开发服务器上注册 /__api_proxy 中间件，
 * 将浏览器端的外部 API 请求由服务端转发，绕过 CORS 限制。
 *
 * 用法（前端）：
 *   fetch('/__api_proxy?url=' + encodeURIComponent('https://example.com/api'))
 */
function summarizeImage2Sse(text: string) {
  const eventTypes: string[] = [];
  const outputItems: Array<{ event: string; itemType: string; status?: string; hasResult: boolean }> = [];
  let hasPartial = false;
  let hasOutputItemResult = false;
  let hasCompletedResult = false;
  let completedOutputCount = 0;
  let outputTextPreview = '';
  let outputTextChars = 0;

  const trimmedText = text.trim();
  if (trimmedText.startsWith('{')) {
    try {
      const data = JSON.parse(trimmedText);
      const output = data.response?.output || data.output;
      if (Array.isArray(output)) {
        completedOutputCount = output.length;
        hasCompletedResult = output.some((item: any) => item?.type === 'image_generation_call' && !!item?.result);
        hasOutputItemResult = hasCompletedResult;
        for (const item of output.slice(0, 12)) {
          outputItems.push({
            event: 'json',
            itemType: String(item?.type || 'unknown'),
            status: item?.status ? String(item.status) : undefined,
            hasResult: !!item?.result,
          });
        }
      }
      const textValue = data.output_text || data.response?.output_text;
      if (typeof textValue === 'string') {
        outputTextChars = textValue.length;
        outputTextPreview = textValue.slice(0, 300);
      }
      return {
        bodyChars: text.length,
        eventTypes: ['json'],
        hasPartial,
        hasOutputItemResult,
        hasCompletedResult,
        completedOutputCount,
        outputItems,
        outputTextChars,
        outputTextPreview: outputTextPreview.trim(),
      };
    } catch {
      // Fall through to SSE parsing.
    }
  }

  for (const block of text.split(/\r?\n\r?\n/)) {
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim() || eventName;
        continue;
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) continue;

    const raw = dataLines.join('\n').trim();
    if (!raw || raw === '[DONE]') continue;

    try {
      const event = JSON.parse(raw);
      const type = typeof event.type === 'string' ? event.type : eventName;
      eventTypes.push(type);
      if (type === 'response.image_generation_call.partial_image' || event.partial_image_b64) {
        hasPartial = true;
      }
      if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
        outputTextChars += event.delta.length;
        if (outputTextPreview.length < 300) {
          outputTextPreview += event.delta;
        }
      }
      if (event.item?.type && outputItems.length < 12) {
        outputItems.push({
          event: type,
          itemType: String(event.item.type),
          status: event.item.status ? String(event.item.status) : undefined,
          hasResult: !!event.item.result,
        });
      }
      if (type === 'response.output_item.done' && event.item?.type === 'image_generation_call' && event.item?.result) {
        hasOutputItemResult = true;
      }
      const output = event.response?.output || event.output;
      if ((type === 'response.completed' || type === 'response.done') && Array.isArray(output)) {
        completedOutputCount = output.length;
        hasCompletedResult = output.some((item: any) => item?.type === 'image_generation_call' && !!item?.result);
        for (const item of output) {
          if (item?.type && outputItems.length < 12) {
            outputItems.push({
              event: type,
              itemType: String(item.type),
              status: item.status ? String(item.status) : undefined,
              hasResult: !!item.result,
            });
          }
        }
      }
    } catch {
      eventTypes.push('non-json');
    }
  }

  return {
    bodyChars: text.length,
    eventTypes,
    hasPartial,
    hasOutputItemResult,
    hasCompletedResult,
    completedOutputCount,
    outputItems,
    outputTextChars,
    outputTextPreview: outputTextPreview.trim(),
  };
}

function summarizeImage2RequestBody(body?: Buffer) {
  if (!body || body.length === 0) return {};
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    const firstInput = Array.isArray(parsed.input) ? parsed.input[0] : undefined;
    const content = Array.isArray(firstInput?.content) ? firstInput.content : [];
    const firstTool = Array.isArray(parsed.tools) ? parsed.tools[0] : undefined;
    return {
      model: parsed.model,
      stream: parsed.stream,
      store: parsed.store,
      toolChoice: parsed.tool_choice,
      toolModel: firstTool?.model,
      size: firstTool?.size,
      quality: firstTool?.quality,
      outputFormat: firstTool?.output_format,
      inputTextCount: content.filter((item: any) => item?.type === 'input_text').length,
      inputImageCount: content.filter((item: any) => item?.type === 'input_image').length,
    };
  } catch {
    return { bodyParseError: true, bodyBytes: body.length };
  }
}

type SerializedProxyFormField = {
  name: string;
  value?: string;
  fileName?: string;
  mimeType?: string;
  dataBase64?: string;
}

function cleanMultipartToken(value: string): string {
  return value.replace(/[\r\n"]/g, '_');
}

function removeContentHeaders(headers: Record<string, string>): Record<string, string> {
  const result = { ...headers };
  for (const key of Object.keys(result)) {
    const lower = key.toLowerCase();
    if (lower === 'content-type' || lower === 'content-length') {
      delete result[key];
    }
  }
  return result;
}

function encodeProxyFormData(fields: SerializedProxyFormField[]): { body: Buffer<ArrayBufferLike>; contentType: string } {
  const boundary = `----moyin-proxy-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer<ArrayBufferLike>[] = [];
  const pushText = (text: string) => chunks.push(Buffer.from(text, 'utf8'));

  for (const field of fields) {
    if (!field?.name) continue;
    const name = cleanMultipartToken(field.name);
    if (field.dataBase64 !== undefined) {
      const fileName = cleanMultipartToken(field.fileName || 'upload.bin');
      const mimeType = field.mimeType || 'application/octet-stream';
      pushText(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`);
      chunks.push(Buffer.from(field.dataBase64, 'base64'));
      pushText('\r\n');
      continue;
    }

    pushText(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${field.value ?? ''}\r\n`);
  }

  pushText(`--${boundary}--\r\n`);
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function apiCorsProxyPlugin(): Plugin {
  return {
    name: 'api-cors-proxy',
    configureServer(server) {
      server.middlewares.use('/__api_proxy', async (req, res) => {
        // 处理 OPTIONS 预检请求
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': '*',
          });
          res.end();
          return;
        }

        // 解析目标 URL
        const urlParam = new URL(req.url || '', 'http://localhost').searchParams.get('url');
        if (!urlParam) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing ?url= parameter' }));
          return;
        }

        try {
          // 读取请求体
          const bodyChunks: Buffer<ArrayBufferLike>[] = [];
          for await (const chunk of req) {
            bodyChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
          }
          let body: Buffer<ArrayBufferLike> | undefined = bodyChunks.length > 0 ? Buffer.concat(bodyChunks) : undefined;

          // 解包 x-proxy-headers 中的原始请求头
          const proxyHeadersRaw = req.headers['x-proxy-headers'];
          let forwardHeaders: Record<string, string> = {};
          if (typeof proxyHeadersRaw === 'string') {
            try {
              forwardHeaders = JSON.parse(proxyHeadersRaw);
            } catch { /* ignore parse errors */ }
          }

          if (req.headers['x-proxy-form-data'] === '1') {
            const fields = JSON.parse(body?.toString('utf8') || '[]') as SerializedProxyFormField[];
            const encoded = encodeProxyFormData(fields);
            forwardHeaders = removeContentHeaders(forwardHeaders);
            forwardHeaders['content-type'] = encoded.contentType;
            body = encoded.body;
          }

          // 服务端转发请求
          const response = await fetch(urlParam, {
            method: req.method || 'GET',
            headers: forwardHeaders,
            body: req.method !== 'GET' && req.method !== 'HEAD' ? body as unknown as BodyInit : undefined,
          });

          // 将远程响应转发回浏览器
          const respBody = await response.arrayBuffer();
          const responseBuffer = Buffer.from(respBody);
          const headers: Record<string, string> = {
            'Access-Control-Allow-Origin': '*',
          };
          // 转发 content-type
          const ct = response.headers.get('content-type');
          if (ct) headers['Content-Type'] = ct;

          if (/\/responses(?:[/?]|$)/i.test(urlParam)) {
            console.log('[api-cors-proxy] IMAGE2 responses summary', {
              url: urlParam,
              method: req.method || 'GET',
              status: response.status,
              statusText: response.statusText,
              contentType: ct,
              request: summarizeImage2RequestBody(body),
              response: summarizeImage2Sse(responseBuffer.toString('utf8')),
            });
          }

          res.writeHead(response.status, headers);
          res.end(responseBuffer);
        } catch (err: any) {
          console.error('[api-cors-proxy] Proxy error:', err?.message || err);
          res.writeHead(502, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(JSON.stringify({ error: 'Proxy request failed', detail: err?.message }));
        }
      });
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@opencut/ai-core/services/prompt-compiler': path.resolve(__dirname, './src/packages/ai-core/services/prompt-compiler.ts'),
      '@opencut/ai-core/api/task-poller': path.resolve(__dirname, './src/packages/ai-core/api/task-poller.ts'),
      '@opencut/ai-core/protocol': path.resolve(__dirname, './src/packages/ai-core/protocol/index.ts'),
      '@opencut/ai-core': path.resolve(__dirname, './src/packages/ai-core/index.ts'),
    },
  },
  plugins: [
    apiCorsProxyPlugin(),
    react(),
    electron({
      main: {
        // Shortcut of `build.lib.entry`.
        entry: 'electron/main.ts',
      },
      preload: {
        // Shortcut of `build.rollupOptions.input`.
        // Preload scripts may contain Web assets, so use the `build.rollupOptions.input` instead `build.lib.entry`.
        input: path.join(__dirname, 'electron/preload.ts'),
      },
      // Ployfill the Electron and Node.js API for Renderer process.
      // If you want use Node.js in Renderer process, the `nodeIntegration` needs to be enabled in the Main process.
      // See 👉 https://github.com/electron-vite/vite-plugin-electron-renderer
      renderer: process.env.NODE_ENV === 'test'
        // https://github.com/electron-vite/vite-plugin-electron-renderer/issues/78#issuecomment-2053600808
        ? undefined
        : {},
    }),
  ],
})
