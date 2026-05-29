import { createBaselineProvenance, type ExtractionProvenance } from './types.js'

export const INGEST_PROVENANCE_STAGE = 'ingest'
type LegacyIngestUrlType = 'tweet' | 'reddit' | 'hackernews' | 'arxiv' | 'github' | 'youtube' | 'pdf' | 'image' | 'audio' | 'video' | 'webpage'

const EXPLICIT_INGEST_URL_TYPES = new Set<LegacyIngestUrlType>(['tweet', 'reddit', 'hackernews', 'arxiv', 'github', 'youtube', 'pdf', 'image', 'audio', 'video', 'webpage'])
const TWEET_HOSTS = new Set(['twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'x.com', 'www.x.com'])
const REDDIT_HOSTS = new Set(['reddit.com', 'www.reddit.com', 'old.reddit.com', 'm.reddit.com', 'redd.it'])
const HACKER_NEWS_HOSTS = new Set(['news.ycombinator.com'])
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'])
const ARXIV_HOSTS = new Set(['arxiv.org', 'www.arxiv.org'])
const IMAGE_EXTENSIONS = ['.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp']
const AUDIO_EXTENSIONS = ['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.opus', '.wav']
const VIDEO_EXTENSIONS = ['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.webm']

function isExplicitIngestUrlType(value: string): value is LegacyIngestUrlType {
  return EXPLICIT_INGEST_URL_TYPES.has(value as LegacyIngestUrlType)
}

function isDigits(value: string): boolean {
  return /^\d+$/.test(value)
}

function isAlphaNumericId(value: string): boolean {
  return /^[A-Za-z0-9]+$/.test(value)
}

function isTweetPostUrl(parsed: URL): boolean {
  if (!TWEET_HOSTS.has(parsed.hostname.toLowerCase())) {
    return false
  }
  const segments = parsed.pathname.split('/').filter(Boolean)
  if (segments.length === 3 && segments[0] !== 'i' && segments[1] === 'status' && isDigits(segments[2] ?? '')) {
    return true
  }
  if (
    segments.length === 5 &&
    segments[0] !== 'i' &&
    segments[1] === 'status' &&
    isDigits(segments[2] ?? '') &&
    (segments[3] === 'photo' || segments[3] === 'video') &&
    /^[1-9]\d*$/.test(segments[4] ?? '')
  ) {
    return true
  }
  if (segments.length === 4 && segments[0] === 'i' && segments[1] === 'web' && segments[2] === 'status' && isDigits(segments[3] ?? '')) {
    return true
  }
  return (
    segments.length === 6 &&
    segments[0] === 'i' &&
    segments[1] === 'web' &&
    segments[2] === 'status' &&
    isDigits(segments[3] ?? '') &&
    (segments[4] === 'photo' || segments[4] === 'video') &&
    /^[1-9]\d*$/.test(segments[5] ?? '')
  )
}

function isRedditContentUrl(parsed: URL): boolean {
  if (!REDDIT_HOSTS.has(parsed.hostname.toLowerCase())) {
    return false
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/, '').toLowerCase()
  if (normalizedPath.endsWith('.json')) {
    return false
  }
  const segments = parsed.pathname.split('/').filter(Boolean)
  if (parsed.hostname.toLowerCase() === 'redd.it') {
    return segments.length === 1 && isAlphaNumericId(segments[0] ?? '')
  }
  if (segments[0] === 'comments') {
    return segments.length === 2 && isAlphaNumericId(segments[1] ?? '')
  }
  if (segments.length < 4 || segments.length > 6 || segments[0] !== 'r' || segments[2] !== 'comments' || !isAlphaNumericId(segments[3] ?? '')) {
    return false
  }
  const subreddit = segments[1] ?? ''
  if (!subreddit) {
    return false
  }
  const slug = segments[4] ?? null
  const commentId = segments[5] ?? null
  return commentId === null || (!!slug && isAlphaNumericId(commentId))
}

function isHackerNewsItemUrl(parsed: URL): boolean {
  return HACKER_NEWS_HOSTS.has(parsed.hostname.toLowerCase()) && parsed.pathname === '/item' && isDigits(parsed.searchParams.get('id')?.trim() ?? '')
}

function isArxivContentUrl(parsed: URL): boolean {
  const hostname = parsed.hostname.toLowerCase()
  return ARXIV_HOSTS.has(hostname) || hostname.endsWith('.arxiv.org')
}

function isYouTubeContentUrl(parsed: URL): boolean {
  const hostname = parsed.hostname.toLowerCase()
  if (!YOUTUBE_HOSTS.has(hostname)) {
    return false
  }

  if (hostname === 'youtu.be') {
    return /^[A-Za-z0-9_-]{11}$/.test(parsed.pathname.replace(/^\/+/, ''))
  }

  const pathname = parsed.pathname
  const playlistId = parsed.searchParams.get('list')?.trim() ?? ''
  const videoId = parsed.searchParams.get('v')?.trim() ?? ''
  if (pathname === '/watch' && /^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    return true
  }
  if (pathname === '/playlist' && /^[A-Za-z0-9_-]{2,}$/.test(playlistId)) {
    return true
  }
  if (/^\/shorts\/[A-Za-z0-9_-]{11}$/.test(pathname) || /^\/embed\/[A-Za-z0-9_-]{11}$/.test(pathname) || /^\/live\/[A-Za-z0-9_-]{11}$/.test(pathname)) {
    return true
  }
  if (/^\/@[A-Za-z0-9._-]{3,30}$/.test(pathname)) {
    return true
  }
  if (/^\/channel\/UC[A-Za-z0-9_-]{22}$/.test(pathname)) {
    return true
  }
  return /^\/c\/[A-Za-z0-9._-]{1,100}$/.test(pathname)
}

function detectLegacyIngestUrlType(url: string): LegacyIngestUrlType {
  const parsed = new URL(url)
  const hostname = parsed.hostname.toLowerCase()

  if (isTweetPostUrl(parsed)) {
    return 'tweet'
  }
  if (isRedditContentUrl(parsed)) {
    return 'reddit'
  }
  if (isHackerNewsItemUrl(parsed)) {
    return 'hackernews'
  }
  if (isArxivContentUrl(parsed)) {
    return 'arxiv'
  }
  if (hostname === 'github.com' || hostname === 'www.github.com') {
    return 'github'
  }
  if (isYouTubeContentUrl(parsed)) {
    return 'youtube'
  }

  const pathname = parsed.pathname.toLowerCase()
  if (pathname.endsWith('.pdf')) {
    return 'pdf'
  }
  if (IMAGE_EXTENSIONS.some((extension) => pathname.endsWith(extension))) {
    return 'image'
  }
  if (AUDIO_EXTENSIONS.some((extension) => pathname.endsWith(extension))) {
    return 'audio'
  }
  if (VIDEO_EXTENSIONS.some((extension) => pathname.endsWith(extension))) {
    return 'video'
  }
  return 'webpage'
}

/**
 * Normalize a metadata string by trimming whitespace and rejecting non-string or empty values.
 */
export function normalizeMetadataString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Derive structured ingest provenance from flat capture metadata such as `source_url` and `captured_at`.
 *
 * This keeps on-disk frontmatter backward-compatible while allowing extraction and normalization
 * to share one capability-resolution path for ingest provenance.
 */
export function deriveIngestProvenanceFromRecord(record: Record<string, unknown>, options: { allowVirtual?: boolean } = {}): ExtractionProvenance | null {
  if (!options.allowVirtual && record.virtual === true) {
    return null
  }

  const sourceFile = normalizeMetadataString(record.source_file)
  const sourceUrl = normalizeMetadataString(record.source_url)
  if (!sourceFile || !sourceUrl) {
    return null
  }

  const explicitType = normalizeMetadataString(record.type)
  const explicitIngestUrlType = normalizeMetadataString(record.ingest_url_type)

  let urlType: LegacyIngestUrlType = 'webpage'
  if (explicitType === 'webpage') {
    urlType = 'webpage'
  } else if (explicitIngestUrlType && isExplicitIngestUrlType(explicitIngestUrlType)) {
    urlType = explicitIngestUrlType
  } else {
    try {
      urlType = detectLegacyIngestUrlType(sourceUrl)
    } catch {
      return null
    }
  }

  const capturedAt = normalizeMetadataString(record.captured_at)
  const author = normalizeMetadataString(record.author)
  const contributor = normalizeMetadataString(record.contributor)

  return {
    ...createBaselineProvenance({
      // Preserve legacy builtin:ingest:* IDs so already-normalized graphs do not fork provenance keys.
      capabilityId: `builtin:ingest:${urlType}`,
      stage: INGEST_PROVENANCE_STAGE,
      sourceFile,
    }),
    source_url: sourceUrl,
    ...(capturedAt ? { captured_at: capturedAt } : {}),
    ...(author ? { author } : {}),
    ...(contributor ? { contributor } : {}),
  }
}

function provenanceKey(record: ExtractionProvenance): string {
  return `${String(record.capability_id)}|${String(record.stage ?? '')}|${String(record.source_file ?? '')}|${String(record.source_url ?? '')}|${String(record.captured_at ?? '')}`
}

/**
 * Append derived provenance to an existing provenance list without mutating the input array.
 * Duplicate derived records are skipped by a stable provenance key.
 */
export function appendDerivedProvenance(records: readonly ExtractionProvenance[], derivedProvenance: ExtractionProvenance | null): ExtractionProvenance[] {
  if (!derivedProvenance) {
    return [...records]
  }

  const derivedKey = provenanceKey(derivedProvenance)
  if (records.some((record) => provenanceKey(record) === derivedKey)) {
    return [...records]
  }

  return [...records, { ...derivedProvenance }]
}
