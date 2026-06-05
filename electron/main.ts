// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
import { app, BrowserWindow, ipcMain, protocol, dialog, shell, net } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import https from 'node:https'
import http from 'node:http'
import os from 'node:os'
import { spawn } from 'node:child_process'
import type { OpenExternalResult, UpdateCheckResult } from '../src/types/update'

// electron-vite 构建后的目录结构
//
// ├─┬ out
// │ ├─┬ main
// │ │ └── index.cjs
// │ ├─┬ preload
// │ │ └── index.cjs
// │ └─┬ renderer
// │   └── index.html
//
process.env.APP_ROOT = path.join(__dirname, '../..')

export const VITE_DEV_SERVER_URL = process.env['ELECTRON_RENDERER_URL'] || process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(__dirname)
export const RENDERER_DIST = path.join(__dirname, '../renderer')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

let win: BrowserWindow | null

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function sanitizeExternalUrl(value?: string) {
  if (!isNonEmptyString(value)) return undefined
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined
    }
    return parsed.toString()
  } catch {
    return undefined
  }
}

function createWindow() {
  win = new BrowserWindow({
    title: '三体漫创',
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
    },
  })

  // Test active push message to Renderer-process.
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', (new Date).toLocaleString())
  })

  // Open external links in system browser instead of inside Electron
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    // Allow navigating to the app itself (dev server or local file)
    if (VITE_DEV_SERVER_URL && url.startsWith(VITE_DEV_SERVER_URL)) return
    if (url.startsWith('file://')) return
    // Block and open externally
    event.preventDefault()
    shell.openExternal(url)
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})
// ==================== Storage Config ====================
type StorageConfig = {
  // Single base path for all data (projects + media)
  basePath?: string
  // Legacy fields (for migration)
  projectPath?: string
  mediaPath?: string
  autoCleanEnabled?: boolean
  autoCleanDays?: number
}

const DEFAULT_STORAGE_CONFIG: Required<StorageConfig> = {
  basePath: '',
  projectPath: '',
  mediaPath: '',
  autoCleanEnabled: false,
  autoCleanDays: 30,
}

const storageConfigPath = path.join(app.getPath('userData'), 'storage-config.json')
let storageConfig: StorageConfig = loadStorageConfig()
let autoCleanInterval: NodeJS.Timeout | null = null

function loadStorageConfig(): StorageConfig {
  try {
    if (fs.existsSync(storageConfigPath)) {
      const raw = fs.readFileSync(storageConfigPath, 'utf-8')
      const parsed = JSON.parse(raw) as StorageConfig
      return { ...DEFAULT_STORAGE_CONFIG, ...parsed }
    }
  } catch (error) {
    console.warn('Failed to load storage config:', error)
  }
  return { ...DEFAULT_STORAGE_CONFIG }
}

function saveStorageConfig() {
  try {
    fs.writeFileSync(storageConfigPath, JSON.stringify(storageConfig, null, 2), 'utf-8')
  } catch (error) {
    console.warn('Failed to save storage config:', error)
  }
}

function ensureDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

function normalizePath(inputPath: string) {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(inputPath)
}

// Check if childPath is inside parentPath (subdirectory)
function isSubdirectory(parentPath: string, childPath: string): boolean {
  const normalizedParent = path.resolve(parentPath).toLowerCase() + path.sep
  const normalizedChild = path.resolve(childPath).toLowerCase() + path.sep
  return normalizedChild.startsWith(normalizedParent)
}

// Check if two paths are the same or one contains the other
function pathsConflict(source: string, dest: string): string | null {
  const normalizedSource = path.resolve(source).toLowerCase()
  const normalizedDest = path.resolve(dest).toLowerCase()

  if (normalizedSource === normalizedDest) {
    return null // Same path is OK, handled elsewhere
  }
  if (isSubdirectory(source, dest)) {
    return '目标路径不能是当前路径的子目录'
  }
  if (isSubdirectory(dest, source)) {
    return '当前路径不能是目标路径的子目录'
  }
  return null
}

// Get the base storage path (contains both projects and media)
function getStorageBasePath() {
  // Check new basePath first, then fall back to legacy projectPath parent
  const configured = storageConfig.basePath?.trim()
  if (configured) {
    return normalizePath(configured)
  }
  // Legacy migration: if projectPath exists, use its parent
  const legacyProject = storageConfig.projectPath?.trim()
  if (legacyProject) {
    return path.dirname(normalizePath(legacyProject))
  }
  return app.getPath('userData')
}

function getProjectDataRoot() {
  const base = path.join(getStorageBasePath(), 'projects')
  ensureDir(base)
  return base
}

function getMediaRoot() {
  const base = path.join(getStorageBasePath(), 'media')
  ensureDir(base)
  return base
}

function getCacheDirs() {
  const userData = app.getPath('userData')
  return [
    path.join(userData, 'Cache'),
    path.join(userData, 'Code Cache'),
    path.join(userData, 'GPUCache'),
  ]
}

async function getDirectorySize(dirPath: string): Promise<number> {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
    let total = 0
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        total += await getDirectorySize(fullPath)
      } else {
        const stat = await fs.promises.stat(fullPath)
        total += stat.size
      }
    }
    return total
  } catch {
    return 0
  }
}

async function copyDir(source: string, destination: string) {
  ensureDir(destination)
  await fs.promises.cp(source, destination, { recursive: true, force: true })
}

async function removeDir(dirPath: string) {
  await fs.promises.rm(dirPath, { recursive: true, force: true })
}

async function deleteOldFiles(dirPath: string, cutoffTime: number): Promise<number> {
  let cleared = 0
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        cleared += await deleteOldFiles(fullPath, cutoffTime)
        const remaining = await fs.promises.readdir(fullPath)
        if (remaining.length === 0) {
          await fs.promises.rmdir(fullPath).catch(() => {})
        }
      } else {
        const stat = await fs.promises.stat(fullPath)
        if (stat.mtimeMs < cutoffTime) {
          await fs.promises.unlink(fullPath).catch(() => {})
          cleared += stat.size
        }
      }
    }
  } catch {
    // ignore
  }
  return cleared
}

function scheduleAutoClean() {
  if (autoCleanInterval) {
    clearInterval(autoCleanInterval)
    autoCleanInterval = null
  }
  if (storageConfig.autoCleanEnabled) {
    const days = storageConfig.autoCleanDays || DEFAULT_STORAGE_CONFIG.autoCleanDays
    clearCache(days).catch(() => {})
    autoCleanInterval = setInterval(() => {
      clearCache(days).catch(() => {})
    }, 24 * 60 * 60 * 1000)
  }
}

async function clearCache(olderThanDays?: number): Promise<number> {
  const dirs = getCacheDirs()
  let cleared = 0
  if (olderThanDays && olderThanDays > 0) {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000
    for (const dir of dirs) {
      cleared += await deleteOldFiles(dir, cutoff)
    }
    return cleared
  }
  for (const dir of dirs) {
    cleared += await getDirectorySize(dir)
    await removeDir(dir).catch(() => {})
    ensureDir(dir)
  }
  return cleared
}

// Get user data path for storing images
const getImagesDir = (subDir: string) => {
  const imagesDir = path.join(getMediaRoot(), subDir)
  if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true })
  }
  return imagesDir
}

const getImageExtensionFromMime = (mimeType: string): string | null => {
  const mimeTypes: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/bmp': '.bmp',
    'image/avif': '.avif',
  }
  return mimeTypes[mimeType.toLowerCase()] || null
}

// Download image from URL and save to local file
const downloadImage = (url: string, filePath: string, maxRedirects: number = 5): Promise<void> => {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      reject(new Error('Too many redirects'))
      return
    }
    const protocol = url.startsWith('https') ? https : http
    const file = fs.createWriteStream(filePath)

    protocol.get(url, (response) => {
      const status = response.statusCode ?? 0
      if ([301, 302, 303, 307, 308].includes(status)) {
        file.close()
        const redirectUrl = response.headers.location
        if (redirectUrl) {
          downloadImage(redirectUrl, filePath, maxRedirects - 1).then(resolve).catch(reject)
          return
        }
      }

      if (status !== 200) {
        file.close()
        fs.unlink(filePath, () => {})
        reject(new Error(`Failed to download: ${status}`))
        return
      }

      response.pipe(file)
      file.on('finish', () => {
        file.close()
        resolve()
      })
    }).on('error', (err) => {
      file.close()
      fs.unlink(filePath, () => {})
      reject(err)
    })
  })
}

