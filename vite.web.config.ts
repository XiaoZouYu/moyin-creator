import { defineConfig, type Plugin } from 'vite'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { execFileSync } from 'node:child_process'
import httpsProxyAgent from 'https-proxy-agent'

const { HttpsProxyAgent } = httpsProxyAgent

let cachedSystemProxy: string | null | undefined

type SerializedProxyFormField = {
  name: string
  value?: string
  fileName?: string
  mimeType?: string
  dataBase64?: string
}

function cleanMultipartToken(value: string): string {
  return value.replace(/[\r\n"]/g, '_')
}

function removeContentHeaders(headers: Record<string, string>): Record<string, string> {
  const result = { ...headers }
  for (const key of Object.keys(result)) {
    const lower = key.toLowerCase()
    if (lower === 'content-type' || lower === 'content-length') {
      delete result[key]
    }
  }
  return result
}

function encodeProxyFormData(fields: SerializedProxyFormField[]): { body: Buffer; contentType: string } {
  const boundary = `----moyin-proxy-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const chunks: Buffer[] = []
  const pushText = (text: string) => chunks.push(Buffer.from(text, 'utf8'))

  for (const field of fields) {
    if (!field?.name) continue
    const name = cleanMultipartToken(field.name)
    if (field.dataBase64 !== undefined) {
      const fileName = cleanMultipartToken(field.fileName || 'upload.bin')
      const mimeType = field.mimeType || 'application/octet-stream'
      pushText(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`)
      chunks.push(Buffer.from(field.dataBase64, 'base64'))
      pushText('\r\n')
      continue
    }

    pushText(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${field.value ?? ''}\r\n`)
  }

  pushText(`--${boundary}--\r\n`)
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

function getEnvProxyUrl(targetUrl: string): string | null {
  const protocol = new URL(targetUrl).protocol
  const env = process.env
  const noProxy = env.NO_PROXY || env.no_proxy || ''
  const host = new URL(targetUrl).hostname
  if (noProxy.split(',').map((item) => item.trim()).filter(Boolean).some((entry) => host === entry || host.endsWith(entry.replace(/^\./, '')))) {
    return null
  }
  if (protocol === 'https:') {
    return env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy || null
  }
  return env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy || null
}

function getMacSystemProxyUrl(): string | null {
  if (process.platform !== 'darwin') return null
  if (cachedSystemProxy !== undefined) return cachedSystemProxy
  cachedSystemProxy = null

  try {
    const output = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 1500 })
    const enabled = output.match(/HTTPSEnable\s*:\s*1/)
    const host = output.match(/HTTPSProxy\s*:\s*([^\n]+)/)?.[1]?.trim()
    const port = output.match(/HTTPSPort\s*:\s*(\d+)/)?.[1]?.trim()
    if (enabled && host && port) {
      cachedSystemProxy = `http://${host}:${port}`
    }
  } catch {
    cachedSystemProxy = null
  }

  return cachedSystemProxy
}

function getProxyUrl(targetUrl: string): string | null {
  return getEnvProxyUrl(targetUrl) || getMacSystemProxyUrl()
}

function fetchViaProxy(
  targetUrl: string,
  method: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
  proxyUrl: string,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl)
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest
    const requestHeaders = { ...headers }
    if (body && !Object.keys(requestHeaders).some((key) => key.toLowerCase() === 'content-length')) {
      requestHeaders['content-length'] = String(body.length)
    }

    const req = request(url, {
      method,
      headers: requestHeaders,
      agent: new HttpsProxyAgent(proxyUrl),
    }, (proxyResponse) => {
      const chunks: Buffer[] = []
      proxyResponse.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      proxyResponse.on('end', () => {
        const responseHeaders = new Headers()
        for (const [key, value] of Object.entries(proxyResponse.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(key, item)
          } else if (value !== undefined) {
            responseHeaders.set(key, String(value))
          }
        }
        resolve(new Response(Buffer.concat(chunks), {
          status: proxyResponse.statusCode || 502,
          statusText: proxyResponse.statusMessage,
          headers: responseHeaders,
        }))
      })
    })

    req.on('error', reject)
    if (body && body.length > 0) req.write(body)
    req.end()
  })
}

async function fetchWithProxyFallback(
  targetUrl: string,
  method: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
): Promise<Response> {
  try {
    return await fetch(targetUrl, {
      method,
      headers,
      body: method !== 'GET' && method !== 'HEAD' ? body : undefined,
    })
  } catch (error) {
    const proxyUrl = getProxyUrl(targetUrl)
    if (!proxyUrl) throw error
    console.warn('[web-api-cors-proxy] Direct fetch failed, retrying via proxy', {
      targetUrl,
      proxyUrl,
      detail: error instanceof Error ? error.message : String(error),
    })
    return fetchViaProxy(
      targetUrl,
      method,
      headers,
      method !== 'GET' && method !== 'HEAD' ? body : undefined,
      proxyUrl,
    )
  }
}

function apiCorsProxyPlugin(): Plugin {
  async function handleProxyRequest(req: IncomingMessage, res: ServerResponse) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      })
      res.end()
      return
    }

    const targetUrl = new URL(req.url || '', 'http://localhost').searchParams.get('url')
    if (!targetUrl) {
      res.writeHead(400, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      })
      res.end(JSON.stringify({ error: 'Missing ?url= parameter' }))
      return
    }

    try {
      const bodyChunks: Buffer[] = []
      for await (const chunk of req) {
        bodyChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
      }

      let headers: Record<string, string> = {}
      const proxyHeaders = req.headers['x-proxy-headers']
      if (typeof proxyHeaders === 'string') {
        try {
          headers = JSON.parse(proxyHeaders)
        } catch {
          headers = {}
        }
      }

      let body = Buffer.concat(bodyChunks)
      if (req.headers['x-proxy-form-data'] === '1') {
        const fields = JSON.parse(body.toString('utf8')) as SerializedProxyFormField[]
        const encoded = encodeProxyFormData(fields)
        headers = removeContentHeaders(headers)
        headers['content-type'] = encoded.contentType
        body = encoded.body
      }

      const method = req.method || 'GET'
      const response = await fetchWithProxyFallback(targetUrl, method, headers, body.length > 0 ? body : undefined)

      const responseBuffer = Buffer.from(await response.arrayBuffer())
      const responseHeaders: Record<string, string> = {
        'Access-Control-Allow-Origin': '*',
      }
      const contentType = response.headers.get('content-type')
      if (contentType) responseHeaders['Content-Type'] = contentType

      res.writeHead(response.status, responseHeaders)
      res.end(responseBuffer)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[web-api-cors-proxy] Proxy request failed', {
        targetUrl,
        method: req.method || 'GET',
        detail: message,
      })
      res.writeHead(502, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      })
      res.end(JSON.stringify({ error: 'Proxy request failed', detail: message, targetUrl }))
    }
  }

  return {
    name: 'web-api-cors-proxy',
    configureServer(server) {
      server.middlewares.use('/__api_proxy', handleProxyRequest)
    },
    configurePreviewServer(server) {
      server.middlewares.use('/__api_proxy', handleProxyRequest)
    },
  }
}

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
  ],
})
