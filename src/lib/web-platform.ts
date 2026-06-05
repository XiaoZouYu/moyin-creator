import packageJson from '../../package.json'

const DB_NAME = 'santi-creator-web-platform'
const DB_VERSION = 1
const KV_STORE = 'kv'
const MEDIA_STORE = 'media'

type KvRecord = {
  key: string
  value: string
}

type MediaRecord = {
  key: string
  category: string
  filename: string
  blob: Blob
  mimeType: string
  size: number
  createdAt: number
}

let dbPromise: Promise<IDBDatabase> | null = null
let localMediaElementsPatched = false

function isElectronRuntime() {
  return !!(
    typeof window !== 'undefined' &&
    (
      window.ipcRenderer ||
      window.electronAPI ||
      navigator.userAgent.includes('Electron')
    )
  )
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(KV_STORE)) {
          db.createObjectStore(KV_STORE, { keyPath: 'key' })
        }
        if (!db.objectStoreNames.contains(MEDIA_STORE)) {
          db.createObjectStore(MEDIA_STORE, { keyPath: 'key' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }
  return dbPromise
}

async function getKv(key: string): Promise<string | null> {
  const db = await openDb()
  const tx = db.transaction(KV_STORE, 'readonly')
  const record = await requestToPromise<KvRecord | undefined>(tx.objectStore(KV_STORE).get(key))
  return record?.value ?? null
}

async function setKv(key: string, value: string): Promise<boolean> {
  const db = await openDb()
  const tx = db.transaction(KV_STORE, 'readwrite')
  tx.objectStore(KV_STORE).put({ key, value } satisfies KvRecord)
  await txDone(tx)
  return true
}

async function deleteKv(key: string): Promise<boolean> {
  const db = await openDb()
  const tx = db.transaction(KV_STORE, 'readwrite')
  tx.objectStore(KV_STORE).delete(key)
  await txDone(tx)
  return true
}

async function getAllKvKeys(): Promise<string[]> {
  const db = await openDb()
  const tx = db.transaction(KV_STORE, 'readonly')
  const keys = await requestToPromise<IDBValidKey[]>(tx.objectStore(KV_STORE).getAllKeys())
  return keys.map(String)
}

async function setMedia(record: MediaRecord): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(MEDIA_STORE, 'readwrite')
  tx.objectStore(MEDIA_STORE).put(record)
  await txDone(tx)
}

async function getMedia(key: string): Promise<MediaRecord | null> {
  const db = await openDb()
  const tx = db.transaction(MEDIA_STORE, 'readonly')
  const record = await requestToPromise<MediaRecord | undefined>(tx.objectStore(MEDIA_STORE).get(key))
  return record ?? null
}

async function deleteMedia(key: string): Promise<boolean> {
  const db = await openDb()
  const tx = db.transaction(MEDIA_STORE, 'readwrite')
  tx.objectStore(MEDIA_STORE).delete(key)
  await txDone(tx)
  return true
}

async function getAllMedia(): Promise<MediaRecord[]> {
  const db = await openDb()
  const tx = db.transaction(MEDIA_STORE, 'readonly')
  return requestToPromise<MediaRecord[]>(tx.objectStore(MEDIA_STORE).getAll())
}

function normalizeDirPrefix(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, '')
}

function parseLocalMediaUrl(value: string): { key: string; category: string; filename: string } | null {
  const match = value.match(/^local-image:\/\/([^/]+)\/(.+)$/)
  if (!match) return null
  const category = decodeURIComponent(match[1])
  const filename = decodeURIComponent(match[2])
  return {
    key: `${category}/${filename}`,
    category,
    filename,
  }
}

function safeFilename(filename: string): string {
  const fallback = `asset-${Date.now()}.png`
  const base = decodeURIComponent(filename || fallback)
    .split(/[\\/]/)
    .pop()
    ?.trim() || fallback
  return base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/webp':
      return 'webp'
    case 'image/gif':
      return 'gif'
    case 'image/svg+xml':
      return 'svg'
    case 'video/webm':
      return 'webm'
    case 'video/quicktime':
      return 'mov'
    case 'video/mp4':
      return 'mp4'
    case 'image/png':
    default:
      return 'png'
  }
}

