import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { lookup } from 'node:dns/promises'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import OSS from 'ali-oss'
import pg from 'pg'

const { Pool } = pg

const DEFAULT_TABLE_NAME = 'moyin_user_storage'
const DEFAULT_OSS_PREFIX = 'mj/'
const MAX_CLOUD_BODY_BYTES = Number(process.env.MAX_CLOUD_BODY_BYTES || 200 * 1024 * 1024)
const MAX_MEDIA_INGEST_BYTES = Number(process.env.MAX_MEDIA_INGEST_BYTES || 500 * 1024 * 1024)
const MEDIA_INGEST_TIMEOUT_MS = Number(process.env.MEDIA_INGEST_TIMEOUT_MS || 30_000)
const CLOUD_UNAVAILABLE_RETRY_MS = Number(process.env.CLOUD_UNAVAILABLE_RETRY_MS || 30_000)
const DEFAULT_LOCAL_CLOUD_STORAGE_DIR = join(process.cwd(), '.cache', 'cloud-storage')
const DEFAULT_LOCAL_CLOUD_MEDIA_DIR = join(process.cwd(), '.cache', 'cloud-media')

let dotenvLoaded = false
let pool = null
let schemaReady = false
let ossClient = null
let postgresUnavailableUntil = 0
let postgresUnavailableDetail = ''
let ossUnavailableUntil = 0
let ossUnavailableDetail = ''
const failureLogState = new Map()

function loadDotenv() {
  if (dotenvLoaded) return
  dotenvLoaded = true

  const envPath = resolve(process.cwd(), '.env')
  if (!existsSync(envPath)) return

  const content = readFileSync(envPath, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const equalIndex = trimmed.indexOf('=')
    if (equalIndex <= 0) continue
    const key = trimmed.slice(0, equalIndex).trim()
    if (!key || process.env[key] !== undefined) continue
    let value = trimmed.slice(equalIndex + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': '*',
  })
  res.end(JSON.stringify(body))
}