type ImageHostUploadProvider = {
  name: string
  platform: string
  baseUrl?: string
  uploadPath?: string
  apiKeyParam?: string
  apiKeyHeader?: string
  apiKeyFormField?: string
  expirationParam?: string
  imageField?: string
  imagePayloadType?: 'base64' | 'file'
  nameField?: string
  staticFormFields?: Record<string, string>
  responseUrlField?: string
  responseDeleteUrlField?: string
}

type ImageHostUploadOptions = {
  name?: string
  expiration?: number
}

type ImageHostUploadRequest = {
  provider: ImageHostUploadProvider
  apiKey: string
  imageData: string
  options?: ImageHostUploadOptions
}

type ImageHostUploadResponse = {
  success: boolean
  url?: string
  deleteUrl?: string
  error?: string
}

type ApiFetchRequest = {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  bodyBase64?: string
  formData?: Array<{
    name: string
    value?: string
    fileName?: string
    mimeType?: string
    dataBase64?: string
  }>
  timeoutMs?: number
  responseType?: 'text' | 'base64'
}

type ApiFetchResponse = {
  ok: boolean
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
  bodyBase64?: string
  error?: string
}

function summarizeImage2Sse(text: string) {
  const eventTypes: string[] = []
  const outputItems: Array<{ event: string; itemType: string; status?: string; hasResult: boolean }> = []
  let hasPartial = false
  let hasOutputItemResult = false
  let hasCompletedResult = false
  let completedOutputCount = 0
  let outputTextPreview = ''
  let outputTextChars = 0

  const trimmedText = text.trim()
  if (trimmedText.startsWith('{')) {
    try {
      const data = JSON.parse(trimmedText)
      const output = data.response?.output || data.output
      if (Array.isArray(output)) {
        completedOutputCount = output.length
        hasCompletedResult = output.some((item) => item?.type === 'image_generation_call' && !!item?.result)
        hasOutputItemResult = hasCompletedResult
        for (const item of output.slice(0, 12)) {
          outputItems.push({
            event: 'json',
            itemType: String(item?.type || 'unknown'),
            status: item?.status ? String(item.status) : undefined,
            hasResult: !!item?.result,
          })
        }
      }
      const textValue = data.output_text || data.response?.output_text
      if (typeof textValue === 'string') {
        outputTextChars = textValue.length
        outputTextPreview = textValue.slice(0, 300)
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
      }
    } catch {
      // Fall through to SSE parsing.
    }
  }

  for (const block of text.split(/\r?\n\r?\n/)) {
    let eventName = 'message'
    const dataLines: string[] = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim() || eventName
        continue
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart())
      }
    }
    if (dataLines.length === 0) continue

    const raw = dataLines.join('\n').trim()
    if (!raw || raw === '[DONE]') continue

    try {
      const event = JSON.parse(raw)
      const type = typeof event.type === 'string' ? event.type : eventName
      eventTypes.push(type)
      if (type === 'response.image_generation_call.partial_image' || event.partial_image_b64) {
        hasPartial = true
      }
      if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
        outputTextChars += event.delta.length
        if (outputTextPreview.length < 300) {
          outputTextPreview += event.delta
        }
      }
      if (event.item?.type && outputItems.length < 12) {
        outputItems.push({
          event: type,
          itemType: String(event.item.type),
          status: event.item.status ? String(event.item.status) : undefined,
          hasResult: !!event.item.result,
        })
      }
      if (type === 'response.output_item.done' && event.item?.type === 'image_generation_call' && event.item?.result) {
        hasOutputItemResult = true
      }
      const output = event.response?.output || event.output
      if ((type === 'response.completed' || type === 'response.done') && Array.isArray(output)) {
        completedOutputCount = output.length
        hasCompletedResult = output.some((item) => item?.type === 'image_generation_call' && !!item?.result)
        for (const item of output) {
          if (item?.type && outputItems.length < 12) {
            outputItems.push({
              event: type,
              itemType: String(item.type),
              status: item.status ? String(item.status) : undefined,
              hasResult: !!item.result,
            })
          }
        }
      }
    } catch {
      eventTypes.push('non-json')
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
  }
}

function summarizeImage2RequestBody(body?: string) {
  if (!body) return {}
  try {
    const parsed = JSON.parse(body)
    const firstInput = Array.isArray(parsed.input) ? parsed.input[0] : undefined
    const content = Array.isArray(firstInput?.content) ? firstInput.content : []
    const firstTool = Array.isArray(parsed.tools) ? parsed.tools[0] : undefined
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
    }
  } catch {
    return { bodyParseError: true }
  }
}

function isHttpUrl(value: string) {
  return value.startsWith('http://') || value.startsWith('https://')
}

function normalizeApiFetchUrl(value: string) {
  const parsed = new URL(value)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http/https API requests are allowed')
  }
  return parsed.toString()
}

function removeContentTypeHeader(headers: Record<string, string>) {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'content-type') {
      delete headers[key]
    }
  }
}

function buildApiFetchBody(request: ApiFetchRequest, headers: Record<string, string>): BodyInit | undefined {
  if (request.formData && request.formData.length > 0) {
    const form = new FormData()
    for (const field of request.formData) {
      if (!field.name) continue
      if (field.dataBase64 !== undefined) {
        const bytes = Buffer.from(field.dataBase64, 'base64')
        const blob = new Blob([bytes], { type: field.mimeType || 'application/octet-stream' })
        form.append(field.name, blob, field.fileName || 'upload.bin')
      } else {
        form.append(field.name, field.value || '')
      }
    }
    removeContentTypeHeader(headers)
    return form
  }

  if (request.bodyBase64 !== undefined) {
    return Buffer.from(request.bodyBase64, 'base64')
  }

  return request.body
}

type BinaryFetchResult = {
  ok: boolean
  status: number
  statusText: string
  headers: Record<string, string>
  bodyBase64: string
}

function normalizeResponseHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      result[key] = value
    } else if (Array.isArray(value)) {
      result[key] = value.join(', ')
    }
  }
  return result
}

function normalizeRequestHeaders(headers?: HeadersInit): Record<string, string> {
  const result: Record<string, string> = {}
  if (!headers) return result

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key] = value
    })
    return result
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      result[key] = value
    }
    return result
  }

  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) result[key] = String(value)
  }
  return result
}

function hasHeader(headers: Record<string, string>, name: string) {
  const normalized = name.toLowerCase()
  return Object.keys(headers).some((key) => key.toLowerCase() === normalized)
}

function bodyInitToBuffer(body: BodyInit | null | undefined): Buffer | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return Buffer.from(body, 'utf8')
  if (Buffer.isBuffer(body)) return body
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  }
  throw new Error('node:http transport only supports string or binary request bodies')
}

function responseFromNodeText(
  body: Buffer,
  status: number,
  statusText: string,
  headers: Record<string, string>,
) {
  return new Response(body.toString('utf8'), {
    status,
    statusText,
    headers,
  })
}

type NodeCliFetchResult = {
  ok: boolean
  status: number
  statusText: string
  headers: Record<string, string>
  bodyBase64: string
}

const NODE_CLI_FETCH_SCRIPT = String.raw`
const fs = require('node:fs');

function normalizeHeaders(headers) {
  const result = {};
  if (!headers) return result;
  if (typeof headers.forEach === 'function') {
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) result[key] = value.join(', ');
    else if (value !== undefined) result[key] = String(value);
  }
  return result;
}

let payload;
try {
  payload = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch (error) {
  console.error(JSON.stringify({ error: 'Invalid stdin payload', detail: error && error.message }));
  process.exit(2);
}

const body = payload.bodyBase64 ? Buffer.from(payload.bodyBase64, 'base64') : undefined;
const headers = { ...(payload.headers || {}) };
if (body && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-length')) {
  headers['Content-Length'] = String(body.length);
}

function getErrorMessage(error) {
  if (!error) return 'unknown error';
  if (error.cause && error.cause.message && error.cause.message !== error.message) {
    return error.message + '; cause: ' + error.cause.message;
  }
  return error.message || String(error);
}

function getErrorCode(error) {
  return error && (error.code || (error.cause && error.cause.code));
}

function shouldRetry(error) {
  const message = getErrorMessage(error).toLowerCase();
  const code = String(getErrorCode(error) || '').toLowerCase();
  return (
    code === 'econnreset' ||
    code === 'etimedout' ||
    code === 'eai_again' ||
    message.includes('socket hang up') ||
    message.includes('other side closed') ||
    message.includes('fetch failed') ||
    message.includes('connection closed') ||
    message.includes('timeout')
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOnce() {
  if (typeof fetch !== 'function') {
    throw new Error('Node global fetch is not available');
  }

  const timeoutMs = payload.timeoutMs || 600000;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error('request timeout'));
  }, timeoutMs);

  try {
    const response = await fetch(payload.url, {
      method: payload.method || 'GET',
      headers,
      body: body && !['GET', 'HEAD'].includes(String(payload.method || 'GET').toUpperCase()) ? body : undefined,
      signal: controller.signal,
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    process.stdout.write(JSON.stringify({
      ok: response.ok,
      status: response.status,
      statusText: response.statusText || '',
      headers: normalizeHeaders(response.headers),
      bodyBase64: buffer.toString('base64'),
    }));
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  const retryCount = Number.isFinite(Number(payload.retryCount)) ? Number(payload.retryCount) : 2;
  let lastError;
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    try {
      await fetchOnce();
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= retryCount || !shouldRetry(error)) break;
      await sleep(Math.min(2000 * Math.pow(2, attempt), 8000));
    }
  }

  console.error(JSON.stringify({
    error: getErrorMessage(lastError),
    code: getErrorCode(lastError),
  }));
  process.exit(2);
})();
`

