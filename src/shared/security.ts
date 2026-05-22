import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { isIP } from 'node:net'
import { dirname, relative, resolve, sep } from 'node:path'

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/g
const MAX_LABEL_LENGTH = 256
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])
const BLOCKED_HOSTS = new Set(['metadata.google.internal', 'metadata.google.com'])

export const MAX_FETCH_BYTES = 52_428_800
export const MAX_TEXT_BYTES = 10_485_760

function inferGraphBase(graphPath: string): string {
  const resolved = resolve(graphPath)
  const parts = resolved.split(sep)
  const outIndex = parts.lastIndexOf('out')

  if (outIndex >= 0) {
    const baseParts = parts.slice(0, outIndex + 1)
    if (baseParts[0] === '') {
      return `${sep}${baseParts.slice(1).join(sep)}`
    }
    return baseParts.join(sep)
  }

  return resolve('out')
}

export function findNearestExistingAncestor(targetPath: string): string | null {
  let currentPath = resolve(targetPath)

  while (!existsSync(currentPath)) {
    const parentPath = dirname(currentPath)
    if (parentPath === currentPath) {
      return null
    }
    currentPath = parentPath
  }

  return currentPath
}

export function validateGraphPath(graphPath: string, base?: string): string {
  const resolvedBase = resolve(base ?? inferGraphBase(graphPath))
  if (!existsSync(resolvedBase)) {
    throw new Error(`Graph base directory does not exist: ${resolvedBase}. Run sadeem first to build the graph.`)
  }

  const resolvedPath = resolve(graphPath)
  const basePrefix = resolvedBase.endsWith(sep) ? resolvedBase : `${resolvedBase}${sep}`
  if (resolvedPath !== resolvedBase && !resolvedPath.startsWith(basePrefix)) {
    throw new Error(`Path ${JSON.stringify(graphPath)} escapes the allowed directory ${resolvedBase}. Only paths inside out/ are permitted.`)
  }

  if (!existsSync(resolvedPath)) {
    throw new Error(`Graph file not found: ${resolvedPath}`)
  }

  const realBase = realpathSync(resolvedBase)
  const realPath = realpathSync(resolvedPath)
  const realBasePrefix = realBase.endsWith(sep) ? realBase : `${realBase}${sep}`
  if (realPath !== realBase && !realPath.startsWith(realBasePrefix)) {
    throw new Error(`Path ${JSON.stringify(graphPath)} escapes the allowed directory ${resolvedBase}. Only paths inside out/ are permitted.`)
  }

  return realPath
}

export function validateGraphOutputPath(targetPath: string, base = 'out'): string {
  const resolvedBase = resolve(base)
  const resolvedTarget = resolve(targetPath)
  const basePrefix = resolvedBase.endsWith(sep) ? resolvedBase : `${resolvedBase}${sep}`
  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(basePrefix)) {
    throw new Error(`Path ${JSON.stringify(targetPath)} escapes the allowed directory ${resolvedBase}. Only paths inside out/ are permitted.`)
  }

  if (existsSync(resolvedBase)) {
    const realBase = realpathSync(resolvedBase)
    if (lstatSync(resolvedBase).isSymbolicLink()) {
      throw new Error(`Path ${JSON.stringify(targetPath)} escapes the allowed directory ${resolvedBase}. Only paths inside out/ are permitted.`)
    }
    const existingAncestor = findNearestExistingAncestor(resolvedTarget)
    const realTarget = existingAncestor === null
      ? resolvedTarget
      : resolve(realpathSync(existingAncestor), relative(existingAncestor, resolvedTarget))
    const realBasePrefix = realBase.endsWith(sep) ? realBase : `${realBase}${sep}`
    if (realTarget !== realBase && !realTarget.startsWith(realBasePrefix)) {
      throw new Error(`Path ${JSON.stringify(targetPath)} escapes the allowed directory ${resolvedBase}. Only paths inside out/ are permitted.`)
    }
  }

  return resolvedTarget
}