function sendBinary(res, status, body, headers = {}) {
  res.writeHead(status, {
    'cache-control': 'public, max-age=31536000, immutable',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-allow-headers': '*',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  if (status === 204 || headers['content-length'] === '0') {
    res.end()
    return
  }
  res.end(body)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function temporarilyUnavailable(message) {
  const error = new Error(message)
  error.statusCode = 503
  return error
}

function markPostgresUnavailable(error) {
  postgresUnavailableUntil = Date.now() + CLOUD_UNAVAILABLE_RETRY_MS
  postgresUnavailableDetail = errorMessage(error)
  schemaReady = false

  if (pool) {
    const stalePool = pool
    pool = null
    void stalePool.end().catch(() => undefined)
  }
}

function assertPostgresAvailable() {
  if (Date.now() >= postgresUnavailableUntil) return
  throw temporarilyUnavailable(postgresUnavailableDetail || 'PostgreSQL is temporarily unavailable')
}

function markOssUnavailable(error) {
  ossUnavailableUntil = Date.now() + CLOUD_UNAVAILABLE_RETRY_MS
  ossUnavailableDetail = errorMessage(error)
  ossClient = null
}

function assertOssAvailable() {
  if (Date.now() >= ossUnavailableUntil) return
  throw temporarilyUnavailable(ossUnavailableDetail || 'OSS is temporarily unavailable')
}

function isTemporaryInfrastructureError(error) {
  const message = errorMessage(error)
  return /configured|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timeout|password authentication failed|role ".*" does not exist|database ".*" does not exist|no pg_hba|Connection terminated|OSS|AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch|NoSuchBucket/i.test(message)
}

function httpStatusForError(error) {
  if (typeof error?.statusCode === 'number') return error.statusCode
  const message = errorMessage(error)
  if (/Media ingest upstream failed/i.test(message)) return 502
  if (/Content-Type|unsupported media|expected (image|video|audio)/i.test(message)) return 415
  if (/Blocked|must use HTTP|Missing media ingest|redirect|exceeded redirect|did not resolve|private media host/i.test(message)) return 400
  return isTemporaryInfrastructureError(error) ? 503 : 500
}

function logRequestFailure(scope, error, status) {
  const message = errorMessage(error)
  if (status >= 400 && status < 500) {
    console.warn(`[${scope}] rejected request: ${message}`)
    return
  }
  if (status !== 503) {
    console.error(`[${scope}] request failed:`, error)
    return
  }

  const now = Date.now()
  const state = failureLogState.get(scope)
  if (state?.message === message && now < state.until) return

  failureLogState.set(scope, { message, until: now + CLOUD_UNAVAILABLE_RETRY_MS })
  console.warn(`[${scope}] temporarily unavailable: ${message}`)
}

async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_CLOUD_BODY_BYTES) {
      throw new Error(`Request body exceeds ${MAX_CLOUD_BODY_BYTES} bytes`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

async function readJsonBody(req) {
  const body = await readBody(req)
  if (body.length === 0) return {}
  return JSON.parse(body.toString('utf8'))
}

function normalizeStorageKey(value) {
  const key = String(value || '').trim().replace(/^\/+/, '')
  if (!key) throw new Error('Missing storage key')
  if (key.length > 2048) throw new Error('Storage key is too long')
  if (key.includes('\0')) throw new Error('Invalid storage key')
  return key
}

function normalizeStoragePrefix(value) {
  const key = String(value || '').trim().replace(/^\/+|\/+$/g, '')
  if (key.length > 2048) throw new Error('Storage prefix is too long')
  if (key.includes('\0')) throw new Error('Invalid storage prefix')
  return key
}

function encodedLocalKey(key) {
  return Buffer.from(normalizeStorageKey(key)).toString('base64url')
}

function localCloudStorageDir() {
  return resolve(process.env.CLOUD_STORAGE_DIR || process.env.LOCAL_CLOUD_STORAGE_DIR || DEFAULT_LOCAL_CLOUD_STORAGE_DIR)
}

function localCloudMediaDir() {
  return resolve(process.env.CLOUD_MEDIA_DIR || process.env.LOCAL_CLOUD_MEDIA_DIR || DEFAULT_LOCAL_CLOUD_MEDIA_DIR)
}

function cloudStorageDriver() {
  const configured = String(process.env.CLOUD_STORAGE_DRIVER || '').trim().toLowerCase()
  if (configured) return configured
  return process.env.DATABASE_URL || process.env.POSTGRES_URL ? 'postgres' : 'local'
}

function cloudMediaDriver() {
  const configured = String(process.env.CLOUD_MEDIA_DRIVER || '').trim().toLowerCase()
  if (configured) return configured
  return getOssClient() ? 'oss' : 'local'
}

function localStorageRecordPath(key) {
  return join(localCloudStorageDir(), `${encodedLocalKey(key)}.json`)
}

function localMediaObjectPath(key) {
  return join(localCloudMediaDir(), 'objects', encodedLocalKey(key))
}

function localMediaMetaPath(key) {
  return join(localCloudMediaDir(), 'meta', `${encodedLocalKey(key)}.json`)
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmpPath, JSON.stringify(value, null, 2))
  await rename(tmpPath, path)
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function isObjectNotFoundError(error) {
  return error?.code === 'ENOENT'
    || /does not exist|NoSuchKey|not found|not exist/i.test(errorMessage(error))
}

function isPrivateIpv4(address) {
  const parts = address.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b] = parts
  return a === 0
    || a === 10
    || a === 127
    || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31
    || a === 192 && b === 168
    || a === 100 && b >= 64 && b <= 127
    || a >= 224
}

function isPrivateIpv6(address) {
  const normalized = address.toLowerCase()
  return normalized === '::1'
    || normalized === '::'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe80:')
    || normalized.startsWith('::ffff:127.')
    || normalized.startsWith('::ffff:10.')
    || normalized.startsWith('::ffff:192.168.')
}

function assertPublicAddress(address) {
  const family = net.isIP(address)
  if (family === 4 && isPrivateIpv4(address)) {
    throw new Error(`Blocked private media host address: ${address}`)
  }
  if (family === 6 && isPrivateIpv6(address)) {
    throw new Error(`Blocked private media host address: ${address}`)
  }
}

async function assertSafeIngestUrl(rawUrl) {
  const parsed = new URL(String(rawUrl || '').trim())
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Media ingest URL must use HTTP(S)')
  }
  const hostname = parsed.hostname.toLowerCase()
  if (['localhost', 'localhost.localdomain'].includes(hostname) || hostname.endsWith('.localhost')) {
    throw new Error('Blocked localhost media ingest URL')
  }
  const directIp = net.isIP(hostname)
  if (directIp) {
    assertPublicAddress(hostname)
    return parsed
  }
  const addresses = await lookup(hostname, { all: true, verbatim: false })
  if (addresses.length === 0) throw new Error('Media ingest host did not resolve')
  for (const address of addresses) {
    assertPublicAddress(address.address)
  }
  return parsed
}

function mediaKindFromContentType(contentType) {
  const mimeType = String(contentType || '').split(';')[0].trim().toLowerCase()
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  return 'media'
}

function assertAllowedIngestContentType(contentType, expectedKind) {
  const mimeType = String(contentType || '').split(';')[0].trim().toLowerCase()
  if (!mimeType) throw new Error('Media ingest response did not include Content-Type')
  const actualKind = mediaKindFromContentType(mimeType)
  const expected = String(expectedKind || 'media').toLowerCase()
  if (expected !== 'media' && actualKind !== expected) {
    throw new Error(`Media ingest expected ${expected}, got ${mimeType}`)
  }
  if (!['image', 'video', 'audio'].includes(actualKind)) {
    throw new Error(`Media ingest rejected unsupported Content-Type: ${mimeType}`)
  }
  return mimeType
}

async function readResponseWithLimit(response, maxBytes) {
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (contentLength > maxBytes) {
    throw new Error(`Media ingest response exceeds ${maxBytes} bytes`)
  }
  if (!response.body) {
    return Buffer.from(await response.arrayBuffer())
  }

  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = Buffer.from(value)
    total += chunk.length
    if (total > maxBytes) {
      throw new Error(`Media ingest response exceeds ${maxBytes} bytes`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function fetchIngestMedia(rawUrl, expectedKind) {
  let currentUrl = String(rawUrl || '').trim()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), MEDIA_INGEST_TIMEOUT_MS)

  try {
    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      const parsed = await assertSafeIngestUrl(currentUrl)
      const response = await fetch(parsed.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'image/*, video/*, audio/*, application/octet-stream;q=0.8, */*;q=0.1',
          'User-Agent': 'MoyinCreatorMediaIngest/1.0',
        },
      })

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        if (!location) throw new Error(`Media ingest redirect ${response.status} missing Location`)
        currentUrl = new URL(location, parsed).toString()
        continue
      }

      if (!response.ok) {
        throw new Error(`Media ingest upstream failed: HTTP ${response.status} ${response.statusText || ''}`.trim())
      }

      const mimeType = assertAllowedIngestContentType(response.headers.get('content-type'), expectedKind)
      const content = await readResponseWithLimit(response, MAX_MEDIA_INGEST_BYTES)
      return {
        content,
        mimeType,
        sourceUrl: parsed.toString(),
      }
    }
    throw new Error('Media ingest exceeded redirect limit')
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Media ingest timed out after ${MEDIA_INGEST_TIMEOUT_MS}ms`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function getUserSegmentFromKey(key) {
  const match = key.match(/^users\/([^/]+)(?:\/|$)/)
  return match?.[1] || '__global__'
}

function tableName() {
  const name = process.env.CLOUD_STORAGE_TABLE || DEFAULT_TABLE_NAME
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return DEFAULT_TABLE_NAME
  return name
}

function getPool() {
  loadDotenv()
  assertPostgresAvailable()
  if (pool) return pool

  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL
  if (!connectionString) return null

  pool = new Pool({
    connectionString,
    max: Number(process.env.POSTGRES_POOL_SIZE || 10),
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  })
  pool.on('error', (error) => {
    markPostgresUnavailable(error)
    logRequestFailure('cloud-storage', error, 503)
  })
  return pool
}

async function ensureSchema() {
  const db = getPool()
  if (!db) {
    const error = temporarilyUnavailable('DATABASE_URL is not configured')
    markPostgresUnavailable(error)
    throw error
  }
  if (schemaReady) return db

  const table = tableName()
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${table} (
        key TEXT PRIMARY KEY,
        user_segment TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await db.query(`CREATE INDEX IF NOT EXISTS ${table}_user_segment_idx ON ${table} (user_segment)`)
    await db.query(`CREATE INDEX IF NOT EXISTS ${table}_key_prefix_idx ON ${table} (key text_pattern_ops)`)
  } catch (error) {
    markPostgresUnavailable(error)
    throw temporarilyUnavailable(errorMessage(error))
  }

  schemaReady = true
  return db
}

function getOssClient() {
  loadDotenv()
  assertOssAvailable()
  if (ossClient) return ossClient

  const accessKeyId = process.env.ALI_OSS_ACCESS_KEY_ID || process.env.OSS_ACCESS_KEY_ID
  const accessKeySecret = process.env.ALI_OSS_ACCESS_KEY_SECRET || process.env.OSS_ACCESS_KEY_SECRET
  const bucket = process.env.ALI_OSS_BUCKET || process.env.OSS_BUCKET
  const region = process.env.ALI_OSS_REGION || process.env.OSS_REGION || 'oss-cn-chengdu'

  if (!accessKeyId || !accessKeySecret || !bucket || !region) return null

  ossClient = new OSS({
    region,
    bucket,
    accessKeyId,
    accessKeySecret,
    secure: true,
  })
  return ossClient
}

function ossObjectKey(key) {
  const prefix = String(process.env.ALI_OSS_PREFIX || process.env.OSS_PREFIX || DEFAULT_OSS_PREFIX)
    .replace(/^\/+/, '')
    .replace(/\/?$/, '/')
  return `${prefix}${normalizeStorageKey(key)}`
}

function publicOssUrl(objectKey) {
  const publicBase = process.env.ALI_OSS_PUBLIC_BASE_URL || process.env.OSS_PUBLIC_BASE_URL
  if (publicBase) {
    return `${publicBase.replace(/\/+$/, '')}/${objectKey.split('/').map(encodeURIComponent).join('/')}`
  }
  const publicRead = (process.env.ALI_OSS_PUBLIC_READ || process.env.OSS_PUBLIC_READ || '').toLowerCase() === 'true'
  if (!publicRead) return null
  const bucket = process.env.ALI_OSS_BUCKET || process.env.OSS_BUCKET
  const region = process.env.ALI_OSS_REGION || process.env.OSS_REGION || 'oss-cn-chengdu'
  if (!bucket || !region) return null
  return `https://${bucket}.${region}.aliyuncs.com/${objectKey.split('/').map(encodeURIComponent).join('/')}`
}