function ensureExtension(filename: string, mimeType: string): string {
  if (/\.[a-z0-9]{2,8}$/i.test(filename)) return filename
  return `${filename}.${extensionForMimeType(mimeType)}`
}

function isHttpUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://')
}

function shouldProxyUrl(targetUrl: string): boolean {
  if (!isHttpUrl(targetUrl)) return false
  const configuredProxy = import.meta.env.VITE_WEB_API_PROXY_URL
  if (configuredProxy) return true
  try {
    return new URL(targetUrl).origin !== window.location.origin
  } catch {
    return false
  }
}

function buildProxyUrl(targetUrl: string): string {
  const configuredProxy = import.meta.env.VITE_WEB_API_PROXY_URL
  if (configuredProxy) {
    const proxyUrl = new URL(configuredProxy, window.location.origin)
    proxyUrl.searchParams.set('url', targetUrl)
    return proxyUrl.toString()
  }
  return `/__api_proxy?url=${encodeURIComponent(targetUrl)}`
}

function headersToRecord(headers?: HeadersInit): Record<string, string> {
  const record: Record<string, string> = {}
  new Headers(headers).forEach((value, key) => {
    record[key] = value
  })
  return record
}

function responseHeadersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {}
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value
  })
  return record
}

async function serializeFormData(formData: FormData): Promise<Array<{
  name: string
  value?: string
  fileName?: string
  mimeType?: string
  dataBase64?: string
}>> {
  const fields: Array<{
    name: string
    value?: string
    fileName?: string
    mimeType?: string
    dataBase64?: string
  }> = []

  for (const [name, value] of formData.entries()) {
    if (typeof value === 'string') {
      fields.push({ name, value })
      continue
    }

    fields.push({
      name,
      fileName: value instanceof File ? value.name : 'upload.bin',
      mimeType: value.type || 'application/octet-stream',
      dataBase64: arrayBufferToBase64(await value.arrayBuffer()),
    })
  }

  return fields
}

function removeContentType(headers: Record<string, string>): Record<string, string> {
  const result = { ...headers }
  for (const key of Object.keys(result)) {
    if (key.toLowerCase() === 'content-type') {
      delete result[key]
    }
  }
  return result
}

async function webFetch(targetUrl: string, init?: RequestInit): Promise<Response> {
  if (!shouldProxyUrl(targetUrl)) {
    return fetch(targetUrl, init)
  }

  let originalHeaders = headersToRecord(init?.headers)
  const headers: Record<string, string> = {
  }
  let proxyBody = init?.body
  if (init?.body instanceof FormData) {
    originalHeaders = removeContentType(originalHeaders)
    headers['x-proxy-form-data'] = '1'
    headers['content-type'] = 'application/json'
    proxyBody = JSON.stringify(await serializeFormData(init.body))
  }
  headers['x-proxy-headers'] = JSON.stringify(originalHeaders)

  const proxyUrl = buildProxyUrl(targetUrl)
  const response = await fetch(proxyUrl, {
    ...init,
    headers,
    body: proxyBody,
  })

  const configuredProxy = import.meta.env.VITE_WEB_API_PROXY_URL
  const contentType = response.headers.get('content-type') || ''
  if (!configuredProxy && response.status === 404 && contentType.includes('text/html')) {
    throw new Error('Web API proxy /__api_proxy 不可用；请使用 npm run dev:web / preview:web，或在部署环境配置 VITE_WEB_API_PROXY_URL')
  }
  if (!configuredProxy && response.ok && contentType.includes('text/html')) {
    throw new Error('Web API proxy /__api_proxy 返回了 HTML，说明当前静态服务器没有代理接口；请配置 VITE_WEB_API_PROXY_URL 或后端反向代理')
  }

  return response
}

let cloudStorageUnavailableUntil = 0
let cloudMediaUnavailableUntil = 0

function markCloudStorageUnavailable() {
  cloudStorageUnavailableUntil = Date.now() + 30_000
}

function markCloudMediaUnavailable() {
  cloudMediaUnavailableUntil = Date.now() + 30_000
}

