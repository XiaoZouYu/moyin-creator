import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import httpsProxyAgent from 'https-proxy-agent'

const { HttpsProxyAgent } = httpsProxyAgent

const MAX_TASK_BODY_BYTES = Number(process.env.MAX_GENERATION_TASK_BODY_BYTES || 50 * 1024 * 1024)
const MAX_CACHED_MEDIA_BYTES = Number(process.env.MAX_GENERATION_TASK_MEDIA_BYTES || 500 * 1024 * 1024)
const DEFAULT_TASK_TIMEOUT_MS = Number(process.env.GENERATION_TASK_TIMEOUT_MS || 10 * 60 * 1000)
const DEFAULT_POLL_INTERVAL_MS = Number(process.env.GENERATION_TASK_POLL_INTERVAL_MS || 2_000)
const SUBMIT_TIMEOUT_MS = Number(process.env.GENERATION_TASK_SUBMIT_TIMEOUT_MS || 120_000)
const POLL_REQUEST_TIMEOUT_MS = Number(process.env.GENERATION_TASK_POLL_REQUEST_TIMEOUT_MS || 60_000)
const MEDIA_FETCH_TIMEOUT_MS = Number(process.env.GENERATION_TASK_MEDIA_FETCH_TIMEOUT_MS || 120_000)
const TASK_RETENTION_MS = Number(process.env.GENERATION_TASK_RETENTION_MS || 60 * 60 * 1000)
const TASK_STORE_DIR = resolve(process.env.GENERATION_TASK_STORE_DIR || join(process.cwd(), '.cache', 'generation-tasks'))
const TASK_MEDIA_DIR = join(TASK_STORE_DIR, 'media')
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'timeout'])

const tasks = new Map()
let cachedSystemProxy

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers': '*',
  })
  res.end(JSON.stringify(body))
}