function requestOrigin(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim()
  const proto = forwardedProto || (req.socket?.encrypted ? 'https' : 'http')
  const host = forwardedHost || req.headers.host || 'localhost'
  return `${proto}://${host}`
}

function cloudMediaFileUrl(req, key) {
  return `${requestOrigin(req)}/__cloud_media/file?key=${encodeURIComponent(normalizeStorageKey(key))}`
}

function contentTypeFromObject(result, fallback = 'application/octet-stream') {
  return result?.res?.headers?.['content-type'] || result?.res?.headers?.['Content-Type'] || fallback
}

function listDirsFromKeys(keys, prefix) {
  const normalized = prefix.replace(/\/+$/g, '')
  const start = normalized ? `${normalized}/` : ''
  const dirs = new Set()
  for (const key of keys) {
    if (normalized && !key.startsWith(start)) continue
    const rest = normalized ? key.slice(start.length) : key
    const first = rest.split('/')[0]
    if (first && first !== '_migrated') dirs.add(first)
  }
  return [...dirs]
}

async function listLocalStorageRecords() {
  const dir = localCloudStorageDir()
  await mkdir(dir, { recursive: true })
  const entries = await readdir(dir).catch((error) => {
    if (error?.code === 'ENOENT') return []
    throw error
  })
  const records = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const record = await readJsonIfExists(join(dir, entry))
    if (record?.key) records.push(record)
  }
  return records
}

