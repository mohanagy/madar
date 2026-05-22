import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { builtinCapabilityRegistry } from './capabilities.js'
import { dispatchIngest, type IngestHandlerMap } from './ingest/dispatch.js'
import type { IngestOptions, UrlType } from './ingest/types.js'
import { fetchHackerNews } from './ingest-hackernews.js'
import { detectUrlType } from './ingest/url-type.js'
import { fetchGitHub } from './ingest-github.js'
import { fetchReddit } from './ingest-reddit.js'
import { fetchTweet } from './ingest-social.js'
import { fetchYouTubeAsset } from './ingest-youtube.js'
import { buildWebpageAsset, fetchWebpage, resolveContributor, safeFilename, stripHtml, yamlString } from './ingest-web.js'
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from '../pipeline/detect.js'
import { writeBinaryIngestSidecar } from '../shared/binary-ingest-sidecar.js'
import { MAX_FETCH_BYTES, MAX_TEXT_BYTES, readResponseBytes, safeFetchResponseWithMetadata, safeFetchText, safeFetchWithMetadata, validateUrl } from '../shared/security.js'

export interface SaveQueryOptions {
  queryType?: string
  sourceNodes?: string[]
}
export type { IngestOptions, UrlType } from './ingest/types.js'
export { detectUrlType } from './ingest/url-type.js'
const MAX_SOURCE_NODES = 10

function timestampSlug(date: Date): string {
  const parts = [date.getUTCFullYear().toString().padStart(4, '0'), (date.getUTCMonth() + 1).toString().padStart(2, '0'), date.getUTCDate().toString().padStart(2, '0')]
  const time = [date.getUTCHours().toString().padStart(2, '0'), date.getUTCMinutes().toString().padStart(2, '0'), date.getUTCSeconds().toString().padStart(2, '0')]
  return `${parts.join('')}_${time.join('')}`
}

function questionSlug(question: string): string {
  return (
    question
      .toLowerCase()
      .replace(/[^\w]/g, '_')
      .slice(0, 50)
      .replace(/^_+|_+$/g, '') || 'query'
  )
}

function ensureUniquePath(directory: string, fileName: string): string {
  let candidate = join(directory, fileName)
  let counter = 1
  while (existsSync(candidate)) {
    const extensionIndex = fileName.lastIndexOf('.')
    const stem = extensionIndex >= 0 ? fileName.slice(0, extensionIndex) : fileName
    const extension = extensionIndex >= 0 ? fileName.slice(extensionIndex) : ''
    candidate = join(directory, `${stem}_${counter}${extension}`)
    counter += 1
  }
  return candidate
}

async function fetchArxiv(url: string, options: IngestOptions): Promise<{ content: string; fileName: string }> {
  const match = /(\d{4}\.\d{4,5})/.exec(url)
  if (!match) {
    return fetchWebpage(url, options)
  }

  const arxivId = match[1] ?? ''
  const html = await safeFetchText(`https://export.arxiv.org/abs/${arxivId}`)
  const titleMatch = /class="title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i.exec(html)
  const abstractMatch = /class="abstract[^"]*"[^>]*>([\s\S]*?)<\/blockquote>/i.exec(html)
  const authorsMatch = /class="authors"[^>]*>([\s\S]*?)<\/div>/i.exec(html)
  const title = stripHtml(titleMatch?.[1] ?? arxivId)
  const abstract = stripHtml(abstractMatch?.[1] ?? '')
  const authors = stripHtml(authorsMatch?.[1] ?? '')
  const capturedAt = new Date().toISOString()

  return {
    fileName: `arxiv_${arxivId.replace('.', '_')}.md`,
    content: `---\nsource_url: ${yamlString(url)}\narxiv_id: ${yamlString(arxivId)}\ntype: paper\ntitle: ${yamlString(title)}\npaper_authors: ${yamlString(authors)}\ncaptured_at: ${yamlString(capturedAt)}\ncontributor: ${yamlString(resolveContributor(options))}\n---\n\n# ${title}\n\n**Authors:** ${authors}\n**arXiv:** ${arxivId}\n\n## Abstract\n\n${abstract}\n\nSource: ${url}\n`,
  }
}

function suffixFromUrl(url: string, fallback: string): string {
  const pathname = new URL(url).pathname
  return pathname.includes('.') ? pathname.slice(pathname.lastIndexOf('.')) : fallback
}