function getNodeBinaryCandidates() {
  const candidates = [
    process.env.SANTI_NODE_BINARY,
    process.env.NODE_BINARY,
    'node',
  ]

  if (process.platform === 'darwin') {
    candidates.push('/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node')
  } else if (process.platform === 'win32') {
    candidates.push('node.exe')
  } else {
    candidates.push('/usr/local/bin/node', '/usr/bin/node')
  }

  return [...new Set(candidates.filter(isNonEmptyString))]
}

function runNodeCliFetchWithBinary(
  nodeBinary: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal | null,
): Promise<NodeCliFetchResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBinary, ['-e', NODE_CLI_FETCH_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let settled = false

    const finish = (error?: Error, result?: NodeCliFetchResult) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abortChild)
      if (error) {
        reject(error)
        return
      }
      resolve(result!)
    }

    const abortChild = () => {
      child.kill('SIGTERM')
      finish(new Error('请求已取消'))
    }

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    child.on('error', (error) => {
      finish(error)
    })
    child.on('close', (code) => {
      if (settled) return
      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim()
      if (code !== 0) {
        finish(new Error(stderr || `node child exited with code ${code}`))
        return
      }
      try {
        finish(undefined, JSON.parse(stdout) as NodeCliFetchResult)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        finish(new Error(`node child returned invalid JSON: ${detail}; stderr=${stderr.slice(0, 300)}`))
      }
    })

    if (signal?.aborted) {
      abortChild()
      return
    }
    signal?.addEventListener('abort', abortChild, { once: true })

    child.stdin.end(JSON.stringify(payload))
  })
}

async function fetchTextViaNodeCli(url: string, init: RequestInit): Promise<Response> {
  const bodyBuffer = bodyInitToBuffer(init.body)
  const payload = {
    url,
    method: init.method || 'GET',
    headers: normalizeRequestHeaders(init.headers),
    bodyBase64: bodyBuffer ? bodyBuffer.toString('base64') : undefined,
    timeoutMs: 600000,
    retryCount: 2,
  }

  let lastError: unknown
  for (const nodeBinary of getNodeBinaryCandidates()) {
    try {
      const result = await runNodeCliFetchWithBinary(nodeBinary, payload, init.signal)
      console.log('[API Fetch] Responses node child succeeded', { nodeBinary, status: result.status })
      return responseFromNodeText(
        Buffer.from(result.bodyBase64 || '', 'base64'),
        result.status,
        result.statusText,
        result.headers,
      )
    } catch (error) {
      lastError = error
      console.warn('[API Fetch] Responses node child failed', {
        nodeBinary,
        error: getFetchErrorMessage(error),
      })
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'node child fetch failed'))
}

function fetchTextViaNodeHttp(
  url: string,
  init: RequestInit,
  maxRedirects = 5,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (maxRedirects < 0) {
      reject(new Error('Too many redirects'))
      return
    }

    const parsedUrl = new URL(url)
    const client = parsedUrl.protocol === 'https:' ? https : http
    const headers = normalizeRequestHeaders(init.headers)
    const bodyBuffer = bodyInitToBuffer(init.body)
    if (bodyBuffer && !hasHeader(headers, 'content-length')) {
      headers['Content-Length'] = String(bodyBuffer.length)
    }

    const request = client.request(
      parsedUrl,
      {
        method: init.method || 'GET',
        headers,
      },
      (response) => {
        const status = response.statusCode ?? 0
        const location = response.headers.location
        if ([301, 302, 303, 307, 308].includes(status) && location) {
          response.resume()
          const redirectUrl = new URL(location, url).toString()
          resolve(fetchTextViaNodeHttp(redirectUrl, init, maxRedirects - 1))
          return
        }

        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })
        response.on('end', () => {
          const buffer = Buffer.concat(chunks)
          resolve(responseFromNodeText(
            buffer,
            status,
            response.statusMessage || '',
            normalizeResponseHeaders(response.headers),
          ))
        })
        response.on('error', reject)
      },
    )

    const abortRequest = () => request.destroy(new Error('请求已取消'))

    request.on('error', reject)
    request.on('close', () => {
      init.signal?.removeEventListener('abort', abortRequest)
    })

    if (init.signal?.aborted) {
      abortRequest()
      return
    }
    init.signal?.addEventListener('abort', abortRequest, { once: true })

    request.end(bodyBuffer)
  })
}

function fetchBinaryViaNode(
  url: string,
  options: {
    method?: string
    headers?: Record<string, string>
    timeoutMs?: number
    signal?: AbortSignal
    maxRedirects?: number
  } = {},
): Promise<BinaryFetchResult> {
  return new Promise((resolve, reject) => {
    const maxRedirects = options.maxRedirects ?? 5
    if (maxRedirects < 0) {
      reject(new Error('Too many redirects'))
      return
    }

    const parsedUrl = new URL(url)
    const client = parsedUrl.protocol === 'https:' ? https : http
    const request = client.request(
      parsedUrl,
      {
        method: options.method || 'GET',
        headers: options.headers,
      },
      (response) => {
        const status = response.statusCode ?? 0
        const location = response.headers.location
        if ([301, 302, 303, 307, 308].includes(status) && location) {
          response.resume()
          const redirectUrl = new URL(location, url).toString()
          resolve(fetchBinaryViaNode(redirectUrl, { ...options, maxRedirects: maxRedirects - 1 }))
          return
        }

        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })
        response.on('end', () => {
          const buffer = Buffer.concat(chunks)
          resolve({
            ok: status >= 200 && status < 300,
            status,
            statusText: response.statusMessage || '',
            headers: normalizeResponseHeaders(response.headers),
            bodyBase64: buffer.toString('base64'),
          })
        })
        response.on('error', reject)
      },
    )

    const clearRequestTimeout = options.timeoutMs
      ? setTimeout(() => request.destroy(new Error('请求超时')), options.timeoutMs)
      : null
    const abortRequest = () => request.destroy(new Error('请求已取消'))

    request.on('error', reject)
    request.on('close', () => {
      if (clearRequestTimeout) clearTimeout(clearRequestTimeout)
      options.signal?.removeEventListener('abort', abortRequest)
    })

    if (options.signal?.aborted) {
      abortRequest()
      return
    }
    options.signal?.addEventListener('abort', abortRequest, { once: true })
    request.end()
  })
}

function getFetchErrorMessage(error: unknown) {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause
    if (cause instanceof Error && cause.message && cause.message !== error.message) {
      return `${error.message}; cause: ${cause.message}`
    }
    return error.message
  }
  return String(error || 'unknown error')
}

function shouldRetryWithNodeFetch(error: unknown) {
  const message = getFetchErrorMessage(error).toLowerCase()
  return (
    message.includes('err_connection_closed') ||
    message.includes('err_http2_protocol_error') ||
    message.includes('err_connection_reset') ||
    message.includes('socket hang up') ||
    message.includes('econnreset') ||
    message.includes('other side closed') ||
    message.includes('fetch failed')
  )
}