async function handleLocalCloudStorageRequest(req, res, requestUrl, action) {
  if (action === 'status') {
    sendJson(res, 200, {
      enabled: true,
      postgres: false,
      driver: 'local',
      dir: localCloudStorageDir(),
    })
    return
  }

  if (action === 'item' && req.method === 'GET') {
    const key = normalizeStorageKey(requestUrl.searchParams.get('key'))
    const record = await readJsonIfExists(localStorageRecordPath(key))
    sendJson(res, 200, { value: record?.value ?? null })
    return
  }

  if (action === 'item' && (req.method === 'POST' || req.method === 'PUT')) {
    const body = await readJsonBody(req)
    const key = normalizeStorageKey(body.key)
    const now = new Date().toISOString()
    const existing = await readJsonIfExists(localStorageRecordPath(key))
    const value = typeof body.value === 'string' ? body.value : JSON.stringify(body.value ?? null)
    await writeJsonAtomic(localStorageRecordPath(key), {
      key,
      userSegment: getUserSegmentFromKey(key),
      value,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    })
    sendJson(res, 200, { success: true })
    return
  }

  if (action === 'item' && req.method === 'DELETE') {
    const key = normalizeStorageKey(requestUrl.searchParams.get('key'))
    await rm(localStorageRecordPath(key), { force: true })
    sendJson(res, 200, { success: true })
    return
  }

  if (action === 'exists' && req.method === 'GET') {
    const key = normalizeStorageKey(requestUrl.searchParams.get('key'))
    sendJson(res, 200, { exists: !!await readJsonIfExists(localStorageRecordPath(key)) })
    return
  }

  if (action === 'keys' && req.method === 'GET') {
    const prefix = normalizeStoragePrefix(requestUrl.searchParams.get('prefix') || '')
    const start = prefix ? `${prefix}/` : ''
    const records = await listLocalStorageRecords()
    sendJson(res, 200, {
      keys: records
        .map((record) => record.key)
        .filter((key) => !prefix || key === prefix || key.startsWith(start))
        .sort(),
    })
    return
  }

  if (action === 'dirs' && req.method === 'GET') {
    const prefix = normalizeStoragePrefix(requestUrl.searchParams.get('prefix') || '')
    const records = await listLocalStorageRecords()
    sendJson(res, 200, { dirs: listDirsFromKeys(records.map((record) => record.key).sort(), prefix) })
    return
  }

  if (action === 'dir' && req.method === 'DELETE') {
    const prefix = normalizeStorageKey(requestUrl.searchParams.get('prefix'))
    const start = `${prefix}/`
    const records = await listLocalStorageRecords()
    await Promise.all(records
      .filter((record) => record.key === prefix || record.key.startsWith(start))
      .map((record) => rm(localStorageRecordPath(record.key), { force: true })))
    sendJson(res, 200, { success: true })
    return
  }

  sendJson(res, 404, { error: 'Unknown local cloud storage endpoint' })
}