function isPrivateAddress(hostname: string): boolean {
  const normalizedHost = hostname.toLowerCase()
  if (normalizedHost === 'localhost' || normalizedHost === '0.0.0.0' || normalizedHost.endsWith('.localhost') || normalizedHost.endsWith('.local')) {
    return true
  }

  const ipVersion = isIP(hostname)
  if (ipVersion === 4) {
    const octets = hostname.split('.').map((part) => Number(part))
    const [first = 0, second = 0] = octets
    if (first === 10 || first === 127 || first === 0) {
      return true
    }
    if (first === 169 && second === 254) {
      return true
    }
    if (first === 172 && second >= 16 && second <= 31) {
      return true
    }
    if (first === 192 && second === 168) {
      return true
    }
    if (first === 100 && second >= 64 && second <= 127) {
      return true
    }
    if (first >= 224) {
      return true
    }
  }

  if (ipVersion === 6) {
    const lower = hostname.toLowerCase()
    if (lower === '::1' || lower === '::') {
      return true
    }
    if (lower.includes(':') && (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:'))) {
      return true
    }
  }

  return false
}

export function validateUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Blocked URL scheme '' - only http and https are allowed. Got: ${JSON.stringify(url)}`)
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`Blocked URL scheme '${parsed.protocol.replace(/:$/, '')}' - only http and https are allowed. Got: ${JSON.stringify(url)}`)
  }

  const hostname = parsed.hostname.toLowerCase()
  if (BLOCKED_HOSTS.has(hostname)) {
    throw new Error(`Blocked cloud metadata endpoint '${hostname}'. Got: ${JSON.stringify(url)}`)
  }

  if (isPrivateAddress(hostname)) {
    throw new Error(`Blocked private/internal IP '${hostname}'. Got: ${JSON.stringify(url)}`)
  }

  return url
}

async function fetchWithRedirects(url: string, timeoutMs: number): Promise<{ response: Response; finalUrl: string }> {
  if (typeof fetch !== 'function') {
    throw new Error('fetch is not available in this runtime')
  }

  let currentUrl = url
  for (let redirectCount = 0; redirectCount < 5; redirectCount += 1) {
    validateUrl(currentUrl)
    const response = await fetch(currentUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 sadeem/1.0' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) {
        return { response, finalUrl: currentUrl }
      }
      currentUrl = new URL(location, currentUrl).toString()
      continue
    }

    return { response, finalUrl: currentUrl }
  }

  throw new Error(`Too many redirects while fetching ${JSON.stringify(url)}`)
}

function normalizeContentType(value: string | null): string {
  return value?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

export async function safeFetchResponseWithMetadata(
  url: string,
  timeout: number = 30_000,
): Promise<{ response: Response; finalUrl: string; contentType: string }> {
  validateUrl(url)
  const { response, finalUrl } = await fetchWithRedirects(url, timeout)
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status}`)
  }

  return {
    response,
    finalUrl,
    contentType: normalizeContentType(response.headers.get('content-type')),
  }
}

export async function readResponseBytes(response: Response, url: string, maxBytes: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > maxBytes) {
    throw new Error(`Response from ${JSON.stringify(url)} exceeds size limit (${Math.floor(maxBytes / 1_048_576)} MB). Aborting download.`)
  }

  return bytes
}

export async function safeFetchWithMetadata(
  url: string,
  maxBytes: number = MAX_FETCH_BYTES,
  timeout: number = 30_000,
): Promise<{ bytes: Uint8Array; finalUrl: string; contentType: string }> {
  const { response, finalUrl, contentType } = await safeFetchResponseWithMetadata(url, timeout)
  const bytes = await readResponseBytes(response, url, maxBytes)
  return { bytes, finalUrl, contentType }
}

export async function safeFetch(url: string, maxBytes: number = MAX_FETCH_BYTES, timeout: number = 30_000): Promise<Uint8Array> {
  const { bytes } = await safeFetchWithMetadata(url, maxBytes, timeout)
  return bytes
}

export async function safeFetchText(url: string, maxBytes: number = MAX_TEXT_BYTES, timeout: number = 15_000): Promise<string> {
  const { bytes } = await safeFetchWithMetadata(url, maxBytes, timeout)
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

export async function safeFetchTextWithMetadata(
  url: string,
  maxBytes: number = MAX_TEXT_BYTES,
  timeout: number = 15_000,
): Promise<{ text: string; finalUrl: string; contentType: string }> {
  const { bytes, finalUrl, contentType } = await safeFetchWithMetadata(url, maxBytes, timeout)
  return {
    text: new TextDecoder('utf-8', { fatal: false }).decode(bytes),
    finalUrl,
    contentType,
  }
}

export function sanitizeLabel(text: string): string {
  const sanitized = text.replace(CONTROL_CHAR_RE, '')
  return sanitized.length > MAX_LABEL_LENGTH ? sanitized.slice(0, MAX_LABEL_LENGTH) : sanitized
}