async function fetchCloudJson<T = any>(
  path: string,
  init?: RequestInit,
  options?: { media?: boolean },
): Promise<T> {
  const isMedia = !!options?.media
  if (Date.now() < (isMedia ? cloudMediaUnavailableUntil : cloudStorageUnavailableUntil)) {
    throw new Error('Cloud persistence API is temporarily unavailable')
  }

  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
  })
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) {
    if (isMedia) markCloudMediaUnavailable()
    else markCloudStorageUnavailable()
    throw new Error('Cloud persistence API did not return JSON')
  }

  const data = await response.json()
  if (!response.ok) {
    if (response.status === 404 || response.status === 503) {
      if (isMedia) markCloudMediaUnavailable()
      else markCloudStorageUnavailable()
    }
    throw new Error(data?.detail || data?.error || `Cloud persistence API failed: ${response.status}`)
  }

  return data as T
}

async function cloudStorageGetItem(key: string): Promise<string | null> {
  const data = await fetchCloudJson<{ value: string | null }>(`/__cloud_storage/item?key=${encodeURIComponent(key)}`)
  return data.value ?? null
}

async function cloudStorageSetItem(key: string, value: string): Promise<boolean> {
  const data = await fetchCloudJson<{ success: boolean }>('/__cloud_storage/item', {
    method: 'PUT',
    body: JSON.stringify({ key, value }),
  })
  return !!data.success
}

async function cloudStorageRemoveItem(key: string): Promise<boolean> {
  const data = await fetchCloudJson<{ success: boolean }>(`/__cloud_storage/item?key=${encodeURIComponent(key)}`, {
    method: 'DELETE',
  })
  return !!data.success
}

async function cloudStorageExists(key: string): Promise<boolean> {
  const data = await fetchCloudJson<{ exists: boolean }>(`/__cloud_storage/exists?key=${encodeURIComponent(key)}`)
  return !!data.exists
}

async function cloudStorageListKeys(prefix: string): Promise<string[]> {
  const data = await fetchCloudJson<{ keys: string[] }>(`/__cloud_storage/keys?prefix=${encodeURIComponent(prefix)}`)
  return Array.isArray(data.keys) ? data.keys : []
}

async function cloudStorageListDirs(prefix: string): Promise<string[]> {
  const data = await fetchCloudJson<{ dirs: string[] }>(`/__cloud_storage/dirs?prefix=${encodeURIComponent(prefix)}`)
  return Array.isArray(data.dirs) ? data.dirs : []
}

async function cloudStorageRemoveDir(prefix: string): Promise<boolean> {
  const data = await fetchCloudJson<{ success: boolean }>(`/__cloud_storage/dir?prefix=${encodeURIComponent(prefix)}`, {
    method: 'DELETE',
  })
  return !!data.success
}

async function cloudMediaSave(key: string, blob: Blob): Promise<boolean> {
  const data = await fetchCloudJson<{ success: boolean }>('/__cloud_media/item', {
    method: 'PUT',
    body: JSON.stringify({
      key,
      mimeType: blob.type || 'application/octet-stream',
      dataBase64: arrayBufferToBase64(await blob.arrayBuffer()),
    }),
  }, { media: true })
  return !!data.success
}

async function cloudMediaUrl(key: string): Promise<string | null> {
  const data = await fetchCloudJson<{ url?: string }>(`/__cloud_media/url?key=${encodeURIComponent(key)}`, undefined, { media: true })
  return data.url || null
}

async function cloudMediaBase64(key: string): Promise<{ base64: string; mimeType?: string; size?: number } | null> {
  const data = await fetchCloudJson<{ base64?: string; mimeType?: string; size?: number }>(
    `/__cloud_media/base64?key=${encodeURIComponent(key)}`,
    undefined,
    { media: true },
  )
  return data.base64 ? { base64: data.base64, mimeType: data.mimeType, size: data.size } : null
}