async function writeLocalMedia(key, content, mimeType, sourceUrl = '') {
  const normalizedKey = normalizeStorageKey(key)
  const objectPath = localMediaObjectPath(normalizedKey)
  const metaPath = localMediaMetaPath(normalizedKey)
  await mkdir(dirname(objectPath), { recursive: true })
  await mkdir(dirname(metaPath), { recursive: true })
  await writeFile(objectPath, content)
  await writeJsonAtomic(metaPath, {
    key: normalizedKey,
    mimeType: mimeType || 'application/octet-stream',
    size: content.length,
    sourceUrl,
    updatedAt: new Date().toISOString(),
  })
}

async function readLocalMedia(key) {
  const normalizedKey = normalizeStorageKey(key)
  const meta = await readJsonIfExists(localMediaMetaPath(normalizedKey))
  if (!meta) return null
  try {
    const content = await readFile(localMediaObjectPath(normalizedKey))
    return {
      key: normalizedKey,
      content,
      mimeType: meta.mimeType || 'application/octet-stream',
      size: meta.size || content.length,
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function handleLocalCloudMediaRequest(req, res, requestUrl, action) {
  if (action === 'status') {
    sendJson(res, 200, {
      enabled: true,
      oss: false,
      driver: 'local',
      dir: localCloudMediaDir(),
    })
    return
  }

  if (action === 'item' && (req.method === 'POST' || req.method === 'PUT')) {
    const body = await readJsonBody(req)
    const key = normalizeStorageKey(body.key)
    const mimeType = String(body.mimeType || 'application/octet-stream')
    const dataBase64 = String(body.dataBase64 || '')
    if (!dataBase64) throw new Error('Missing dataBase64')
    const payload = Buffer.from(dataBase64.includes(',') ? dataBase64.slice(dataBase64.indexOf(',') + 1) : dataBase64, 'base64')
    await writeLocalMedia(key, payload, mimeType)
    sendJson(res, 200, {
      success: true,
      key,
      url: cloudMediaFileUrl(req, key),
      mimeType,
      size: payload.length,
    })
    return
  }

  if (action === 'ingest' && (req.method === 'POST' || req.method === 'PUT')) {
    const body = await readJsonBody(req)
    const key = normalizeStorageKey(body.key)
    const sourceUrl = String(body.url || '').trim()
    if (!sourceUrl) throw new Error('Missing media ingest url')
    const expectedKind = String(body.expectedKind || 'media').toLowerCase()
    const fetched = await fetchIngestMedia(sourceUrl, expectedKind)
    await writeLocalMedia(key, fetched.content, fetched.mimeType, fetched.sourceUrl)
    sendJson(res, 200, {
      success: true,
      key,
      mimeType: fetched.mimeType,
      size: fetched.content.length,
      sourceUrl: fetched.sourceUrl,
      url: cloudMediaFileUrl(req, key),
    })
    return
  }

  if (action === 'url' && req.method === 'GET') {
    const key = normalizeStorageKey(requestUrl.searchParams.get('key'))
    const media = await readLocalMedia(key)
    sendJson(res, 200, { url: media ? cloudMediaFileUrl(req, key) : null, exists: !!media })
    return
  }

  if (action === 'file' && (req.method === 'GET' || req.method === 'HEAD')) {
    const key = normalizeStorageKey(requestUrl.searchParams.get('key'))
    const media = await readLocalMedia(key)
    if (!media) {
      sendJson(res, 404, { error: 'Cloud media key not found', key })
      return
    }
    sendBinary(res, 200, req.method === 'HEAD' ? Buffer.alloc(0) : media.content, {
      'content-type': media.mimeType,
      'content-length': String(req.method === 'HEAD' ? 0 : media.content.length),
    })
    return
  }

  if (action === 'base64' && req.method === 'GET') {
    const key = normalizeStorageKey(requestUrl.searchParams.get('key'))
    const media = await readLocalMedia(key)
    if (!media) {
      sendJson(res, 200, { base64: null, exists: false, key })
      return
    }
    sendJson(res, 200, {
      base64: `data:${media.mimeType};base64,${media.content.toString('base64')}`,
      mimeType: media.mimeType,
      size: media.content.length,
      exists: true,
    })
    return
  }

  if (action === 'item' && req.method === 'DELETE') {
    const key = normalizeStorageKey(requestUrl.searchParams.get('key'))
    await rm(localMediaObjectPath(key), { force: true })
    await rm(localMediaMetaPath(key), { force: true })
    sendJson(res, 200, { success: true })
    return
  }

  sendJson(res, 404, { error: 'Unknown local cloud media endpoint' })
}

export async function handleCloudStorageRequest(req, res) {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {})
    return
  }

  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const storagePath = requestUrl.pathname.startsWith('/__cloud_storage')
    ? requestUrl.pathname.replace(/^\/__cloud_storage\/?/, '')
    : requestUrl.pathname.replace(/^\/+/, '')
  const action = storagePath || 'status'

  try {
    if (cloudStorageDriver() === 'local') {
      await handleLocalCloudStorageRequest(req, res, requestUrl, action)
      return
    }

    if (action === 'status') {
      try {
        await ensureSchema()
        sendJson(res, 200, {
          enabled: true,
          postgres: true,
          table: tableName(),
        })
      } catch (error) {
        const status = httpStatusForError(error)
        if (status !== 503) throw error
        logRequestFailure('cloud-storage', error, status)
        sendJson(res, 200, {
          enabled: false,
          postgres: false,
          table: tableName(),
          detail: errorMessage(error),
        })
      }
      return
    }

    const db = await ensureSchema()
    const table = tableName()

    if (action === 'item' && req.method === 'GET') {
      const key = normalizeStorageKey(requestUrl.searchParams.get('key'))
      const result = await db.query(`SELECT value FROM ${table} WHERE key = $1`, [key])
      sendJson(res, 200, { value: result.rows[0]?.value ?? null })
      return
    }

    if (action === 'item' && (req.method === 'POST' || req.method === 'PUT')) {
      const body = await readJsonBody(req)
      const key = normalizeStorageKey(body.key)
      const value = typeof body.value === 'string' ? body.value : JSON.stringify(body.value ?? null)
      const userSegment = getUserSegmentFromKey(key)
      await db.query(
        `INSERT INTO ${table} (key, user_segment, value, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (key) DO UPDATE SET
           user_segment = EXCLUDED.user_segment,
           value = EXCLUDED.value,
           updated_at = NOW()`,
        [key, userSegment, value],
      )
      sendJson(res, 200, { success: true })
      return
    }

    if (action === 'item' && req.method === 'DELETE') {
      const key = normalizeStorageKey(requestUrl.searchParams.get('key'))
      await db.query(`DELETE FROM ${table} WHERE key = $1`, [key])
      sendJson(res, 200, { success: true })
      return
    }

    if (action === 'exists' && req.method === 'GET') {
      const key = normalizeStorageKey(requestUrl.searchParams.get('key'))
      const result = await db.query(`SELECT 1 FROM ${table} WHERE key = $1 LIMIT 1`, [key])
      sendJson(res, 200, { exists: result.rowCount > 0 })
      return
    }

    if (action === 'keys' && req.method === 'GET') {
      const prefix = normalizeStorageKey(requestUrl.searchParams.get('prefix') || '')
      const pattern = `${prefix.replace(/[%_\\]/g, '\\$&')}/%`
      const result = await db.query(
        `SELECT key FROM ${table} WHERE key = $1 OR key LIKE $2 ESCAPE '\\' ORDER BY key`,
        [prefix, pattern],
      )
      sendJson(res, 200, { keys: result.rows.map((row) => row.key) })
      return
    }

    if (action === 'dirs' && req.method === 'GET') {
      const prefix = normalizeStorageKey(requestUrl.searchParams.get('prefix') || '')
      const pattern = `${prefix.replace(/[%_\\]/g, '\\$&')}/%`
      const result = await db.query(
        `SELECT key FROM ${table} WHERE key LIKE $1 ESCAPE '\\' ORDER BY key`,
        [pattern],
      )
      sendJson(res, 200, { dirs: listDirsFromKeys(result.rows.map((row) => row.key), prefix) })
      return
    }

    if (action === 'dir' && req.method === 'DELETE') {
      const prefix = normalizeStorageKey(requestUrl.searchParams.get('prefix'))
      const pattern = `${prefix.replace(/[%_\\]/g, '\\$&')}/%`
      await db.query(`DELETE FROM ${table} WHERE key = $1 OR key LIKE $2 ESCAPE '\\'`, [prefix, pattern])
      sendJson(res, 200, { success: true })
      return
    }

    sendJson(res, 404, { error: 'Unknown cloud storage endpoint' })
  } catch (error) {
    const status = httpStatusForError(error)
    logRequestFailure('cloud-storage', error, status)
    sendJson(res, status, {
      error: 'Cloud storage request failed',
      detail: errorMessage(error),
    })
  }
}

export async function handleCloudMediaRequest(req, res) {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {})
    return
  }

  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const mediaPath = requestUrl.pathname.startsWith('/__cloud_media')
    ? requestUrl.pathname.replace(/^\/__cloud_media\/?/, '')
    : requestUrl.pathname.replace(/^\/+/, '')
  const action = mediaPath || 'status'

  try {
    if (cloudMediaDriver() === 'local') {
      await handleLocalCloudMediaRequest(req, res, requestUrl, action)
      return
    }

    if (action === 'status') {
      let enabled = false
      let detail = ''
      try {
        enabled = !!getOssClient()
        if (!enabled) detail = 'OSS is not configured'
      } catch (error) {
        const status = httpStatusForError(error)
        if (status !== 503) throw error
        logRequestFailure('cloud-media', error, status)
        detail = errorMessage(error)
      }

      sendJson(res, 200, {
        enabled,
        oss: enabled,
        bucket: process.env.ALI_OSS_BUCKET || process.env.OSS_BUCKET || '',
        prefix: process.env.ALI_OSS_PREFIX || process.env.OSS_PREFIX || DEFAULT_OSS_PREFIX,
        publicBaseUrl: process.env.ALI_OSS_PUBLIC_BASE_URL || process.env.OSS_PUBLIC_BASE_URL || '',
        publicRead: (process.env.ALI_OSS_PUBLIC_READ || process.env.OSS_PUBLIC_READ || '').toLowerCase() === 'true',
        detail,
      })
      return
    }

    const client = getOssClient()
    if (!client) {
      const error = temporarilyUnavailable('OSS is not configured')
      markOssUnavailable(error)
      throw error
    }

    if (action === 'item' && (req.method === 'POST' || req.method === 'PUT')) {
      const body = await readJsonBody(req)
      const key = normalizeStorageKey(body.key)
      const objectKey = ossObjectKey(key)
      const mimeType = String(body.mimeType || 'application/octet-stream')
      const dataBase64 = String(body.dataBase64 || '')
      if (!dataBase64) throw new Error('Missing dataBase64')
      const payload = Buffer.from(dataBase64.includes(',') ? dataBase64.slice(dataBase64.indexOf(',') + 1) : dataBase64, 'base64')
      await client.put(objectKey, payload, {
        mime: mimeType,
        headers: {
          'Content-Type': mimeType,
          'Cache-Control': 'public, max-age=31536000',
        },
      })
      const publicUrl = publicOssUrl(objectKey)
      sendJson(res, 200, {
        success: true,
        key,
        objectKey,
        url: publicUrl || cloudMediaFileUrl(req, key),
      })
      return
    }

    if (action === 'ingest' && (req.method === 'POST' || req.method === 'PUT')) {
      const body = await readJsonBody(req)
      const key = normalizeStorageKey(body.key)
      const sourceUrl = String(body.url || '').trim()
      if (!sourceUrl) throw new Error('Missing media ingest url')
      const expectedKind = String(body.expectedKind || 'media').toLowerCase()
      const objectKey = ossObjectKey(key)
      const fetched = await fetchIngestMedia(sourceUrl, expectedKind)
      await client.put(objectKey, fetched.content, {
        mime: fetched.mimeType,
        headers: {
          'Content-Type': fetched.mimeType,
          'Cache-Control': 'public, max-age=31536000',
          'X-Moyin-Source-Url': fetched.sourceUrl.slice(0, 1024),
        },
      })
      const publicUrl = publicOssUrl(objectKey)
      sendJson(res, 200, {
        success: true,
        key,
        objectKey,
        mimeType: fetched.mimeType,
        size: fetched.content.length,
        sourceUrl: fetched.sourceUrl,
        url: publicUrl || cloudMediaFileUrl(req, key),
      })
      return
    }

    if (action === 'url' && req.method === 'GET') {
      const key = normalizeStorageKey(requestUrl.searchParams.get('key'))
      const objectKey = ossObjectKey(key)
      const publicUrl = publicOssUrl(objectKey)
      if (publicUrl) {
        sendJson(res, 200, { url: publicUrl })
        return
      }
      sendJson(res, 200, { url: cloudMediaFileUrl(req, key) })
      return
    }

    if (action === 'file' && (req.method === 'GET' || req.method === 'HEAD')) {
      const key = normalizeStorageKey(requestUrl.searchParams.get('key'))
      const result = await client.get(ossObjectKey(key))
      const content = Buffer.isBuffer(result.content) ? result.content : Buffer.from(result.content)
      sendBinary(res, 200, req.method === 'HEAD' ? Buffer.alloc(0) : content, {
        'content-type': contentTypeFromObject(result),
        'content-length': String(req.method === 'HEAD' ? 0 : content.length),
      })
      return
    }

    if (action === 'base64' && req.method === 'GET') {
      const key = normalizeStorageKey(requestUrl.searchParams.get('key'))
      const result = await client.get(ossObjectKey(key))
      const content = Buffer.isBuffer(result.content) ? result.content : Buffer.from(result.content)
      const mimeType = contentTypeFromObject(result)
      sendJson(res, 200, {
        base64: `data:${mimeType};base64,${content.toString('base64')}`,
        mimeType,
        size: content.length,
      })
      return
    }

    if (action === 'item' && req.method === 'DELETE') {
      const key = normalizeStorageKey(requestUrl.searchParams.get('key'))
      await client.delete(ossObjectKey(key))
      sendJson(res, 200, { success: true })
      return
    }

    sendJson(res, 404, { error: 'Unknown cloud media endpoint' })
  } catch (error) {
    if (isObjectNotFoundError(error)) {
      if (action === 'base64' && req.method === 'GET') {
        sendJson(res, 200, {
          base64: null,
          exists: false,
          key: requestUrl.searchParams.get('key') || '',
        })
        return
      }
      if (action === 'url' && req.method === 'GET') {
        sendJson(res, 200, { url: null, exists: false })
        return
      }
      if (action === 'item' && req.method === 'DELETE') {
        sendJson(res, 200, { success: true })
        return
      }
    }
    const status = httpStatusForError(error)
    if (status === 503) markOssUnavailable(error)
    logRequestFailure('cloud-media', error, status)
    sendJson(res, status, {
      error: 'Cloud media request failed',
      detail: errorMessage(error),
    })
  }
}
