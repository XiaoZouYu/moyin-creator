import { createReadStream, existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'

const PORT = Number(process.env.PORT || 8080)
const HOST = process.env.HOST || '0.0.0.0'
const DIST_DIR = resolve(process.env.DIST_DIR || join(process.cwd(), 'dist'))
const INDEX_HTML = join(DIST_DIR, 'index.html')
const MAX_PROXY_BODY_BYTES = Number(process.env.MAX_PROXY_BODY_BYTES || 50 * 1024 * 1024)

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  })
  res.end(JSON.stringify(body))
}

function cleanMultipartToken(value) {
  return String(value || '').replace(/[\r\n"]/g, '_')
}

function removeContentHeaders(headers) {
  const result = { ...headers }
  for (const key of Object.keys(result)) {
    const lower = key.toLowerCase()
    if (lower === 'content-type' || lower === 'content-length') {
      delete result[key]
    }
  }
  return result
}

function encodeProxyFormData(fields) {
  const boundary = `----moyin-proxy-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const chunks = []
  const pushText = (text) => chunks.push(Buffer.from(text, 'utf8'))

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

async function readRequestBody(req) {
  const chunks = []
  let total = 0

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_PROXY_BODY_BYTES) {
      throw new Error(`Request body exceeds ${MAX_PROXY_BODY_BYTES} bytes`)
    }
    chunks.push(buffer)
  }

  return Buffer.concat(chunks)
}

async function handleProxy(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers': '*',
    })
    res.end()
    return
  }

  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const targetUrl = requestUrl.searchParams.get('url')
  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    sendJson(res, 400, { error: 'Missing or invalid ?url= parameter' })
    return
  }

  try {
    let headers = {}
    const proxyHeaders = req.headers['x-proxy-headers']
    if (typeof proxyHeaders === 'string') {
      try {
        headers = JSON.parse(proxyHeaders)
      } catch {
        headers = {}
      }
    }

    let body = await readRequestBody(req)
    if (req.headers['x-proxy-form-data'] === '1') {
      const fields = JSON.parse(body.toString('utf8') || '[]')
      const encoded = encodeProxyFormData(fields)
      headers = removeContentHeaders(headers)
      headers['content-type'] = encoded.contentType
      body = encoded.body
    }

    const method = req.method || 'GET'
    const upstream = await fetch(targetUrl, {
      method,
      headers,
      body: method !== 'GET' && method !== 'HEAD' ? body : undefined,
    })

    const responseHeaders = {
      'access-control-allow-origin': '*',
    }
    const contentType = upstream.headers.get('content-type')
    if (contentType) responseHeaders['content-type'] = contentType
    const contentLength = upstream.headers.get('content-length')
    if (contentLength) responseHeaders['content-length'] = contentLength

    res.writeHead(upstream.status, responseHeaders)
    if (upstream.body) {
      const reader = upstream.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(Buffer.from(value))
      }
    }
    res.end()
  } catch (error) {
    sendJson(res, 502, {
      error: 'Proxy request failed',
      detail: error instanceof Error ? error.message : String(error),
      targetUrl,
    })
  }
}

function resolveStaticPath(pathname) {
  const decoded = decodeURIComponent(pathname.split('?')[0])
  const cleanPath = normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, '')
  const filePath = resolve(DIST_DIR, cleanPath.replace(/^\/+/, ''))
  if (filePath !== DIST_DIR && !filePath.startsWith(`${DIST_DIR}${sep}`)) {
    return null
  }
  return filePath
}

async function serveFile(res, filePath) {
  const fileStat = await stat(filePath)
  if (!fileStat.isFile()) return false

  const ext = extname(filePath).toLowerCase()
  const immutable = filePath.includes(`${sep}assets${sep}`)
  res.writeHead(200, {
    'content-type': MIME_TYPES[ext] || 'application/octet-stream',
    'content-length': fileStat.size,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  })
  createReadStream(filePath).pipe(res)
  return true
}

async function handleStatic(req, res) {
  try {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const filePath = resolveStaticPath(requestUrl.pathname)
    if (filePath && existsSync(filePath) && await serveFile(res, filePath)) return

    const index = await readFile(INDEX_HTML)
    res.writeHead(200, {
      'content-type': MIME_TYPES['.html'],
      'content-length': index.length,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    })
    res.end(index)
  } catch (error) {
    sendJson(res, 500, { error: 'Static file server failed', detail: error instanceof Error ? error.message : String(error) })
  }
}

const server = createServer((req, res) => {
  if ((req.url || '').startsWith('/__api_proxy')) {
    void handleProxy(req, res)
    return
  }

  if (req.method && !['GET', 'HEAD'].includes(req.method)) {
    sendJson(res, 405, { error: 'Method not allowed' })
    return
  }

  void handleStatic(req, res)
})

server.listen(PORT, HOST, () => {
  console.log(`[moyin-web] serving ${DIST_DIR} on http://${HOST}:${PORT}`)
})