async function fetchViaElectronNet(url: string, init: RequestInit): Promise<Response> {
  const isResponsesRequest = /\/responses(?:[/?]|$)/i.test(url)

  // IMAGE2 works in the standalone Node test script even when Electron's embedded
  // network stacks fail. Start with an external Node child so TLS/runtime behavior
  // matches that verified path.
  if (isResponsesRequest) {
    try {
      console.log('[API Fetch] Responses transport: node:child')
      return await fetchTextViaNodeCli(url, init)
    } catch (childError) {
      if (init.signal?.aborted) throw childError
      console.warn('[API Fetch] node child failed for Responses, retrying with node:http', {
        url,
        error: getFetchErrorMessage(childError),
      })
    }

    try {
      console.log('[API Fetch] Responses transport: node:http')
      return await fetchTextViaNodeHttp(url, init)
    } catch (error) {
      if (init.signal?.aborted) throw error
      console.warn('[API Fetch] node:http failed for Responses, retrying with Node fetch', {
        url,
        error: getFetchErrorMessage(error),
      })
      try {
        return await fetch(url, init)
      } catch (fetchError) {
        if (typeof net.fetch !== 'function') throw fetchError
        console.warn('[API Fetch] Node fetch failed for Responses, falling back to Electron net.fetch', {
          url,
          error: getFetchErrorMessage(fetchError),
        })
        return net.fetch(url, init)
      }
    }
  }

  // Electron/Chromium respects system proxy settings better than Node's undici fetch.
  // This matters for proxy fake-ip environments where Node resolves cloud domains to 198.18.x.x.
  if (typeof net.fetch === 'function') {
    try {
      return await net.fetch(url, init)
    } catch (error) {
      if (init.signal?.aborted || !shouldRetryWithNodeFetch(error)) throw error
      console.warn('[API Fetch] Electron net.fetch failed, retrying with Node fetch', {
        url,
        error: getFetchErrorMessage(error),
      })
      return fetch(url, init)
    }
  }
  return fetch(url, init)
}

function resolveImageHostUploadUrl(provider: ImageHostUploadProvider) {
  const uploadPath = (provider.uploadPath || '').trim()
  if (uploadPath && isHttpUrl(uploadPath)) {
    return uploadPath
  }
  const baseUrl = (provider.baseUrl || '').trim().replace(/\/*$/, '')
  if (!baseUrl && !uploadPath) return ''
  if (!baseUrl && uploadPath) return ''
  if (!uploadPath) return baseUrl
  const normalizedPath = uploadPath.startsWith('/') ? uploadPath : `/${uploadPath}`
  return `${baseUrl}${normalizedPath}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getByPath(obj: unknown, objectPath?: string): unknown {
  if (!isRecord(obj) || !objectPath) return undefined
  return objectPath.split('.').reduce<unknown>((acc, key) => {
    if (!isRecord(acc)) return undefined
    return acc[key]
  }, obj)
}

function extractFirstHttpUrl(value: string): string | undefined {
  const match = value.match(/https?:\/\/[^\s"'<>]+/i)
  return match?.[0]
}

function getExtensionFromMimeType(mimeType?: string) {
  switch ((mimeType || '').toLowerCase()) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    case 'image/svg+xml':
      return 'svg'
    case 'image/bmp':
      return 'bmp'
    case 'image/avif':
      return 'avif'
    case 'image/png':
    default:
      return 'png'
  }
}

function getMimeTypeFromExtension(filePath: string): string | undefined {
  const extension = path.extname(filePath).toLowerCase()
  const mimeTypes: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.avif': 'image/avif',
  }
  return mimeTypes[extension]
}

function asciiFromBuffer(buffer: Buffer, start: number, length: number): string {
  if (buffer.length < start + length) return ''
  return buffer.subarray(start, start + length).toString('ascii')
}

function inferImageMimeTypeFromBuffer(buffer: Buffer): string | undefined {
  if (buffer.length < 4) return undefined
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) return 'image/png'
  if (asciiFromBuffer(buffer, 0, 4) === 'RIFF' && asciiFromBuffer(buffer, 8, 4) === 'WEBP') return 'image/webp'
  if (asciiFromBuffer(buffer, 0, 6) === 'GIF87a' || asciiFromBuffer(buffer, 0, 6) === 'GIF89a') return 'image/gif'
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp'
  if (
    (buffer[0] === 0x49 && buffer[1] === 0x49 && (buffer[2] === 0x2a || buffer[2] === 0x2b) && buffer[3] === 0x00) ||
    (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && (buffer[3] === 0x2a || buffer[3] === 0x2b))
  ) return 'image/tiff'
  if (asciiFromBuffer(buffer, 4, 4) === 'ftyp') {
    const brand = asciiFromBuffer(buffer, 8, 4).toLowerCase()
    if (['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs'].includes(brand)) return 'image/heic'
    if (['heif', 'mif1', 'msf1'].includes(brand)) return 'image/heif'
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
  }
  const prefix = buffer.subarray(0, Math.min(buffer.length, 256)).toString('utf8').trimStart().toLowerCase()
  if (prefix.startsWith('<svg')) return 'image/svg+xml'
  return undefined
}

function normalizeImageMimeType(mimeType: string | null | undefined, buffer: Buffer): string {
  const inferred = inferImageMimeTypeFromBuffer(buffer)
  if (inferred) return inferred
  throw new Error('图片数据不是支持的图片格式')
}

function parseDataUrl(dataUrl: string): { buffer: Buffer, mimeType: string } | null {
  const matches = dataUrl.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/s)
  if (!matches) return null
  const buffer = Buffer.from(matches[2], 'base64')
  if (buffer.length === 0) return null
  const mimeType = normalizeImageMimeType(matches[1], buffer)
  return { buffer, mimeType }
}

function resolveImageSourcePath(imagePath: string): string | null {
  const localImageMatch = imagePath.match(/^local-image:\/\/(.+)\/(.+)$/)
  if (localImageMatch) {
    const [, category, filename] = localImageMatch
    return path.join(getMediaRoot(), category, decodeURIComponent(filename))
  }

  if (imagePath.startsWith('file://')) {
    return imagePath.replace(/^file:\/\/\/?/, '')
  }

  if (path.isAbsolute(imagePath)) {
    return imagePath
  }

  return null
}

async function fetchBuffer(url: string, timeoutMs: number = 45000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'image/*, */*;q=0.8',
      },
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`请求失败: ${response.status}`)
    }

    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    if (buffer.length === 0) {
      throw new Error('获取到的图片为空')
    }

    return {
      buffer,
      mimeType: normalizeImageMimeType(response.headers.get('content-type'), buffer),
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`请求超时 (${Math.round(timeoutMs / 1000)}s)`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function readImageSource(imageData: string): Promise<{ buffer: Buffer, mimeType: string }> {
  if (isHttpUrl(imageData)) {
    return fetchBuffer(imageData)
  }

  const parsedDataUrl = parseDataUrl(imageData)
  if (parsedDataUrl) {
    return parsedDataUrl
  }

  const resolvedPath = resolveImageSourcePath(imageData)
  if (resolvedPath) {
    if (!fs.existsSync(resolvedPath)) {
      throw new Error('本地图片不存在')
    }
    const buffer = fs.readFileSync(resolvedPath)
    if (buffer.length === 0) {
      throw new Error('本地图片为空文件')
    }
    return {
      buffer,
      mimeType: normalizeImageMimeType(getMimeTypeFromExtension(resolvedPath), buffer),
    }
  }

  const rawBuffer = Buffer.from(imageData, 'base64')
  if (rawBuffer.length === 0) {
    throw new Error('图片数据无效')
  }
  return {
    buffer: rawBuffer,
    mimeType: normalizeImageMimeType(undefined, rawBuffer),
  }
}

async function toUploadFilePayload(imageData: string, name?: string) {
  const { buffer, mimeType } = await readImageSource(imageData)
  const baseName = (name || 'upload').trim() || 'upload'
  const hasExtension = /\.[a-z0-9]{2,8}$/i.test(baseName)
  const filename = hasExtension ? baseName : `${baseName}.${getExtensionFromMimeType(mimeType)}`
  return {
    blob: new Blob([new Uint8Array(buffer)], { type: mimeType }),
    filename,
    mimeType,
  }
}

async function toBase64Payload(imageData: string) {
  if (imageData.startsWith('data:')) {
    const parsed = parseDataUrl(imageData)
    if (!parsed) {
      throw new Error('图片数据无效')
    }
    return parsed.buffer.toString('base64')
  }

  if (isHttpUrl(imageData) || imageData.startsWith('local-image://') || imageData.startsWith('file://') || path.isAbsolute(imageData)) {
    const { buffer } = await readImageSource(imageData)
    return buffer.toString('base64')
  }

  return imageData
}

async function uploadImageHostFromMain({
  provider,
  apiKey,
  imageData,
  options,
}: ImageHostUploadRequest): Promise<ImageHostUploadResponse> {
  try {
    const uploadUrl = resolveImageHostUploadUrl(provider)
    if (!uploadUrl) {
      return { success: false, error: '图床上传地址未配置' }
    }

    const fieldName = provider.imageField || 'image'
    const nameField = provider.nameField || 'name'
    const payloadType = provider.imagePayloadType || 'base64'
    const staticFormFields = provider.staticFormFields || {}

    const formData = new FormData()
    Object.entries(staticFormFields).forEach(([key, value]) => {
      formData.append(key, value)
    })
    if (provider.apiKeyFormField && apiKey) {
      formData.append(provider.apiKeyFormField, apiKey)
    }

    if (payloadType === 'file') {
      const { blob, filename } = await toUploadFilePayload(imageData, options?.name)
      formData.append(fieldName, blob, filename)
    } else {
      const base64Data = await toBase64Payload(imageData)
      formData.append(fieldName, base64Data)
    }

    if (options?.name) {
      formData.append(nameField, options.name)
    }

    const url = new URL(uploadUrl)
    if (provider.apiKeyParam && apiKey) {
      url.searchParams.set(provider.apiKeyParam, apiKey)
    }
    if (provider.expirationParam && options?.expiration) {
      url.searchParams.set(provider.expirationParam, String(options.expiration))
    }

    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
    }
    if (provider.apiKeyHeader && apiKey) {
      headers[provider.apiKeyHeader] = apiKey
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 45000)

    try {
      const response = await fetch(url.toString(), {
        method: 'POST',
        headers,
        body: formData,
        signal: controller.signal,
      })

      const text = await response.text()
      let data: unknown = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        data = null
      }

      if (!response.ok) {
        const errorMessage = getByPath(data, 'error.message')
        const messageField = getByPath(data, 'message')
        const message = typeof errorMessage === 'string'
          ? errorMessage
          : typeof messageField === 'string'
            ? messageField
          : text || `上传失败: ${response.status}`
        console.error('[ImageHost/Main] Upload failed', {
          provider: provider.name,
          platform: provider.platform,
          status: response.status,
          message,
        })
        return { success: false, error: message }
      }

      const urlField = getByPath(data, provider.responseUrlField || 'url')
      const deleteField = getByPath(data, provider.responseDeleteUrlField || 'delete_url')
      const trimmedText = text.trim()
      const extractedTextUrl = extractFirstHttpUrl(trimmedText)

      if (urlField) {
        return {
          success: true,
          url: typeof urlField === 'string' ? urlField : String(urlField),
          deleteUrl: deleteField ? (typeof deleteField === 'string' ? deleteField : String(deleteField)) : undefined,
        }
      }

      if (extractedTextUrl) {
        return { success: true, url: extractedTextUrl }
      }

      console.warn('[ImageHost/Main] Upload succeeded but no URL was detected in the response', {
        provider: provider.name,
        platform: provider.platform,
        responsePreview: trimmedText.substring(0, 200),
      })
      return { success: false, error: `图床 ${provider.name} 上传成功但未返回 URL` }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        console.error('[ImageHost/Main] Upload timeout', {
          provider: provider.name,
          platform: provider.platform,
          uploadUrl,
        })
        return { success: false, error: '上传超时，请稍后重试' }
      }
      console.error('[ImageHost/Main] Upload exception', {
        provider: provider.name,
        platform: provider.platform,
        uploadUrl,
        error: error instanceof Error ? error.message : String(error),
      })
      return { success: false, error: error instanceof Error ? error.message : '上传失败' }
    } finally {
      clearTimeout(timeout)
    }
  } catch (error) {
    console.error('[ImageHost/Main] Upload setup failed', {
      provider: provider.name,
      platform: provider.platform,
      error: error instanceof Error ? error.message : String(error),
    })
    return { success: false, error: error instanceof Error ? error.message : '上传失败' }
  }
}