function binarySuffixFromUrl(url: string): string | null {
  const pathname = new URL(url).pathname.toLowerCase()
  const suffix = pathname.includes('.') ? pathname.slice(pathname.lastIndexOf('.')) : ''
  if (!suffix) {
    return null
  }
  if (suffix === '.pdf' || IMAGE_EXTENSIONS.has(suffix) || AUDIO_EXTENSIONS.has(suffix) || VIDEO_EXTENSIONS.has(suffix)) {
    return suffix
  }
  return null
}

function binarySuffixFromContentType(contentType: string): string | null {
  const normalized = contentType.trim().toLowerCase()
  if (!normalized) {
    return null
  }
  if (normalized === 'application/pdf') {
    return '.pdf'
  }

  const exact = new Map<string, string>([
    ['image/gif', '.gif'],
    ['image/jpeg', '.jpg'],
    ['image/jpg', '.jpg'],
    ['image/png', '.png'],
    ['image/svg+xml', '.svg'],
    ['image/webp', '.webp'],
    ['audio/aac', '.aac'],
    ['audio/flac', '.flac'],
    ['audio/mp4', '.m4a'],
    ['audio/mpeg', '.mp3'],
    ['audio/ogg', '.ogg'],
    ['audio/opus', '.opus'],
    ['audio/wav', '.wav'],
    ['audio/wave', '.wav'],
    ['audio/x-m4a', '.m4a'],
    ['audio/x-wav', '.wav'],
    ['video/mp4', '.mp4'],
    ['video/quicktime', '.mov'],
    ['video/webm', '.webm'],
    ['video/x-m4v', '.m4v'],
    ['video/x-matroska', '.mkv'],
    ['video/x-msvideo', '.avi'],
  ])
  const mapped = exact.get(normalized)
  if (mapped) {
    return mapped
  }
  if (normalized.startsWith('image/')) {
    return '.jpg'
  }
  if (normalized.startsWith('audio/')) {
    return '.mp3'
  }
  if (normalized.startsWith('video/')) {
    return '.mp4'
  }
  return null
}

function binaryUrlTypeFromSuffix(suffix: string): 'pdf' | 'image' | 'audio' | 'video' | null {
  const normalized = suffix.toLowerCase()
  if (normalized === '.pdf') {
    return 'pdf'
  }
  if (IMAGE_EXTENSIONS.has(normalized)) {
    return 'image'
  }
  if (AUDIO_EXTENSIONS.has(normalized)) {
    return 'audio'
  }
  if (VIDEO_EXTENSIONS.has(normalized)) {
    return 'video'
  }
  return null
}

function isHtmlResponseContentType(contentType: string): boolean {
  return contentType === 'text/html' || contentType === 'application/xhtml+xml'
}

async function fetchDirectBinaryOrWebpage(url: string, options: IngestOptions, fallbackSuffix: string) {
  const { response, finalUrl, contentType } = await safeFetchResponseWithMetadata(url)
  if (isHtmlResponseContentType(contentType)) {
    const bytes = await readResponseBytes(response, url, MAX_TEXT_BYTES)
    const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    return {
      kind: 'text' as const,
      asset: buildWebpageAsset(finalUrl, html, options),
    }
  }

  const bytes = await readResponseBytes(response, url, MAX_FETCH_BYTES)
  return {
    kind: 'binary' as const,
    suffix: binarySuffixFromContentType(contentType) ?? binarySuffixFromUrl(finalUrl) ?? fallbackSuffix,
    bytes,
    sourceUrl: finalUrl,
  }
}

async function fetchBinaryAwareWebpage(url: string, options: IngestOptions) {
  const { response, finalUrl, contentType } = await safeFetchResponseWithMetadata(url)
  const isHtmlResponse = isHtmlResponseContentType(contentType)
  const binarySuffix = binarySuffixFromContentType(contentType) ?? (!isHtmlResponse ? binarySuffixFromUrl(finalUrl) : null)
  if (binarySuffix) {
    const bytes = await readResponseBytes(response, url, MAX_FETCH_BYTES)
    return {
      kind: 'binary' as const,
      suffix: binarySuffix,
      bytes,
      sourceUrl: finalUrl,
    }
  }

  const bytes = await readResponseBytes(response, url, MAX_TEXT_BYTES)
  const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  return {
    kind: 'text' as const,
    asset: buildWebpageAsset(finalUrl, html, options),
  }
}