async function sendBinary(req, res, task) {
  if (task.media?.buffer) {
    res.writeHead(200, {
      'content-type': task.media.mimeType || 'application/octet-stream',
      'content-length': String(req.method === 'HEAD' ? 0 : task.media.buffer.length),
      'cache-control': 'public, max-age=31536000, immutable',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'access-control-allow-headers': '*',
      'x-content-type-options': 'nosniff',
    })
    res.end(req.method === 'HEAD' ? undefined : task.media.buffer)
    return
  }

  if (task.media?.path) {
    const mediaStat = await stat(task.media.path)
    res.writeHead(200, {
      'content-type': task.media.mimeType || 'application/octet-stream',
      'content-length': String(req.method === 'HEAD' ? 0 : mediaStat.size),
      'cache-control': 'public, max-age=31536000, immutable',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'access-control-allow-headers': '*',
      'x-content-type-options': 'nosniff',
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(task.media.path).pipe(res)
    return
  }

  if (!task.result?.mediaUrl) {
    sendJson(res, 404, { error: 'Task media is not available' })
    return
  }

  sendJson(res, 404, { error: 'Task media is not cached locally', mediaUrl: task.result.mediaUrl })
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || '')
}

function publicTask(task) {
  return {
    id: task.id,
    kind: task.kind,
    label: task.label,
    status: task.status,
    progress: task.progress,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    timeoutMs: task.timeoutMs,
    upstreamTaskId: task.upstreamTaskId,
    upstreamStatus: task.upstreamStatus,
    result: task.result,
    error: task.error,
  }
}

function taskJsonPath(taskId) {
  return join(TASK_STORE_DIR, `${taskId}.json`)
}

function taskMediaPath(task, mimeType = '') {
  return join(TASK_MEDIA_DIR, `${task.id}.${extensionForKind(task.kind, mimeType)}`)
}

function serializableTask(task) {
  const media = task.media
    ? {
        mimeType: task.media.mimeType,
        size: task.media.size || task.media.buffer?.length || 0,
        path: task.media.path,
      }
    : undefined
  return {
    ...task,
    media,
  }
}

async function ensureTaskStore() {
  await mkdir(TASK_MEDIA_DIR, { recursive: true })
}

async function persistTask(task) {
  await ensureTaskStore()
  const jsonPath = taskJsonPath(task.id)
  const tmpPath = `${jsonPath}.tmp`
  await writeFile(tmpPath, JSON.stringify(serializableTask(task), null, 2))
  await rename(tmpPath, jsonPath)
}

async function removePersistedTask(task) {
  await rm(taskJsonPath(task.id), { force: true }).catch(() => undefined)
  if (task.media?.path) {
    await rm(task.media.path, { force: true }).catch(() => undefined)
  }
}

async function persistTaskMedia(task, media) {
  await ensureTaskStore()
  const path = taskMediaPath(task, media.mimeType)
  await writeFile(path, media.buffer)
  return path
}

async function readRequestBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_TASK_BODY_BYTES) {
      throw new Error(`Request body exceeds ${MAX_TASK_BODY_BYTES} bytes`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

async function readJsonBody(req) {
  const body = await readRequestBody(req)
  if (body.length === 0) return {}
  return JSON.parse(body.toString('utf8'))
}

function cleanMultipartToken(value) {
  return String(value || '').replace(/[\r\n"]/g, '_')
}

function removeContentHeaders(headers) {
  const result = { ...headers }
  for (const key of Object.keys(result)) {
    const lower = key.toLowerCase()
    if (lower === 'content-type' || lower === 'content-length') delete result[key]
  }
  return result
}

function encodeProxyFormData(fields) {
  const boundary = `----moyin-task-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const chunks = []
  const pushText = (text) => chunks.push(Buffer.from(text, 'utf8'))

  for (const field of fields || []) {
    if (!field?.name) continue
    const name = cleanMultipartToken(field.name)
    if (field.dataBase64 !== undefined) {
      const fileName = cleanMultipartToken(field.fileName || 'upload.bin')
      const mimeType = field.mimeType || 'application/octet-stream'
      const payload = String(field.dataBase64).includes(',')
        ? String(field.dataBase64).slice(String(field.dataBase64).indexOf(',') + 1)
        : String(field.dataBase64)
      pushText(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`)
      chunks.push(Buffer.from(payload, 'base64'))
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

function requestOrigin(req) {
  if (!req) return ''
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim()
  const proto = forwardedProto || (req.socket?.encrypted ? 'https' : 'http')
  const host = forwardedHost || req.headers.host || 'localhost'
  return `${proto}://${host}`
}

function taskOrigin(req, task) {
  return task.origin || requestOrigin(req) || 'http://localhost'
}

function getEnvProxyUrl(targetUrl) {
  const url = new URL(targetUrl)
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || ''
  const host = url.hostname
  const shouldBypass = noProxy
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .some((entry) => host === entry || host.endsWith(entry.replace(/^\./, '')))
  if (shouldBypass) return null
  if (url.protocol === 'https:') {
    return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy || null
  }
  return process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy || null
}

function getMacSystemProxyUrl() {
  if (process.platform !== 'darwin') return null
  if (cachedSystemProxy !== undefined) return cachedSystemProxy
  cachedSystemProxy = null
  try {
    const output = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 1500 })
    const enabled = output.match(/HTTPSEnable\s*:\s*1/)
    const host = output.match(/HTTPSProxy\s*:\s*([^\n]+)/)?.[1]?.trim()
    const port = output.match(/HTTPSPort\s*:\s*(\d+)/)?.[1]?.trim()
    if (enabled && host && port) cachedSystemProxy = `http://${host}:${port}`
  } catch {
    cachedSystemProxy = null
  }
  return cachedSystemProxy
}

function getProxyUrl(targetUrl) {
  return getEnvProxyUrl(targetUrl) || getMacSystemProxyUrl()
}

function fetchViaProxy(targetUrl, method, headers, body, proxyUrl) {
  return new Promise((resolveResponse, rejectResponse) => {
    const url = new URL(targetUrl)
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest
    const requestHeaders = { ...headers }
    if (body && !Object.keys(requestHeaders).some((key) => key.toLowerCase() === 'content-length')) {
      requestHeaders['content-length'] = String(body.length)
    }

    const proxyRequest = request(url, {
      method,
      headers: requestHeaders,
      agent: new HttpsProxyAgent(proxyUrl),
    }, (proxyResponse) => {
      const chunks = []
      proxyResponse.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      proxyResponse.on('end', () => {
        const responseHeaders = new Headers()
        for (const [key, value] of Object.entries(proxyResponse.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(key, item)
          } else if (value !== undefined) {
            responseHeaders.set(key, String(value))
          }
        }
        resolveResponse(new Response(Buffer.concat(chunks), {
          status: proxyResponse.statusCode || 502,
          statusText: proxyResponse.statusMessage,
          headers: responseHeaders,
        }))
      })
    })

    proxyRequest.on('error', rejectResponse)
    if (body && body.length > 0) proxyRequest.write(body)
    proxyRequest.end()
  })
}

async function fetchWithProxyFallback(targetUrl, method, headers, body, timeoutMs) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(targetUrl, {
      method,
      headers,
      body: method !== 'GET' && method !== 'HEAD' ? body : undefined,
      signal: controller.signal,
    })
  } catch (error) {
    const proxyUrl = getProxyUrl(targetUrl)
    if (!proxyUrl) {
      if (error?.name === 'AbortError') throw new Error(`Upstream request timed out after ${timeoutMs}ms`)
      throw error
    }
    console.warn('[generation-task] direct upstream fetch failed; retrying via proxy', {
      targetUrl,
      proxyUrl,
      detail: errorMessage(error),
    })
    return fetchViaProxy(targetUrl, method, headers, body, proxyUrl)
  } finally {
    clearTimeout(timeout)
  }
}