// IPC handlers for image management
ipcMain.handle('save-image', async (_event, { url, category, filename }) => {
  try {
    const imagesDir = getImagesDir(category)
    const dataUrlMatch = url.startsWith('data:')
      ? url.match(/^data:([^;]+);base64,(.+)$/s)
      : null
    const ext = dataUrlMatch
      ? getImageExtensionFromMime(dataUrlMatch[1]) || path.extname(filename) || '.png'
      : path.extname(filename) || '.png'
    const safeName = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}${ext}`
    const filePath = path.join(imagesDir, safeName)

    // data: URL — 直接解码 base64 写入文件（canvas 切割产物）
    if (url.startsWith('data:')) {
      if (!dataUrlMatch) {
        return { success: false, error: 'Invalid data URL format' }
      }
      const buffer = Buffer.from(dataUrlMatch[2], 'base64')
      if (buffer.length === 0) {
        return { success: false, error: 'Decoded base64 data is empty (0 bytes)' }
      }
      fs.writeFileSync(filePath, buffer)
    } else {
      await downloadImage(url, filePath)
    }

    // Validate file was written successfully with non-zero size
    const stat = fs.statSync(filePath)
    if (stat.size === 0) {
      fs.unlinkSync(filePath) // Clean up empty file
      return { success: false, error: 'Saved file is 0 bytes' }
    }

    // Return local path that can be used in the app
    return { success: true, localPath: `local-image://${category}/${safeName}` }
  } catch (error) {
    console.error('Failed to save image:', error)
    return { success: false, error: String(error) }
  }
})

ipcMain.handle('get-image-path', async (_event, localPath: string) => {
  // Convert local-image://category/filename to actual file path
  const match = localPath.match(/^local-image:\/\/(.+)\/(.+)$/)
  if (!match) return null

  const [, category, filename] = match
  const filePath = path.join(getMediaRoot(), category, filename)

  if (fs.existsSync(filePath)) {
    // Windows: file:///H:/path/to/file.png (三斜杠 + 正斜杠)
    return `file:///${filePath.replace(/\\/g, '/')}`
  }
  return null
})

ipcMain.handle('delete-image', async (_event, localPath: string) => {
  const match = localPath.match(/^local-image:\/\/(.+)\/(.+)$/)
  if (!match) return false

  const [, category, filename] = match
  const filePath = path.join(getMediaRoot(), category, filename)

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
    return true
  } catch {
    return false
  }
})

// Read an image source as base64 (for AI API calls)
ipcMain.handle('read-image-base64', async (_event, localPath: string) => {
  try {
    const { buffer, mimeType } = await readImageSource(localPath)
    const base64 = `data:${mimeType};base64,${buffer.toString('base64')}`

    return { success: true, base64, mimeType, size: buffer.length }
  } catch (error) {
    console.error('Failed to read image:', error)
    return { success: false, error: String(error) }
  }
})

// Get absolute file path for a local-image:// URL
ipcMain.handle('get-absolute-path', async (_event, localPath: string) => {
  const match = localPath.match(/^local-image:\/\/(.+)\/(.+)$/)
  if (!match) return null

  const [, category, filename] = match
  const filePath = path.join(getMediaRoot(), category, decodeURIComponent(filename))

  if (fs.existsSync(filePath)) {
    return filePath
  }
  return null
})

ipcMain.handle('image-host-upload', async (_event, payload: ImageHostUploadRequest) => {
  return uploadImageHostFromMain(payload)
})

// ==================== File Storage for App Data ====================
const getDataDir = () => {
  const dataDir = getProjectDataRoot()
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }
  return dataDir
}

ipcMain.handle('file-storage-get', async (_event, key: string) => {
  try {
    const filePath = path.join(getDataDir(), `${key}.json`)
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf-8')
      return data
    }
    return null
  } catch (error) {
    console.error('Failed to read file storage:', error)
    return null
  }
})

ipcMain.handle('file-storage-set', async (_event, key: string, value: string) => {
  try {
    const filePath = path.join(getDataDir(), `${key}.json`)
    // Ensure parent directory exists (supports nested keys like _p/xxx/script)
    const parentDir = path.dirname(filePath)
    ensureDir(parentDir)
    fs.writeFileSync(filePath, value, 'utf-8')
    console.log(`Saved to file: ${filePath} (${Math.round(value.length / 1024)}KB)`)
    return true
  } catch (error) {
    console.error('Failed to write file storage:', error)
    return false
  }
})