const INGEST_HANDLERS: IngestHandlerMap = {
  'builtin:ingest:tweet': async (url, options) => ({ kind: 'text', asset: await fetchTweet(url, options) }),
  'builtin:ingest:reddit': async (url, options) => ({ kind: 'text', asset: await fetchReddit(url, options) }),
  'builtin:ingest:hackernews': async (url, options) => ({ kind: 'text', asset: await fetchHackerNews(url, options) }),
  'builtin:ingest:arxiv': async (url, options) => ({ kind: 'text', asset: await fetchArxiv(url, options) }),
  'builtin:ingest:github': async (url, options) => ({ kind: 'text', asset: await fetchGitHub(url, options) }),
  'builtin:ingest:youtube': async (url, options) => ({ kind: 'text', asset: await fetchYouTubeAsset(url, options) }),
  'builtin:ingest:webpage': async (url, options) => fetchBinaryAwareWebpage(url, options),
  'builtin:ingest:pdf': async (url, options) => fetchDirectBinaryOrWebpage(url, options, '.pdf'),
  'builtin:ingest:image': async (url, options) => fetchDirectBinaryOrWebpage(url, options, suffixFromUrl(url, '.jpg')),
  'builtin:ingest:audio': async (url, options) => fetchDirectBinaryOrWebpage(url, options, suffixFromUrl(url, '.mp3')),
  'builtin:ingest:video': async (url, options) => fetchDirectBinaryOrWebpage(url, options, suffixFromUrl(url, '.mp4')),
}

interface BinaryDownloadSeed {
  bytes?: Uint8Array
  sourceUrl?: string
}

async function downloadBinary(url: string, directory: string, suffix: string, options: IngestOptions, seed: BinaryDownloadSeed = {}): Promise<string> {
  const fetched = seed.bytes
    ? null
    : await safeFetchWithMetadata(url)
  const sourceUrl = seed.sourceUrl ?? fetched?.finalUrl ?? url
  const resolvedSuffix = seed.bytes ? suffix : binarySuffixFromContentType(fetched?.contentType ?? '') ?? binarySuffixFromUrl(sourceUrl) ?? suffix
  const ingestUrlType = binaryUrlTypeFromSuffix(resolvedSuffix)
  const bytes = seed.bytes ?? fetched?.bytes ?? new Uint8Array()
  const outputPath = ensureUniquePath(directory, safeFilename(sourceUrl, resolvedSuffix))
  writeFileSync(outputPath, bytes)

  try {
    writeBinaryIngestSidecar(outputPath, {
      source_url: sourceUrl,
      captured_at: new Date().toISOString(),
      contributor: resolveContributor(options),
      ...(ingestUrlType ? { ingest_url_type: ingestUrlType } : {}),
    })
  } catch (error) {
    rmSync(outputPath, { force: true })
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to persist binary ingest metadata for '${url}': ${message}`)
  }

  return outputPath
}

export async function ingest(url: string, targetDir: string, options: IngestOptions = {}): Promise<string> {
  validateUrl(url)
  const directory = resolve(targetDir)
  mkdirSync(directory, { recursive: true })

  const urlType = detectUrlType(url)
  const dispatched = await dispatchIngest(urlType, url, options, INGEST_HANDLERS, {
    registry: builtinCapabilityRegistry,
  })
  if (dispatched.kind === 'binary') {
    return downloadBinary(url, directory, dispatched.suffix, options, {
      ...(dispatched.bytes ? { bytes: dispatched.bytes } : {}),
      ...(dispatched.sourceUrl ? { sourceUrl: dispatched.sourceUrl } : {}),
    })
  }

  const asset = dispatched.asset
  const outputPath = ensureUniquePath(directory, asset.fileName)
  writeFileSync(outputPath, asset.content, 'utf8')
  return outputPath
}

export function saveQueryResult(question: string, answer: string, memoryDir: string, options: SaveQueryOptions = {}): string {
  const directory = resolve(memoryDir)
  mkdirSync(directory, { recursive: true })

  const now = new Date()
  const outputPath = join(directory, `query_${timestampSlug(now)}_${questionSlug(question)}.md`)
  const sourceNodes = options.sourceNodes?.slice(0, MAX_SOURCE_NODES) ?? []
  const lines = [
    '---',
    `type: ${yamlString(options.queryType ?? 'query')}`,
    `date: ${yamlString(now.toISOString())}`,
    `question: ${yamlString(question)}`,
    `contributor: ${yamlString('sadeem')}`,
    ...(sourceNodes.length > 0 ? [`source_nodes: [${sourceNodes.map((node) => yamlString(node)).join(', ')}]`] : []),
    '---',
    '',
    `# Q: ${question}`,
    '',
    '## Answer',
    '',
    answer,
  ]

  if (sourceNodes.length > 0) {
    lines.push('', '## Source Nodes', '')
    for (const node of sourceNodes) {
      lines.push(`- ${node}`)
    }
  }

  writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8')
  return outputPath
}