function normalizeHeaders(headers) {
  const result = {}
  for (const [key, value] of Object.entries(headers || {})) {
    if (value == null) continue
    result[key] = String(value)
  }
  return result
}

function buildRequestPayload(spec) {
  let headers = normalizeHeaders(spec.headers)
  let body
  if (spec.formData) {
    const encoded = encodeProxyFormData(spec.formData)
    headers = removeContentHeaders(headers)
    headers['content-type'] = encoded.contentType
    body = encoded.body
  } else if (spec.bodyBase64) {
    body = Buffer.from(String(spec.bodyBase64), 'base64')
  } else if (spec.body !== undefined && spec.body !== null) {
    body = Buffer.isBuffer(spec.body) ? spec.body : Buffer.from(String(spec.body))
  }
  return { headers, body }
}

async function executeRequest(spec, timeoutMs) {
  if (!spec?.url || !/^https?:\/\//i.test(spec.url)) {
    throw new Error('Generation task upstream URL must use HTTP(S)')
  }
  const method = String(spec.method || (spec.body || spec.bodyBase64 || spec.formData ? 'POST' : 'GET')).toUpperCase()
  const { headers, body } = buildRequestPayload(spec)
  return fetchWithProxyFallback(spec.url, method, headers, body, timeoutMs)
}

async function readResponseText(response) {
  const text = await response.text()
  return text || ''
}

function parseResponseBody(text) {
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    const sseMatch = text.match(/^data:\s*(\{.+\})/m)
    if (sseMatch) return JSON.parse(sseMatch[1])
    return { text }
  }
}

function pathTokens(path) {
  return String(path || '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean)
}

function getByPath(value, path) {
  let current = value
  for (const token of pathTokens(path)) {
    if (current == null) return undefined
    current = current[token]
  }
  return current
}

function normalizeString(value) {
  if (value == null) return ''
  if (Array.isArray(value)) return normalizeString(value[0])
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number') return String(value)
  return ''
}

function isMediaUrl(value) {
  return /^https?:\/\//i.test(value) || /^data:(image|video|audio)\//i.test(value)
}

function firstStringAtPaths(data, paths) {
  for (const path of paths || []) {
    const normalized = normalizeString(getByPath(data, path))
    if (normalized) return normalized
  }
  return ''
}

function extractTaskId(data, paths = []) {
  return firstStringAtPaths(data, [
    ...paths,
    'task_id',
    'taskId',
    'id',
    'video_id',
    'request_id',
    'prediction_id',
    'data.task_id',
    'data.taskId',
    'data.id',
    'data.video_id',
    'data.0.task_id',
    'data.0.id',
    'output.task_id',
    'output.id',
    'response.task_id',
    'response.id',
    'result.task_id',
    'result.id',
  ])
}

function extractStatus(data, paths = []) {
  return firstStringAtPaths(data, [
    ...paths,
    'status',
    'state',
    'task_status',
    'taskStatus',
    'data.status',
    'data.state',
    'data.task_status',
    'data.taskStatus',
    'output.task_status',
    'output.status',
    'response.status',
    'result.status',
  ]).toLowerCase()
}

function collectUrls(value, urls = []) {
  if (value == null) return urls
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (isMediaUrl(trimmed)) urls.push(trimmed)
    const embedded = trimmed.match(/https?:\/\/[^\s"'<>)]*/gi) || []
    for (const url of embedded) urls.push(url)
    const dataUrl = trimmed.match(/data:(?:image|video|audio)\/[^;,]+;base64,[A-Za-z0-9+/=_-]+/i)?.[0]
    if (dataUrl) urls.push(dataUrl)
    return urls
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, urls)
    return urls
  }
  if (typeof value !== 'object') return urls

  const preferredKeys = [
    'url',
    'imageUrl',
    'image_url',
    'videoUrl',
    'video_url',
    'output_url',
    'result_url',
    'content',
    'output',
    'outputs',
    'result',
    'data',
  ]
  for (const key of preferredKeys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) collectUrls(value[key], urls)
  }
  for (const [key, child] of Object.entries(value)) {
    if (!preferredKeys.includes(key)) collectUrls(child, urls)
  }
  return urls
}