ipcMain.handle('file-storage-remove', async (_event, key: string) => {
  try {
    const filePath = path.join(getDataDir(), `${key}.json`)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
    return true
  } catch (error) {
    console.error('Failed to remove file storage:', error)
    return false
  }
})

// Check if a storage key exists
ipcMain.handle('file-storage-exists', async (_event, key: string) => {
  try {
    const filePath = path.join(getDataDir(), `${key}.json`)
    return fs.existsSync(filePath)
  } catch {
    return false
  }
})

// List sub-directories under a directory prefix (used to discover project IDs under _p/)
ipcMain.handle('file-storage-list-dirs', async (_event, prefix: string) => {
  try {
    const dirPath = path.join(getDataDir(), prefix)
    if (!fs.existsSync(dirPath)) return []
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== '_migrated')
      .map(e => e.name)
  } catch {
    return []
  }
})

// List all JSON keys under a directory prefix
ipcMain.handle('file-storage-list', async (_event, prefix: string) => {
  try {
    const dirPath = path.join(getDataDir(), prefix)
    if (!fs.existsSync(dirPath)) return []
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
    return entries
      .filter(e => e.isFile() && e.name.endsWith('.json'))
      .map(e => `${prefix}/${e.name.replace('.json', '')}`)
  } catch {
    return []
  }
})

// Remove an entire directory (for project deletion)
ipcMain.handle('file-storage-remove-dir', async (_event, prefix: string) => {
  try {
    const dirPath = path.join(getDataDir(), prefix)
    if (fs.existsSync(dirPath)) {
      await fs.promises.rm(dirPath, { recursive: true, force: true })
    }
    return true
  } catch (error) {
    console.error('Failed to remove directory:', error)
    return false
  }
})
// ==================== Storage Manager ====================
ipcMain.handle('storage-get-paths', async () => {
  return {
    basePath: getStorageBasePath(),
    projectPath: getProjectDataRoot(),
    mediaPath: getMediaRoot(),
    cachePath: path.join(app.getPath('userData'), 'Cache'),
  }
})

ipcMain.handle('storage-select-directory', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled || !result.filePaths[0]) return null
  return result.filePaths[0]
})

// Validate if a directory contains valid data (projects/ subfolder with .json files or _p/ dirs)
ipcMain.handle('storage-validate-data-dir', async (_event, dirPath: string) => {
  try {
    if (!dirPath) return { valid: false, error: '路径不能为空' }
    const target = normalizePath(dirPath)
    if (!fs.existsSync(target)) return { valid: false, error: '目录不存在' }

    // Check for projects/ subfolder with .json files or _p/ per-project dirs
    const projectsDir = path.join(target, 'projects')
    const mediaDir = path.join(target, 'media')

    let projectCount = 0
    let mediaCount = 0

    if (fs.existsSync(projectsDir)) {
      const files = await fs.promises.readdir(projectsDir)
      // Count root .json files (global stores)
      projectCount = files.filter(f => f.endsWith('.json')).length
      // Also count per-project directories under _p/
      const perProjectDir = path.join(projectsDir, '_p')
      if (fs.existsSync(perProjectDir)) {
        const projectDirs = await fs.promises.readdir(perProjectDir, { withFileTypes: true })
        const dirCount = projectDirs.filter(d => d.isDirectory() && !d.name.startsWith('.')).length
        if (dirCount > 0) projectCount = Math.max(projectCount, dirCount)
      }
    }

    if (fs.existsSync(mediaDir)) {
      const entries = await fs.promises.readdir(mediaDir)
      mediaCount = entries.length
    }

    if (projectCount === 0 && mediaCount === 0) {
      return { valid: false, error: '该目录不包含有效的数据（需要 projects/ 或 media/ 子目录）' }
    }

    return { valid: true, projectCount, mediaCount }
  } catch (error) {
    return { valid: false, error: String(error) }
  }
})

// Link to existing data directory (no data movement)
ipcMain.handle('storage-link-data', async (_event, dirPath: string) => {
  try {
    if (!dirPath) return { success: false, error: '路径不能为空' }
    const target = normalizePath(dirPath)
    if (!fs.existsSync(target)) return { success: false, error: '目录不存在' }

    // Validate it has data
    const projectsDir = path.join(target, 'projects')
    const mediaDir = path.join(target, 'media')

    const hasProjects = fs.existsSync(projectsDir)
    const hasMedia = fs.existsSync(mediaDir)

    if (!hasProjects && !hasMedia) {
      return { success: false, error: '该目录不包含有效的数据（需要 projects/ 或 media/ 子目录）' }
    }

    // Update config to point to this directory
    storageConfig.basePath = target
    storageConfig.projectPath = '' // Clear legacy
    storageConfig.mediaPath = ''   // Clear legacy
    saveStorageConfig()
    return { success: true, path: target }
  } catch (error) {
    console.error('Failed to link data:', error)
    return { success: false, error: String(error) }
  }
})

// Move all data to new location (single operation)
ipcMain.handle('storage-move-data', async (_event, newPath: string) => {
  try {
    if (!newPath) return { success: false, error: '路径不能为空' }
    const target = normalizePath(newPath)
    const currentBase = getStorageBasePath()

    if (currentBase === target) return { success: true, path: currentBase }

    // Check for path conflicts
    const conflictError = pathsConflict(currentBase, target)
    if (conflictError) {
      return { success: false, error: conflictError }
    }

    // Ensure target directories exist
    const targetProjectsDir = path.join(target, 'projects')
    const targetMediaDir = path.join(target, 'media')
    ensureDir(targetProjectsDir)
    ensureDir(targetMediaDir)

    // Move projects
    const currentProjectsDir = getProjectDataRoot()
    if (fs.existsSync(currentProjectsDir)) {
      const files = await fs.promises.readdir(currentProjectsDir)
      for (const file of files) {
        const src = path.join(currentProjectsDir, file)
        const dest = path.join(targetProjectsDir, file)
        await fs.promises.cp(src, dest, { recursive: true, force: true })
      }
    }

    // Move media
    const currentMediaDir = getMediaRoot()
    if (fs.existsSync(currentMediaDir)) {
      const files = await fs.promises.readdir(currentMediaDir)
      for (const file of files) {
        const src = path.join(currentMediaDir, file)
        const dest = path.join(targetMediaDir, file)
        await fs.promises.cp(src, dest, { recursive: true, force: true })
      }
    }

    // Update config
    storageConfig.basePath = target
    storageConfig.projectPath = '' // Clear legacy
    storageConfig.mediaPath = ''   // Clear legacy
    saveStorageConfig()

    // Clean up old directories (only if different from userData)
    const userData = app.getPath('userData')
    if (!currentProjectsDir.startsWith(userData)) {
      await removeDir(currentProjectsDir).catch(() => {})
    }
    if (!currentMediaDir.startsWith(userData)) {
      await removeDir(currentMediaDir).catch(() => {})
    }

    return { success: true, path: target }
  } catch (error) {
    console.error('Failed to move data:', error)
    return { success: false, error: String(error) }
  }
})

// Export all data
ipcMain.handle('storage-export-data', async (_event, targetPath: string) => {
  try {
    if (!targetPath) return { success: false, error: '路径不能为空' }
    const exportDir = path.join(
      normalizePath(targetPath),
      `santi-data-${new Date().toISOString().replace(/[:.]/g, '-')}`
    )

    // Create export structure
    const exportProjectsDir = path.join(exportDir, 'projects')
    const exportMediaDir = path.join(exportDir, 'media')
    ensureDir(exportProjectsDir)
    ensureDir(exportMediaDir)

    // Copy projects
    await copyDir(getProjectDataRoot(), exportProjectsDir)
    // Copy media
    await copyDir(getMediaRoot(), exportMediaDir)

    return { success: true, path: exportDir }
  } catch (error) {
    console.error('Failed to export data:', error)
    return { success: false, error: String(error) }
  }
})

