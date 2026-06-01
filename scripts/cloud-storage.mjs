import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import OSS from 'ali-oss'
import pg from 'pg'

const { Pool } = pg

const DEFAULT_TABLE_NAME = 'moyin_user_storage'
const DEFAULT_OSS_PREFIX = 'mj/'
const MAX_CLOUD_BODY_BYTES = Number(process.env.MAX_CLOUD_BODY_BYTES || 200 * 1024 * 1024)

let dotenvLoaded = false
let pool = null
let schemaReady = false
let ossClient = null

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
  if (pool) return pool

  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL
  if (!connectionString) return null

  pool = new Pool({
    connectionString,
    max: Number(process.env.POSTGRES_POOL_SIZE || 10),
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  })
  pool.on('error', (error) => {
    console.error('[cloud-storage] PostgreSQL pool error:', error)
  })
  return pool
}

async function ensureSchema() {
  const db = getPool()
  if (!db) throw new Error('DATABASE_URL is not configured')
  if (schemaReady) return db

  const table = tableName()
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

  schemaReady = true
  return db
}

function getOssClient() {
  loadDotenv()
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
    if (action === 'status') {
      sendJson(res, 200, {
        enabled: !!getPool(),
        postgres: !!getPool(),
        table: tableName(),
      })
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
    console.error('[cloud-storage] request failed:', error)
    sendJson(res, error.message?.includes('configured') ? 503 : 500, {
      error: 'Cloud storage request failed',
      detail: error instanceof Error ? error.message : String(error),
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
    if (action === 'status') {
      sendJson(res, 200, {
        enabled: !!getOssClient(),
        oss: !!getOssClient(),
        bucket: process.env.ALI_OSS_BUCKET || process.env.OSS_BUCKET || '',
        prefix: process.env.ALI_OSS_PREFIX || process.env.OSS_PREFIX || DEFAULT_OSS_PREFIX,
      })
      return
    }

    const client = getOssClient()
    if (!client) throw new Error('OSS is not configured')

    if (action === 'item' && (req.method === 'POST' || req.method === 'PUT')) {
      const body = await readJsonBody(req)
      const key = normalizeStorageKey(body.key)
      const mimeType = String(body.mimeType || 'application/octet-stream')
      const dataBase64 = String(body.dataBase64 || '')
      if (!dataBase64) throw new Error('Missing dataBase64')
      const payload = Buffer.from(dataBase64.includes(',') ? dataBase64.slice(dataBase64.indexOf(',') + 1) : dataBase64, 'base64')
      await client.put(ossObjectKey(key), payload, {
        mime: mimeType,
        headers: {
          'Content-Type': mimeType,
          'Cache-Control': 'public, max-age=31536000',
        },
      })
      sendJson(res, 200, { success: true })
      return
    }

    if (action === 'url' && req.method === 'GET') {
      const key = normalizeStorageKey(requestUrl.searchParams.get('key'))
      const expires = Number(process.env.ALI_OSS_SIGNED_URL_EXPIRES || process.env.OSS_SIGNED_URL_EXPIRES || 24 * 60 * 60)
      const url = client.signatureUrl(ossObjectKey(key), { expires, method: 'GET' })
      sendJson(res, 200, { url })
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
    console.error('[cloud-media] request failed:', error)
    sendJson(res, error.message?.includes('configured') ? 503 : 500, {
      error: 'Cloud media request failed',
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}