function extractResultUrl(data, kind, paths = []) {
  const kindPaths = kind === 'video'
    ? [
        'data.0.url',
        'data.url',
        'data.video_url',
        'data.task_result.videos.0.url',
        'data.task_result.video_url',
        'output.video_url',
        'output.url',
        'content.video_url',
        'result.video_url',
        'result.url',
        'video_url',
        'videoUrl',
        'result_url',
        'url',
      ]
    : [
        'data.0.url',
        'data.0.image_url',
        'data.url',
        'data.image_url',
        'data.result.images.0.url',
        'result.images.0.url',
        'result.url',
        'output_url',
        'result_url',
        'image_url',
        'imageUrl',
        'url',
      ]
  const explicit = firstStringAtPaths(data, [...paths, ...kindPaths])
  if (isMediaUrl(explicit)) return explicit
  if (kind === 'image') {
    const b64 = firstStringAtPaths(data, ['data.0.b64_json', 'data.b64_json', 'b64_json'])
    if (b64) return `data:image/png;base64,${b64.replace(/\s+/g, '')}`
  }
  return collectUrls(data).find((url) => {
    if (kind === 'image') return /^data:image\//i.test(url) || /\.(png|jpe?g|webp|gif|bmp|avif)(?:[?#].*)?$/i.test(url) || /^https?:\/\//i.test(url)
    if (kind === 'video') return /^data:video\//i.test(url) || /\.(mp4|webm|mov|m4v)(?:[?#].*)?$/i.test(url) || /^https?:\/\//i.test(url)
    return true
  }) || ''
}

function extractError(data, paths = []) {
  const direct = firstStringAtPaths(data, [
    ...paths,
    'error.message',
    'error',
    'message',
    'error_message',
    'failReason',
    'data.error.message',
    'data.error',
    'data.message',
    'data.task_status_msg',
    'output.message',
  ])
  if (direct) return direct
  return ''
}

function resolveTemplate(template, task) {
  if (!template) return ''
  return String(template)
    .replace(/\{taskId\}/g, encodeURIComponent(task.upstreamTaskId || ''))
    .replace(/\{id\}/g, encodeURIComponent(task.upstreamTaskId || ''))
}

function taskMediaUrl(req, task) {
  return `${taskOrigin(req, task)}/__generation_tasks/${encodeURIComponent(task.id)}/media`
}

function extensionForKind(kind, mimeType = '') {
  const type = mimeType.split(';')[0].toLowerCase()
  if (type.includes('png')) return 'png'
  if (type.includes('webp')) return 'webp'
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg'
  if (type.includes('gif')) return 'gif'
  if (type.includes('webm')) return 'webm'
  if (type.includes('quicktime')) return 'mov'
  if (type.includes('mp4')) return 'mp4'
  if (kind === 'video') return 'mp4'
  if (kind === 'audio') return 'mp3'
  return 'bin'
}

function dataUrlToMedia(dataUrl) {
  const match = String(dataUrl).match(/^data:([^;,]+);base64,(.*)$/i)
  if (!match) throw new Error('Unsupported data URL media result')
  return {
    mimeType: match[1] || 'application/octet-stream',
    buffer: Buffer.from(match[2], 'base64'),
  }
}