// Import all data (with backup for safety)
ipcMain.handle('storage-import-data', async (_event, sourcePath: string) => {
  try {
    if (!sourcePath) return { success: false, error: '路径不能为空' }
    const source = normalizePath(sourcePath)

    const sourceProjectsDir = path.join(source, 'projects')
    const sourceMediaDir = path.join(source, 'media')

    // Validate source has data
    const hasProjects = fs.existsSync(sourceProjectsDir)
    const hasMedia = fs.existsSync(sourceMediaDir)
    if (!hasProjects && !hasMedia) {
      return { success: false, error: '源目录不包含有效数据（需要 projects/ 或 media/ 子目录）' }
    }

    // Create temporary backup for rollback
    const backupDir = path.join(os.tmpdir(), `santi-backup-${Date.now()}`)
    const currentProjectsDir = getProjectDataRoot()
    const currentMediaDir = getMediaRoot()

    try {
      // Backup existing data
      if (hasProjects && fs.existsSync(currentProjectsDir)) {
        const files = await fs.promises.readdir(currentProjectsDir)
        if (files.length > 0) {
          await copyDir(currentProjectsDir, path.join(backupDir, 'projects'))
        }
      }
      if (hasMedia && fs.existsSync(currentMediaDir)) {
        const files = await fs.promises.readdir(currentMediaDir)
        if (files.length > 0) {
          await copyDir(currentMediaDir, path.join(backupDir, 'media'))
        }
      }

      // Import new data
      if (hasProjects) {
        await removeDir(currentProjectsDir).catch(() => {})
        await copyDir(sourceProjectsDir, currentProjectsDir)
      }
      if (hasMedia) {
        await removeDir(currentMediaDir).catch(() => {})
        await copyDir(sourceMediaDir, currentMediaDir)
      }

      // Clear migration flag so migration re-evaluates imported data on next startup
      const migrationFlagPath = path.join(currentProjectsDir, '_p', '_migrated.json')
      if (fs.existsSync(migrationFlagPath)) {
        fs.unlinkSync(migrationFlagPath)
        console.log('Cleared migration flag for re-evaluation after import')
      }

      // Success - clean up backup
      await removeDir(backupDir).catch(() => {})
      return { success: true }
    } catch (importError) {
      // Rollback: restore from backup
      console.error('Import failed, rolling back:', importError)
      const backupProjectsDir = path.join(backupDir, 'projects')
      const backupMediaDir = path.join(backupDir, 'media')

      if (fs.existsSync(backupProjectsDir)) {
        await removeDir(currentProjectsDir).catch(() => {})
        await copyDir(backupProjectsDir, currentProjectsDir).catch(() => {})
      }
      if (fs.existsSync(backupMediaDir)) {
        await removeDir(currentMediaDir).catch(() => {})
        await copyDir(backupMediaDir, currentMediaDir).catch(() => {})
      }
      await removeDir(backupDir).catch(() => {})

      throw importError
    }
  } catch (error) {
    console.error('Failed to import data:', error)
    return { success: false, error: String(error) }
  }
})

// Legacy handlers (kept for backward compatibility but redirect to new ones)
ipcMain.handle('storage-validate-project-dir', async (_event, dirPath: string) => {
  // Redirect to new unified handler
  return ipcMain.emit('storage-validate-data-dir', null, dirPath)
})

ipcMain.handle('storage-link-project-data', async (_event, dirPath: string) => {
  // For legacy: assume dirPath is the projects folder, use parent as base
  const target = normalizePath(dirPath)
  const basePath = path.dirname(target)
  storageConfig.basePath = basePath
  storageConfig.projectPath = ''
  storageConfig.mediaPath = ''
  saveStorageConfig()
  return { success: true, path: basePath }
})

ipcMain.handle('storage-link-media-data', async (_event, dirPath: string) => {
  // For legacy: assume dirPath is the media folder, use parent as base
  const target = normalizePath(dirPath)
  const basePath = path.dirname(target)
  storageConfig.basePath = basePath
  storageConfig.projectPath = ''
  storageConfig.mediaPath = ''
  saveStorageConfig()
  return { success: true, path: basePath }
})

ipcMain.handle('storage-move-project-data', async () => {
  return { success: false, error: '请使用新的统一存储路径功能' }
})
ipcMain.handle('storage-move-media-data', async () => {
  return { success: false, error: '请使用新的统一存储路径功能' }
})

ipcMain.handle('storage-export-project-data', async (_event, targetPath: string) => {
  // Redirect to unified export
  try {
    if (!targetPath) return { success: false, error: '路径不能为空' }
    const exportDir = path.join(
      normalizePath(targetPath),
      `santi-data-${new Date().toISOString().replace(/[:.]/g, '-')}`
    )
    ensureDir(path.join(exportDir, 'projects'))
    ensureDir(path.join(exportDir, 'media'))
    await copyDir(getProjectDataRoot(), path.join(exportDir, 'projects'))
    await copyDir(getMediaRoot(), path.join(exportDir, 'media'))
    return { success: true, path: exportDir }
  } catch (error) {
    return { success: false, error: String(error) }
  }
})

ipcMain.handle('storage-import-project-data', async (_event, sourcePath: string) => {
  try {
    if (!sourcePath) return { success: false, error: '路径不能为空' }
    const source = normalizePath(sourcePath)
    const projectsDir = path.join(source, 'projects')
    const mediaDir = path.join(source, 'media')

    const currentProjectsDir = getProjectDataRoot()
    const currentMediaDir = getMediaRoot()
    const backupDir = path.join(os.tmpdir(), `santi-legacy-import-backup-${Date.now()}`)

    try {
      if (fs.existsSync(currentProjectsDir)) {
        const files = await fs.promises.readdir(currentProjectsDir)
        if (files.length > 0) {
          await copyDir(currentProjectsDir, path.join(backupDir, 'projects'))
        }
      }
      if (fs.existsSync(currentMediaDir)) {
        const files = await fs.promises.readdir(currentMediaDir)
        if (files.length > 0) {
          await copyDir(currentMediaDir, path.join(backupDir, 'media'))
        }
      }

      if (fs.existsSync(projectsDir)) {
        await removeDir(currentProjectsDir).catch(() => {})
        await copyDir(projectsDir, currentProjectsDir)
      } else {
        await removeDir(currentProjectsDir).catch(() => {})
        await copyDir(source, currentProjectsDir)
      }

      if (fs.existsSync(mediaDir)) {
        await removeDir(currentMediaDir).catch(() => {})
        await copyDir(mediaDir, currentMediaDir)
      }

      await removeDir(backupDir).catch(() => {})
      return { success: true }
    } catch (importError) {
      console.error('Legacy import failed, rolling back:', importError)
      const backupProjectsDir = path.join(backupDir, 'projects')
      const backupMediaDir = path.join(backupDir, 'media')

      if (fs.existsSync(backupProjectsDir)) {
        await removeDir(currentProjectsDir).catch(() => {})
        await copyDir(backupProjectsDir, currentProjectsDir).catch(() => {})
      }
      if (fs.existsSync(backupMediaDir)) {
        await removeDir(currentMediaDir).catch(() => {})
        await copyDir(backupMediaDir, currentMediaDir).catch(() => {})
      }
      await removeDir(backupDir).catch(() => {})

      throw importError
    }
  } catch (error) {
    return { success: false, error: String(error) }
  }
})

ipcMain.handle('storage-export-media-data', async (_event, targetPath: string) => {
  // Legacy: redirect to unified export
  try {
    if (!targetPath) return { success: false, error: '路径不能为空' }
    const exportDir = path.join(
      normalizePath(targetPath),
      `santi-data-${new Date().toISOString().replace(/[:.]/g, '-')}`
    )
    ensureDir(path.join(exportDir, 'projects'))
    ensureDir(path.join(exportDir, 'media'))
    await copyDir(getProjectDataRoot(), path.join(exportDir, 'projects'))
    await copyDir(getMediaRoot(), path.join(exportDir, 'media'))
    return { success: true, path: exportDir }
  } catch (error) {
    console.error('Failed to export data:', error)
    return { success: false, error: String(error) }
  }
})

ipcMain.handle('storage-import-media-data', async (_event, sourcePath: string) => {
  try {
    if (!sourcePath) return { success: false, error: '路径不能为空' }
    const target = getMediaRoot()
    const source = normalizePath(sourcePath)
    if (source === target) return { success: true }

    const backupDir = path.join(os.tmpdir(), `santi-media-import-backup-${Date.now()}`)

    try {
      if (fs.existsSync(target)) {
        const files = await fs.promises.readdir(target)
        if (files.length > 0) {
          await copyDir(target, backupDir)
        }
      }

      await removeDir(target)
      await copyDir(source, target)

      await removeDir(backupDir).catch(() => {})
      return { success: true }
    } catch (importError) {
      console.error('Media import failed, rolling back:', importError)
      if (fs.existsSync(backupDir)) {
        await removeDir(target).catch(() => {})
        await copyDir(backupDir, target).catch(() => {})
      }
      await removeDir(backupDir).catch(() => {})
      throw importError
    }
  } catch (error) {
    console.error('Failed to import media data:', error)
    return { success: false, error: String(error) }
  }
})