async function cloudMediaDelete(key: string): Promise<boolean> {
  const data = await fetchCloudJson<{ success: boolean }>(`/__cloud_media/item?key=${encodeURIComponent(key)}`, {
    method: 'DELETE',
  }, { media: true })
  return !!data.success
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function base64ToBlob(value: string, mimeType = 'application/octet-stream'): Blob {
  const payload = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value
  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return new Blob([bytes], { type: mimeType })
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

async function sourceToBlob(source: string): Promise<Blob> {
  if (source.startsWith('local-image://')) {
    const local = parseLocalMediaUrl(source)
    if (!local) throw new Error('Invalid local media URL')
    try {
      const cloud = await cloudMediaBase64(local.key)
      if (cloud?.base64) {
        return base64ToBlob(cloud.base64, cloud.mimeType || 'application/octet-stream')
      }
    } catch {
      // Fall back to browser-local media cache.
    }
    const record = await getMedia(local.key)
    if (!record) throw new Error(`Local media not found: ${source}`)
    return record.blob
  }
  if (source.startsWith('data:') || source.startsWith('blob:')) {
    const response = await fetch(source)
    return response.blob()
  }
  const response = await webFetch(source)
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status}`)
  }
  return response.blob()
}

function bytesStartWith(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false
  return signature.every((byte, index) => bytes[index] === byte)
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return ''
  return String.fromCharCode(...bytes.slice(offset, offset + length))
}

function inferImageMimeType(bytes: Uint8Array): string | null {
  if (bytesStartWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (bytesStartWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (asciiAt(bytes, 0, 4) === 'RIFF' && asciiAt(bytes, 8, 4) === 'WEBP') return 'image/webp'
  if (asciiAt(bytes, 0, 6) === 'GIF87a' || asciiAt(bytes, 0, 6) === 'GIF89a') return 'image/gif'
  if (bytesStartWith(bytes, [0x42, 0x4d])) return 'image/bmp'
  const prefix = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, 256))).trimStart().toLowerCase()
  if (prefix.startsWith('<svg')) return 'image/svg+xml'
  return null
}

async function assertImageUploadBlob(blob: Blob): Promise<void> {
  const mimeType = (blob.type || '').toLowerCase()
  if (mimeType && !mimeType.startsWith('image/')) {
    throw new Error(`Source is not an image response (${mimeType})`)
  }
  const bytes = new Uint8Array(await blob.slice(0, 512).arrayBuffer())
  if (!inferImageMimeType(bytes)) {
    throw new Error('Source is not a supported image response')
  }
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = safeFilename(filename)
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function buildRequestBody(options: NonNullable<Window['electronAPI']> extends { apiFetch: (arg: infer T) => unknown } ? T : never): Promise<BodyInit | undefined> {
  if (options.formData) {
    const formData = new FormData()
    for (const field of options.formData) {
      if (field.dataBase64) {
        formData.append(
          field.name,
          base64ToBlob(field.dataBase64, field.mimeType || 'application/octet-stream'),
          field.fileName || 'upload.bin',
        )
      } else {
        formData.append(field.name, field.value ?? '')
      }
    }
    return formData
  }
  if (options.bodyBase64) {
    return base64ToBlob(options.bodyBase64)
  }
  return options.body
}

async function apiFetch(options: Parameters<NonNullable<Window['electronAPI']>['apiFetch']>[0]) {
  const controller = new AbortController()
  const timeout = options.timeoutMs
    ? window.setTimeout(() => controller.abort(), options.timeoutMs)
    : undefined

  try {
    const body = await buildRequestBody(options as never)
    const headers = headersToRecord(options.headers)
    if (body instanceof FormData) {
      delete headers['content-type']
      delete headers['Content-Type']
    }

    const response = await webFetch(options.url, {
      method: options.method || (body ? 'POST' : 'GET'),
      headers,
      body,
      signal: controller.signal,
    })
    const responseHeaders = responseHeadersToRecord(response.headers)

    if (options.responseType === 'base64') {
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body: '',
        bodyBase64: arrayBufferToBase64(await response.arrayBuffer()),
      }
    }

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: await response.text(),
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      statusText: '',
      headers: {},
      body: '',
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    if (timeout) window.clearTimeout(timeout)
  }
}

function resolveUploadUrl(provider: any): string {
  const uploadPath = String(provider.uploadPath || '').trim()
  if (isHttpUrl(uploadPath)) return uploadPath
  const baseUrl = String(provider.baseUrl || '').trim().replace(/\/*$/, '')
  if (!baseUrl) return ''
  if (!uploadPath) return baseUrl
  return `${baseUrl}${uploadPath.startsWith('/') ? uploadPath : `/${uploadPath}`}`
}

function getByPath(obj: unknown, path?: string): unknown {
  if (!obj || typeof obj !== 'object' || !path) return undefined
  return path.split('.').reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[key]
  }, obj)
}

function extractFirstHttpUrl(value: string): string | undefined {
  return value.match(/https?:\/\/[^\s"'<>]+/i)?.[0]
}

async function sourceToBase64Payload(source: string): Promise<string> {
  const blob = await sourceToBlob(source)
  await assertImageUploadBlob(blob)
  const dataUrl = await blobToDataUrl(blob)
  return dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl
}

function installFileStorage() {
  if (window.fileStorage) return

  window.fileStorage = {
    getItem: async (key) => {
      try {
        const cloudValue = await cloudStorageGetItem(key)
        if (cloudValue !== null) {
          await setKv(key, cloudValue).catch(() => undefined)
          return cloudValue
        }
      } catch {
        // Fall back to browser-local IndexedDB.
      }
      return getKv(key)
    },
    setItem: async (key, value) => {
      await setKv(key, value)
      try {
        return await cloudStorageSetItem(key, value)
      } catch {
        return true
      }
    },
    removeItem: async (key) => {
      await deleteKv(key).catch(() => undefined)
      try {
        return await cloudStorageRemoveItem(key)
      } catch {
        return true
      }
    },
    exists: async (key) => {
      try {
        if (await cloudStorageExists(key)) return true
      } catch {
        // Fall back to browser-local IndexedDB.
      }
      return (await getKv(key)) !== null
    },
    listKeys: async (prefix) => {
      const normalized = normalizeDirPrefix(prefix)
      const start = normalized ? `${normalized}/` : ''
      try {
        const cloudKeys = await cloudStorageListKeys(normalized)
        if (cloudKeys.length > 0) return cloudKeys
      } catch {
        // Fall back to browser-local IndexedDB.
      }
      return (await getAllKvKeys()).filter((key) => key === normalized || key.startsWith(start))
    },
    listDirs: async (prefix) => {
      const normalized = normalizeDirPrefix(prefix)
      try {
        const cloudDirs = await cloudStorageListDirs(normalized)
        if (cloudDirs.length > 0) return cloudDirs
      } catch {
        // Fall back to browser-local IndexedDB.
      }
      const start = normalized ? `${normalized}/` : ''
      const dirs = new Set<string>()
      for (const key of await getAllKvKeys()) {
        if (!key.startsWith(start)) continue
        const first = key.slice(start.length).split('/')[0]
        if (first && first !== '_migrated') dirs.add(first)
      }
      return [...dirs]
    },
    removeDir: async (prefix) => {
      const normalized = normalizeDirPrefix(prefix)
      const start = normalized ? `${normalized}/` : ''
      const keys = await getAllKvKeys()
      await Promise.all(keys.filter((key) => key === normalized || key.startsWith(start)).map(deleteKv))
      try {
        await cloudStorageRemoveDir(normalized)
      } catch {
        // Local deletion has already succeeded.
      }
      return true
    },
  }
}

function installImageStorage() {
  if (window.imageStorage) return

  const objectUrlCache = new Map<string, string>()

  window.imageStorage = {
    saveImage: async (url, category, filename) => {
      try {
        if (url.startsWith('local-image://')) {
          return { success: true, localPath: url }
        }

        const blob = await sourceToBlob(url)
        const safeName = ensureExtension(safeFilename(filename), blob.type || 'application/octet-stream')
        const key = `${category}/${safeName}`
        await setMedia({
          key,
          category,
          filename: safeName,
          blob,
          mimeType: blob.type || 'application/octet-stream',
          size: blob.size,
          createdAt: Date.now(),
        })
        try {
          await cloudMediaSave(key, blob)
        } catch (error) {
          console.warn('[web-platform] Cloud media save failed, using local cache only:', error)
        }
        return { success: true, localPath: `local-image://${category}/${encodeURIComponent(safeName)}` }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    getImagePath: async (localPath) => {
      const local = parseLocalMediaUrl(localPath)
      if (!local) return localPath
      const record = await getMedia(local.key)
      if (record) {
        const cached = objectUrlCache.get(local.key)
        if (cached) return cached
        const url = URL.createObjectURL(record.blob)
        objectUrlCache.set(local.key, url)
        return url
      }
      try {
        return await cloudMediaUrl(local.key)
      } catch {
        return null
      }
    },
    deleteImage: async (localPath) => {
      const local = parseLocalMediaUrl(localPath)
      if (!local) return false
      const cached = objectUrlCache.get(local.key)
      if (cached) URL.revokeObjectURL(cached)
      objectUrlCache.delete(local.key)
      const localDeleted = await deleteMedia(local.key).catch(() => false)
      try {
        return await cloudMediaDelete(local.key)
      } catch {
        return localDeleted
      }
    },
    readAsBase64: async (localPath) => {
      try {
        const blob = await sourceToBlob(localPath)
        return {
          success: true,
          base64: await blobToDataUrl(blob),
          mimeType: blob.type || 'application/octet-stream',
          size: blob.size,
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    getAbsolutePath: async () => null,
  } as Window['imageStorage']
}

function installElectronApi() {
  if (window.electronAPI) return

  window.electronAPI = {
    saveFileDialog: async ({ localPath, defaultPath }) => {
      try {
        const blob = await sourceToBlob(localPath)
        triggerDownload(blob, defaultPath || 'download')
        return { success: true, filePath: defaultPath }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    apiFetch,
  }
}

function installStorageManager() {
  if (window.storageManager) return

  window.storageManager = {
    getPaths: async () => ({
      basePath: 'Browser IndexedDB / OPFS',
      projectPath: 'Browser IndexedDB / projects',
      mediaPath: 'Browser IndexedDB / media',
      cachePath: 'Browser HTTP cache',
    }),
    selectDirectory: async () => null,
    validateDataDir: async () => ({ valid: false, error: 'Directory selection is only available in desktop mode.' }),
    moveData: async () => ({ success: false, error: 'Changing the storage directory is only available in desktop mode.' }),
    linkData: async () => ({ success: false, error: 'Linking an external data directory is only available in desktop mode.' }),
    exportData: async () => ({ success: false, error: 'Directory export is only available in desktop mode.' }),
    importData: async () => ({ success: false, error: 'Directory import is only available in desktop mode.' }),
    getCacheSize: async () => ({
      total: (await getAllMedia()).reduce((sum, item) => sum + (item.size || 0), 0),
      details: [{ path: 'Browser media store', size: (await getAllMedia()).reduce((sum, item) => sum + (item.size || 0), 0) }],
    }),
    clearCache: async () => ({ success: true, clearedBytes: 0 }),
    updateConfig: async (config) => setKv('_web/storage-config', JSON.stringify(config)),
  }
}

function installAppUpdater() {
  if (window.appUpdater) return

  window.appUpdater = {
    getCurrentVersion: async () => packageJson.version,
    checkForUpdates: async () => ({
      success: true,
      currentVersion: packageJson.version,
      hasUpdate: false,
      update: null,
    }),
    openExternalLink: async (url) => {
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return { success: false, error: 'Unsupported URL protocol' }
        }
        window.open(parsed.toString(), '_blank', 'noopener,noreferrer')
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

function installImageHostUploader() {
  if (window.imageHostUploader) return

  window.imageHostUploader = {
    upload: async ({ provider, apiKey, imageData, options }) => {
      try {
        const uploadUrl = resolveUploadUrl(provider)
        if (!uploadUrl) return { success: false, error: 'Image host upload URL is not configured.' }

        const fieldName = provider.imageField || 'image'
        const nameField = provider.nameField || 'name'
        const payloadType = provider.imagePayloadType || 'base64'
        const formData: NonNullable<Parameters<NonNullable<Window['electronAPI']>['apiFetch']>[0]['formData']> = []

        Object.entries(provider.staticFormFields || {}).forEach(([name, value]) => {
          formData.push({ name, value: String(value) })
        })
        if (provider.apiKeyFormField && apiKey) {
          formData.push({ name: provider.apiKeyFormField, value: apiKey })
        }
        if (payloadType === 'file') {
          const blob = await sourceToBlob(imageData)
          await assertImageUploadBlob(blob)
          const filename = ensureExtension(safeFilename(options?.name || 'upload'), blob.type || 'image/png')
          formData.push({
            name: fieldName,
            fileName: filename,
            mimeType: blob.type || 'image/png',
            dataBase64: arrayBufferToBase64(await blob.arrayBuffer()),
          })
        } else {
          formData.push({ name: fieldName, value: await sourceToBase64Payload(imageData) })
        }
        if (options?.name) {
          formData.push({ name: nameField, value: options.name })
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

        const response = await apiFetch({
          url: url.toString(),
          method: 'POST',
          headers,
          formData,
        })
        let data: unknown = null
        try {
          data = response.body ? JSON.parse(response.body) : null
        } catch {
          data = null
        }

        if (!response.ok) {
          const message = getByPath(data, 'error.message') || getByPath(data, 'message') || response.body || response.statusText
          return { success: false, error: String(message || 'Upload failed') }
        }

        const urlField = getByPath(data, provider.responseUrlField || 'url')
        const deleteField = getByPath(data, provider.responseDeleteUrlField || 'delete_url')
        const extractedUrl = extractFirstHttpUrl(response.body.trim())
        const uploadedUrl = urlField ? String(urlField) : extractedUrl
        if (!uploadedUrl) {
          return { success: false, error: 'Image host response did not contain a URL.' }
        }
        return {
          success: true,
          url: uploadedUrl,
          deleteUrl: deleteField ? String(deleteField) : undefined,
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

function patchLocalMediaElements() {
  if (localMediaElementsPatched) return
  localMediaElementsPatched = true

  const originalSetAttribute = Element.prototype.setAttribute
  const originalGetAttribute = Element.prototype.getAttribute

  const resolveSrc = (element: Element, rawValue: string, apply: (value: string) => void) => {
    if (!rawValue.startsWith('local-image://')) {
      apply(rawValue)
      return
    }

    originalSetAttribute.call(element, 'data-web-local-src', rawValue)
    window.imageStorage?.getImagePath(rawValue).then((resolved) => {
      if (!resolved) return
      if (originalGetAttribute.call(element, 'data-web-local-src') !== rawValue) return
      apply(resolved)
    }).catch(() => apply(rawValue))
  }

  const patchSrcDescriptor = (prototype: object) => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'src')
    if (!descriptor?.set || !descriptor?.get) return
    Object.defineProperty(prototype, 'src', {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(value: string) {
        resolveSrc(this as Element, String(value), (resolved) => descriptor.set!.call(this, resolved))
      },
    })
  }

  patchSrcDescriptor(HTMLImageElement.prototype)
  patchSrcDescriptor(HTMLMediaElement.prototype)
  patchSrcDescriptor(HTMLSourceElement.prototype)

  Element.prototype.setAttribute = function patchedSetAttribute(name: string, value: string) {
    const isSrc = name.toLowerCase() === 'src'
    const isMediaElement = this instanceof HTMLImageElement ||
      this instanceof HTMLMediaElement ||
      this instanceof HTMLSourceElement

    if (isSrc && isMediaElement) {
      resolveSrc(this, String(value), (resolved) => originalSetAttribute.call(this, name, resolved))
      return
    }

    originalSetAttribute.call(this, name, value)
  }
}

export function installWebPlatformAdapters() {
  if (typeof window === 'undefined' || isElectronRuntime() || !('indexedDB' in window)) return

  installFileStorage()
  installImageStorage()
  installElectronApi()
  installStorageManager()
  installAppUpdater()
  installImageHostUploader()
  patchLocalMediaElements()
}