async function readMediaResponseWithLimit(response) {
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (contentLength > MAX_CACHED_MEDIA_BYTES) {
    throw new Error(`Generated media exceeds ${MAX_CACHED_MEDIA_BYTES} bytes`)
  }
  if (!response.body) return Buffer.from(await response.arrayBuffer())
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = Buffer.from(value)
    total += chunk.length
    if (total > MAX_CACHED_MEDIA_BYTES) {
      throw new Error(`Generated media exceeds ${MAX_CACHED_MEDIA_BYTES} bytes`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function resultFetchHeaders(task, resultUrl) {
  const submitUrl = task.input?.submit?.url
  const pollUrl = task.input?.poll?.url || ''
  const headers = { Accept: 'image/*, video/*, audio/*, application/octet-stream;q=0.8, */*;q=0.1' }
  try {
    const resultOrigin = new URL(resultUrl).origin
    const authSource = [pollUrl, submitUrl].find((url) => url && new URL(url).origin === resultOrigin)
    if (authSource) {
      const sourceHeaders = authSource === pollUrl ? task.input?.poll?.headers : task.input?.submit?.headers
      const authorization = sourceHeaders?.Authorization || sourceHeaders?.authorization
      if (authorization) headers.Authorization = authorization
    }
  } catch {
    // Leave only Accept.
  }
  headers['User-Agent'] = 'MoyinCreatorGenerationTask/1.0'
  return headers
}

async function fetchMediaToMemory(task, resultUrl) {
  if (/^data:/i.test(resultUrl)) return dataUrlToMedia(resultUrl)
  const response = await fetchWithProxyFallback(
    resultUrl,
    'GET',
    resultFetchHeaders(task, resultUrl),
    undefined,
    MEDIA_FETCH_TIMEOUT_MS,
  )
  if (!response.ok) {
    throw new Error(`Generated media fetch failed: HTTP ${response.status} ${response.statusText || ''}`.trim())
  }
  const mimeType = response.headers.get('content-type') || 'application/octet-stream'
  return {
    mimeType,
    buffer: await readMediaResponseWithLimit(response),
  }
}

async function tryCloudIngest(req, task, resultUrl, mimeHint) {
  if (!/^https?:\/\//i.test(resultUrl)) return null
  const resultSpec = task.input?.result || {}
  if (resultSpec.ingest === false) return null
  const kind = resultSpec.mediaKind || task.kind || 'media'
  const fallbackKey = `generation-tasks/${kind}/${task.id}.${extensionForKind(kind, mimeHint)}`
  const key = resultSpec.storageKey || fallbackKey
  const response = await fetch(`${taskOrigin(req, task)}/__cloud_media/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      key,
      url: resultUrl,
      expectedKind: kind,
    }),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Cloud media ingest failed: HTTP ${response.status} ${detail.slice(0, 200)}`.trim())
  }
  return response.json()
}

async function completeTaskWithResult(req, task, upstreamUrl) {
  const kind = task.input?.result?.mediaKind || task.kind || 'media'
  task.status = 'ingesting'
  task.progress = 95
  task.updatedAt = Date.now()

  let mediaUrl = upstreamUrl
  let mediaKey
  let mimeType = ''
  let size = 0
  let ingestError = ''

  try {
    const cloud = await tryCloudIngest(req, task, upstreamUrl)
    if (cloud?.url) {
      mediaUrl = cloud.url
      mediaKey = cloud.key
      mimeType = cloud.mimeType || ''
      size = cloud.size || 0
    }
  } catch (error) {
    ingestError = errorMessage(error)
    console.warn('[generation-task] cloud ingest failed; falling back to task media cache', {
      taskId: task.id,
      detail: ingestError,
    })
  }

  if (!mediaKey) {
    const media = await fetchMediaToMemory(task, upstreamUrl)
    const mediaPath = await persistTaskMedia(task, media)
    task.media = {
      mimeType: media.mimeType,
      size: media.buffer.length,
      path: mediaPath,
      buffer: media.buffer,
    }
    mimeType = media.mimeType
    size = media.buffer.length
    mediaUrl = taskMediaUrl(req, task)
  }

  task.status = 'completed'
  task.progress = 100
  task.completedAt = Date.now()
  task.updatedAt = task.completedAt
  task.result = {
    url: upstreamUrl,
    mediaUrl,
    mediaKey,
    mimeType,
    size,
    ingestError: ingestError || undefined,
  }
  task.input = undefined
  await persistTask(task)
}

async function failTask(task, error, status = 'failed') {
  task.status = status
  task.progress = 0
  task.error = errorMessage(error)
  task.completedAt = Date.now()
  task.updatedAt = task.completedAt
  task.input = undefined
  await persistTask(task)
  console.error('[generation-task] failed', { taskId: task.id, status, error: task.error })
}

function shouldFailStatus(status) {
  return status === 400 || status === 401 || status === 403 || status === 404
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function runTask(req, task) {
  try {
    const input = task.input
    if (!input) {
      throw new Error('后端任务缺少可恢复的输入配置')
    }
    const parse = input.parse || {}
    const successStatuses = new Set(parse.successStatuses || ['completed', 'succeeded', 'success', 'succeed', 'done'])
    const failureStatuses = new Set(parse.failureStatuses || ['failed', 'error', 'cancelled', 'canceled', 'expired'])
    const shouldResumePolling = !!task.upstreamTaskId && !!input.poll

    if (!shouldResumePolling) {
      task.status = 'submitting'
      task.progress = 2
      task.updatedAt = Date.now()
      await persistTask(task)

      const submitResponse = await executeRequest(input.submit, input.submitTimeoutMs || SUBMIT_TIMEOUT_MS)
      const submitText = await readResponseText(submitResponse)
      if (!submitResponse.ok) {
        throw new Error(`上游提交失败：HTTP ${submitResponse.status} ${submitText.slice(0, 500)}`)
      }

      const submitData = parseResponseBody(submitText)
      const submitStatus = extractStatus(submitData, parse.statusPaths)
      if (submitStatus && failureStatuses.has(submitStatus)) {
        throw new Error(extractError(submitData, parse.errorPaths) || `上游提交失败：${submitStatus}`)
      }
      task.upstreamTaskId = extractTaskId(submitData, parse.taskIdPaths)
      task.updatedAt = Date.now()
      await persistTask(task)

      const directUrl = extractResultUrl(submitData, task.kind, parse.resultUrlPaths)
      if (directUrl) {
        await completeTaskWithResult(req, task, directUrl)
        return
      }
    }

    if (!input.poll) {
      throw new Error(`上游已提交但未返回媒体 URL${task.upstreamTaskId ? `（任务 ${task.upstreamTaskId}）` : ''}，且未提供后端轮询配置`)
    }

    if (!task.upstreamTaskId && String(input.poll.url || '').includes('{taskId}')) {
      throw new Error('上游已提交但未返回 taskId，无法创建后端轮询任务')
    }

    task.pollStartedAt ||= Date.now()
    await persistTask(task)
    const startedAt = task.pollStartedAt
    const timeoutMs = task.timeoutMs
    const pollIntervalMs = Math.max(1_000, Number(input.poll.intervalMs || DEFAULT_POLL_INTERVAL_MS))

    while (Date.now() - startedAt <= timeoutMs) {
      task.status = 'polling'
      task.progress = Math.min(94, Math.max(5, Math.floor(((Date.now() - startedAt) / timeoutMs) * 90)))
      task.updatedAt = Date.now()
      await persistTask(task)

      const pollUrl = resolveTemplate(input.poll.url, task)
      const pollResponse = await executeRequest(
        { ...input.poll, url: pollUrl },
        input.poll.requestTimeoutMs || POLL_REQUEST_TIMEOUT_MS,
      )
      const pollText = await readResponseText(pollResponse)
      if (!pollResponse.ok) {
        if (shouldFailStatus(pollResponse.status)) {
          throw new Error(`上游任务查询失败：HTTP ${pollResponse.status} ${pollText.slice(0, 500)}`)
        }
        console.warn('[generation-task] transient poll failure', {
          taskId: task.id,
          upstreamTaskId: task.upstreamTaskId,
          status: pollResponse.status,
        })
        await sleep(pollIntervalMs)
        continue
      }

      const pollData = parseResponseBody(pollText)
      const status = extractStatus(pollData, parse.statusPaths)
      task.upstreamStatus = status || task.upstreamStatus

      if (status && successStatuses.has(status)) {
        const resultUrl = extractResultUrl(pollData, task.kind, parse.resultUrlPaths)
          || resolveTemplate(input.result?.fallbackUrl, task)
        if (!resultUrl) throw new Error('上游任务完成但没有返回媒体 URL')
        await completeTaskWithResult(req, task, resultUrl)
        return
      }

      if (status && failureStatuses.has(status)) {
        throw new Error(extractError(pollData, parse.errorPaths) || `上游任务失败：${status}`)
      }

      const resultUrl = extractResultUrl(pollData, task.kind, parse.resultUrlPaths)
      if (resultUrl) {
        await completeTaskWithResult(req, task, resultUrl)
        return
      }

      await sleep(pollIntervalMs)
    }

    await failTask(task, `后端轮询超时（${Math.round(timeoutMs / 1000)} 秒）`, 'timeout')
  } catch (error) {
    await failTask(task, error)
  }
}

async function createTask(req, body) {
  if (!body?.submit?.url) throw new Error('Missing generation task submit.url')
  const id = crypto.randomUUID()
  const timeoutMs = Math.max(10_000, Math.min(60 * 60 * 1000, Number(body.timeoutMs || DEFAULT_TASK_TIMEOUT_MS)))
  const now = Date.now()
  const task = {
    id,
    kind: body.kind || body.result?.mediaKind || 'media',
    label: body.label || '',
    status: 'queued',
    progress: 0,
    timeoutMs,
    createdAt: now,
    updatedAt: now,
    completedAt: undefined,
    upstreamTaskId: undefined,
    upstreamStatus: undefined,
    result: undefined,
    error: undefined,
    origin: requestOrigin(req),
    pollStartedAt: undefined,
    input: body,
    media: undefined,
  }
  tasks.set(id, task)
  await persistTask(task)
  void runTask(req, task)
  return task
}

async function cleanupTasks() {
  const now = Date.now()
  for (const [id, task] of tasks.entries()) {
    const doneAt = task.completedAt || task.updatedAt
    if (doneAt && now - doneAt > TASK_RETENTION_MS) {
      tasks.delete(id)
      await removePersistedTask(task)
    }
  }
}

async function loadPersistedTasks() {
  await ensureTaskStore()
  let entries = []
  try {
    entries = await readdir(TASK_STORE_DIR)
  } catch {
    return
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    try {
      const raw = await readFile(join(TASK_STORE_DIR, entry), 'utf8')
      const task = JSON.parse(raw)
      if (!task?.id) continue
      tasks.set(task.id, task)
      if (!TERMINAL_STATUSES.has(task.status)) {
        console.log('[generation-task] resuming persisted task', {
          taskId: task.id,
          status: task.status,
          upstreamTaskId: task.upstreamTaskId,
        })
        void runTask(null, task)
      }
    } catch (error) {
      console.warn('[generation-task] failed to load persisted task', {
        file: entry,
        detail: errorMessage(error),
      })
    }
  }
}

const tasksReady = loadPersistedTasks().catch((error) => {
  console.warn('[generation-task] persisted task recovery skipped', errorMessage(error))
})

setInterval(() => {
  void cleanupTasks()
}, Math.min(TASK_RETENTION_MS, 5 * 60 * 1000)).unref?.()

function routeParts(req) {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const rawPath = requestUrl.pathname.startsWith('/__generation_tasks')
    ? requestUrl.pathname.replace(/^\/__generation_tasks\/?/, '')
    : requestUrl.pathname.replace(/^\/+/, '')
  return {
    requestUrl,
    parts: rawPath.split('/').filter(Boolean).map(decodeURIComponent),
  }
}

export async function handleGenerationTaskRequest(req, res) {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {})
    return
  }

  try {
    await tasksReady
    const { parts } = routeParts(req)

    if (req.method === 'POST' && parts.length === 0) {
      const body = await readJsonBody(req)
      const task = await createTask(req, body)
      sendJson(res, 202, publicTask(task))
      return
    }

    if (req.method === 'GET' && parts.length === 0) {
      sendJson(res, 200, { tasks: [...tasks.values()].map(publicTask) })
      return
    }

    const taskId = parts[0]
    const task = taskId ? tasks.get(taskId) : null
    if (!task) {
      sendJson(res, 404, { error: 'Generation task not found' })
      return
    }

    if (req.method === 'GET' && parts.length === 1) {
      sendJson(res, 200, publicTask(task))
      return
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && parts[1] === 'media') {
      await sendBinary(req, res, task)
      return
    }

    if (req.method === 'DELETE' && parts.length === 1) {
      tasks.delete(taskId)
      await removePersistedTask(task)
      sendJson(res, 200, { success: true })
      return
    }

    sendJson(res, 404, { error: 'Unknown generation task endpoint' })
  } catch (error) {
    console.error('[generation-task] request failed:', error)
    sendJson(res, 500, {
      error: 'Generation task request failed',
      detail: errorMessage(error),
    })
  }
}