ipcMain.handle('storage-get-cache-size', async () => {
  const dirs = getCacheDirs()
  const details = await Promise.all(
    dirs.map(async (dirPath) => ({
      path: dirPath,
      size: await getDirectorySize(dirPath),
    }))
  )
  const total = details.reduce((sum, item) => sum + item.size, 0)
  return { total, details }
})

ipcMain.handle('storage-clear-cache', async (_event, options?: { olderThanDays?: number }) => {
  try {
    const clearedBytes = await clearCache(options?.olderThanDays)
    return { success: true, clearedBytes }
  } catch (error) {
    console.error('Failed to clear cache:', error)
    return { success: false, error: String(error) }
  }
})

ipcMain.handle('storage-update-config', async (_event, config: { autoCleanEnabled?: boolean; autoCleanDays?: number }) => {
  storageConfig = { ...storageConfig, ...config }
  saveStorageConfig()
  scheduleAutoClean()
  return true
})

ipcMain.handle('app-updater-get-current-version', async () => {
  return app.getVersion()
})

ipcMain.handle('app-updater-check', async (): Promise<UpdateCheckResult> => {
  const currentVersion = app.getVersion()
  return {
    success: true,
    currentVersion,
    hasUpdate: false,
    update: null,
  }
})

ipcMain.handle('app-updater-open-link', async (_event, url: string): Promise<OpenExternalResult> => {
  const safeUrl = sanitizeExternalUrl(url)
  if (!safeUrl) {
    return { success: false, error: '无效下载链接' }
  }

  try {
    await shell.openExternal(safeUrl)
    return { success: true }
  } catch (error) {
    console.error('Failed to open external link:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
})

// ==================== API Fetch (Main Process) ====================
ipcMain.handle('api-fetch', async (_event, request: ApiFetchRequest): Promise<ApiFetchResponse> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? 600000)
  const shouldTrace = /contents\/generations\/tasks|\/kling\/v1\/videos|\/video-generation|\/video\/|\/videos\/|\/images\/|\/responses/i.test(request.url)

  try {
    const url = normalizeApiFetchUrl(request.url)
    const headers = { ...(request.headers || {}) }
    if (request.responseType === 'base64') {
      const binary = await fetchBinaryViaNode(url, {
        method: request.method || 'GET',
        headers,
        timeoutMs: request.timeoutMs ?? 600000,
        signal: controller.signal,
      })
      return {
        ok: binary.ok,
        status: binary.status,
        statusText: binary.statusText,
        headers: binary.headers,
        body: '',
        bodyBase64: binary.bodyBase64,
      }
    }

    const body = buildApiFetchBody(request, headers)
    const response = await fetchViaElectronNet(url, {
      method: request.method || 'GET',
      headers,
      body,
      signal: controller.signal,
    })
    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value
    })
    const responseText = await response.text()
    if (/\/responses(?:[/?]|$)/i.test(url)) {
      console.log('[API Fetch] IMAGE2 responses summary', {
        url,
        method: request.method || 'GET',
        status: response.status,
        statusText: response.statusText,
        contentType: responseHeaders['content-type'],
        request: summarizeImage2RequestBody(request.body),
        response: summarizeImage2Sse(responseText),
      })
    }

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: responseText,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'API request failed'
    if (shouldTrace) {
      console.error('[API Fetch] failed', {
        url: request.url,
        method: request.method || 'GET',
        timeoutMs: request.timeoutMs ?? 600000,
        error: message,
      })
    }
    return {
      ok: false,
      status: 0,
      statusText: 'Network Error',
      headers: {},
      body: '',
      error: message,
    }
  } finally {
    clearTimeout(timeout)
  }
})

ipcMain.handle('save-file-dialog', async (_event, { localPath, defaultPath, filters }: { localPath: string, defaultPath: string, filters: { name: string, extensions: string[] }[] }) => {
  try {
    // Resolve the source file path
    let sourcePath: string | null = null

    // Handle local-image:// and local-video:// protocols
    const imageMatch = localPath.match(/^local-image:\/\/(.+)\/(.+)$/)
    const videoMatch = localPath.match(/^local-video:\/\/(.+)\/(.+)$/)

    if (imageMatch) {
      const [, category, filename] = imageMatch
      sourcePath = path.join(getMediaRoot(), category, decodeURIComponent(filename))
    } else if (videoMatch) {
      const [, category, filename] = videoMatch
      sourcePath = path.join(getMediaRoot(), category, decodeURIComponent(filename))
    } else if (localPath.startsWith('file://')) {
      sourcePath = localPath.replace('file://', '')
    } else {
      sourcePath = localPath
    }

    if (!sourcePath || !fs.existsSync(sourcePath)) {
      return { success: false, error: 'Source file not found' }
    }

    // Show save dialog
    const result = await dialog.showSaveDialog({
      defaultPath: defaultPath,
      filters: filters,
    })

    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true }
    }

    // Copy file to destination
    fs.copyFileSync(sourcePath, result.filePath)

    return { success: true, filePath: result.filePath }
  } catch (error) {
    console.error('Failed to save file:', error)
    return { success: false, error: String(error) }
  }
})

// ==================== Demo Project Seed ====================

/**
 * Get the path to bundled demo-data.
 * - Dev mode: {APP_ROOT}/demo-data/
 * - Production: {resourcesPath}/demo-data/
 */
function getDemoDataPath(): string {
  if (VITE_DEV_SERVER_URL) {
    return path.join(process.env.APP_ROOT!, 'demo-data')
  }
  return path.join(process.resourcesPath, 'demo-data')
}

/**
 * Recursively copy a directory.
 * Uses fs.cpSync which is available in Node 16.7+.
 */
function copyDirSync(src: string, dest: string) {
  fs.cpSync(src, dest, { recursive: true, force: false, errorOnExist: false })
}

/**
 * Seed demo project data on first run.
 * Checks if santi-project-store.json exists in the project data root.
 * If not, copies demo data (JSON + media) to the user's storage directory.
 */
function seedDemoProject() {
  const projectDataRoot = getProjectDataRoot()
  const marker = path.join(projectDataRoot, 'santi-project-store.json')

  if (fs.existsSync(marker)) {
    // Not first run — project store already exists
    return
  }

  const demoPath = getDemoDataPath()
  const demoProjects = path.join(demoPath, 'projects')
  const demoMedia = path.join(demoPath, 'media')

  if (!fs.existsSync(demoProjects)) {
    console.warn('[Seed] Demo data not found at:', demoPath)
    return
  }

  console.log('[Seed] First run detected — seeding demo project...')

  try {
    // Copy project JSON files
    copyDirSync(demoProjects, projectDataRoot)
    console.log('[Seed] Copied project data to:', projectDataRoot)

    // Copy media files
    if (fs.existsSync(demoMedia)) {
      const mediaRoot = getMediaRoot()
      copyDirSync(demoMedia, mediaRoot)
      console.log('[Seed] Copied media files to:', mediaRoot)
    }

    console.log('[Seed] Demo project seeded successfully.')
  } catch (error) {
    console.error('[Seed] Failed to seed demo project:', error)
  }
}

// Register custom protocol for local images
protocol.registerSchemesAsPrivileged([{
  scheme: 'local-image',
  privileges: {
    secure: true,
    supportFetchAPI: true,
    bypassCSP: true,
    stream: true,
  }
}])

app.whenReady().then(() => {
  // Seed demo project on first run (before window creation)
  seedDemoProject()

  scheduleAutoClean()
  // Handle local-image:// protocol
  protocol.handle('local-image', async (request) => {
    try {
      // URL format: local-image://category/filename
      const url = new URL(request.url)
      const category = url.hostname
      const filename = decodeURIComponent(url.pathname.slice(1)) // Remove leading / and decode
      const filePath = path.join(getMediaRoot(), category, filename)

      // Read file directly
      const data = fs.readFileSync(filePath)

      // Determine MIME type based on extension
      const ext = path.extname(filename).toLowerCase()
      const mimeTypes: Record<string, string> = {
        // Images
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        // Videos
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mov': 'video/quicktime',
        '.avi': 'video/x-msvideo',
        '.mkv': 'video/x-matroska',
      }
      const mimeType = mimeTypes[ext] || 'application/octet-stream'

      return new Response(data, {
        headers: { 'Content-Type': mimeType }
      })
    } catch (error) {
      console.error('Failed to load local image:', error)
      return new Response('Image not found', { status: 404 })
    }
  })

  createWindow()
})
