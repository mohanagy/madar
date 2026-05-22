import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { detectUrlType, ingest, saveQueryResult } from '../../src/infrastructure/ingest.js'

async function withTempDir(callback: (tempDir: string) => void | Promise<void>): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), 'madar-ingest-'))
  try {
    await callback(tempDir)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function binaryIngestSidecarPath(assetPath: string): string {
  return join(dirname(assetPath), `.${basename(assetPath)}.madar-ingest.json`)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('saveQueryResult', () => {
  test('creates a markdown file with frontmatter and answer body', () => {
    return withTempDir((tempDir) => {
      const output = saveQueryResult('what is attention?', 'Attention is softmax.', join(tempDir, 'memory'))
      const content = readFileSync(output, 'utf8')
      expect(content).toContain('question:')
      expect(content).toContain('Attention is softmax.')
      expect(output.endsWith('.md')).toBe(true)
    })
  })

  test('stores query type and capped source nodes', () => {
    return withTempDir((tempDir) => {
      const output = saveQueryResult('q', 'a', join(tempDir, 'memory'), {
        queryType: 'path_query',
        sourceNodes: Array.from({ length: 20 }, (_, index) => `Node${index}`),
      })
      const content = readFileSync(output, 'utf8')
      expect(content).toContain('type: "path_query"')
      const line = content.split('\n').find((entry) => entry.startsWith('source_nodes:'))
      expect(line?.match(/"Node/g)?.length ?? 0).toBe(10)
    })
  })
})

describe('detectUrlType', () => {
  test('classifies supported url shapes', () => {
    expect(detectUrlType('https://x.com/user/status/1')).toBe('tweet')
    expect(detectUrlType('https://notx.com/user/status/1')).toBe('webpage')
    expect(detectUrlType('https://x.com/home')).toBe('webpage')
    expect(detectUrlType('https://twitter.com/explore')).toBe('webpage')
    expect(detectUrlType('https://x.com/user/status/1/photo/1')).toBe('tweet')
    expect(detectUrlType('https://twitter.com/i/web/status/1/video/1')).toBe('tweet')
    expect(detectUrlType('https://twitter.com/i/web/status/1/analytics')).toBe('webpage')
    expect(detectUrlType('https://x.com/user/status/1/photo/not-a-media-index')).toBe('webpage')
    expect(detectUrlType('https://x.com/user/status/1/photo/0')).toBe('webpage')
    expect(detectUrlType('https://twitter.com/i/web/status/1/video/00')).toBe('webpage')
    expect(detectUrlType('https://twitter.com/i/status/1')).toBe('webpage')
    expect(detectUrlType('https://x.com/user/status/not-a-post-id')).toBe('webpage')
    expect(detectUrlType('https://arxiv.org/abs/1706.03762')).toBe('arxiv')
    expect(detectUrlType('https://github.com/mohanagy/madar')).toBe('github')
    expect(detectUrlType('https://notgithub.com/mohanagy/madar')).toBe('webpage')
    expect(detectUrlType('https://old.reddit.com/r/madar/comments/abc123/structured_ingest_roadmap_update/?utm_source=share')).toBe('reddit')
    expect(detectUrlType('https://www.reddit.com/r/madar/comments/abc123/structured_ingest_roadmap_update/jkl456/?context=3')).toBe('reddit')
    expect(detectUrlType('https://redd.it/abc123')).toBe('reddit')
    expect(detectUrlType('https://www.reddit.com/comments/abc123?utm_source=share')).toBe('reddit')
    expect(detectUrlType('https://notreddit.com/r/madar/comments/abc123/structured_ingest_roadmap_update/')).toBe('webpage')
    expect(detectUrlType('https://www.reddit.com/r/madar/about')).toBe('webpage')
    expect(detectUrlType('https://www.reddit.com/r/madar/comments/abc123/.json')).toBe('webpage')
    expect(detectUrlType('https://www.reddit.com/r/madar/comments/abc123/.json/')).toBe('webpage')
    expect(detectUrlType('https://www.reddit.com/r/madar/comments/abc123/structured_ingest_roadmap_update/jkl456/.json')).toBe('webpage')
    expect(detectUrlType('https://www.reddit.com/r/madar/comments/abc123/structured_ingest_roadmap_update/jkl456/more')).toBe('webpage')
    expect(detectUrlType('https://redd.it/abc123.json')).toBe('webpage')
    expect(detectUrlType('https://www.reddit.com/comments/abc123/more')).toBe('webpage')
    expect(detectUrlType('https://news.ycombinator.com/item?id=8863')).toBe('hackernews')
    expect(detectUrlType('https://news.ycombinator.com/item?id=8863&utm_source=share')).toBe('hackernews')
    expect(detectUrlType('https://notnews.ycombinator.com/item?id=8863')).toBe('webpage')
    expect(detectUrlType('https://news.ycombinator.com/news?p=2')).toBe('webpage')
    expect(detectUrlType('https://news.ycombinator.com/item?id=not-a-thread')).toBe('webpage')
    expect(detectUrlType('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('youtube')
    expect(detectUrlType('https://youtu.be/dQw4w9WgXcQ?si=madar')).toBe('youtube')
    expect(detectUrlType('https://www.youtube.com/shorts/dQw4w9WgXcQ?feature=share')).toBe('youtube')
    expect(detectUrlType('https://www.youtube.com/embed/dQw4w9WgXcQ?start=30')).toBe('youtube')
    expect(detectUrlType('https://www.youtube.com/live/dQw4w9WgXcQ?feature=share')).toBe('youtube')
    expect(detectUrlType('https://www.youtube.com/playlist?list=PLmadarRoadmap123&feature=share')).toBe('youtube')
    expect(detectUrlType('https://www.youtube.com/@madar?feature=share')).toBe('youtube')
    expect(detectUrlType('https://www.youtube.com/channel/UCmadarRoadmap1234567890?feature=share')).toBe('youtube')
    expect(detectUrlType('https://www.youtube.com/c/madar?feature=share')).toBe('youtube')
    expect(detectUrlType('https://notyoutube.com/watch?v=dQw4w9WgXcQ')).toBe('webpage')
    expect(detectUrlType('https://www.youtube.com/playlist')).toBe('webpage')
    expect(detectUrlType('https://www.youtube.com/playlist?list=')).toBe('webpage')
    expect(detectUrlType('https://www.youtube.com/playlist/?list=PLmadarRoadmap123')).toBe('webpage')
    expect(detectUrlType('https://www.youtube.com/playlist/videos?list=PLmadarRoadmap123')).toBe('webpage')
    expect(detectUrlType('https://www.youtube.com/@madar/')).toBe('webpage')
    expect(detectUrlType('https://www.youtube.com/@madar/videos')).toBe('webpage')
    expect(detectUrlType('https://www.youtube.com/@madar/community')).toBe('webpage')
    expect(detectUrlType('https://www.youtube.com/channel/UCmadarRoadmap1234567/')).toBe('webpage')
    expect(detectUrlType('https://www.youtube.com/channel/UCmadarRoadmap1234567/videos')).toBe('webpage')
    expect(detectUrlType('https://www.youtube.com/channel/not-a-channel-id')).toBe('webpage')
    expect(detectUrlType('https://www.youtube.com/c/madar/')).toBe('webpage')
    expect(detectUrlType('https://www.youtube.com/c/madar/videos')).toBe('webpage')
    expect(detectUrlType('https://www.youtube.com/shorts/dQw4w9WgXcQ/clips')).toBe('webpage')
    expect(detectUrlType('https://www.youtube.com/embed/dQw4w9WgXcQ/live_chat')).toBe('webpage')
    expect(detectUrlType('https://www.youtube.com/live/dQw4w9WgXcQ/chat')).toBe('webpage')
    expect(detectUrlType('https://www.youtube.com/shorts/short')).toBe('webpage')
    expect(detectUrlType('https://www.youtube.com/live/short')).toBe('webpage')
    expect(detectUrlType('https://www.youtube.com/watch?v=short')).toBe('webpage')
    expect(detectUrlType('https://example.com/file.pdf')).toBe('pdf')
    expect(detectUrlType('https://example.com/diagram.png')).toBe('image')
    expect(detectUrlType('https://example.com/episode.mp3?download=1')).toBe('audio')
    expect(detectUrlType('https://example.com/demo.mp4?download=1')).toBe('video')
    expect(detectUrlType('https://example.com/post')).toBe('webpage')
  })
})

describe('ingest', () => {
  function readIngestFixture(name: string): string {
    return readFileSync(join(process.cwd(), 'tests', 'fixtures', 'ingest', name), 'utf8')
  }

  function stubHtmlFetch(html: string): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })),
    )
  }

  test('saves webpages as annotated markdown', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('<html><head><title>Example Page</title></head><body><h1>Hello</h1><p>World</p></body></html>', { status: 200 })),
      )

      const output = await ingest('https://example.com/post', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')
      expect(content).toContain('type: webpage')
      expect(content).toContain('Example Page')
      expect(content).toContain('Source: https://example.com/post')
      expect(content).not.toContain('provenance:')
      expect(existsSync(binaryIngestSidecarPath(output))).toBe(false)
    })
  })

  test('captures structured article metadata and sections for generic webpage ingest', async () => {
    await withTempDir(async (tempDir) => {
      stubHtmlFetch(readIngestFixture('webpage-article.html'))

      const output = await ingest('https://example.com/articles/structured-graphs?utm_source=test', join(tempDir, 'raw'), {
        contributor: 'madar',
      })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('source_url: "https://example.com/articles/structured-graphs"')
      expect(content).toContain('author: "Ada Lovelace"')
      expect(content).toContain('description: "Deterministic article ingestion for madar."')
      expect(content).toContain(
        'outbound_links: ["https://example.com/docs/schema", "https://external.example.com/guide", "https://example.com/blog/provenance"]',
      )
      expect(content).toContain('# Structured Graph Ingestion')
      expect(content).toContain('## Summary')
      expect(content).toContain('## Overview')
      expect(content).toContain('[schema metadata](https://example.com/docs/schema)')
      expect(content).toContain('## Further Reading')
      expect(content).toContain('[this guide](https://external.example.com/guide)')
      expect(content).toContain('[provenance notes](https://example.com/blog/provenance)')
      expect(content).toContain('## Outbound Links')
      expect(content).not.toContain('mailto:hello@example.com')
      expect(content).not.toContain('Source: https://example.com/articles/structured-graphs?utm_source=test')
    })
  })

  test('saves GitHub repository URLs as structured repository markdown', async () => {
    await withTempDir(async (tempDir) => {
      stubHtmlFetch(readIngestFixture('github-repository.html'))

      const output = await ingest('https://github.com/mohanagy/madar?tab=readme', join(tempDir, 'raw'), { contributor: 'madar' })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: github_repository')
      expect(content).toContain('source_url: "https://github.com/mohanagy/madar"')
      expect(content).toContain('github_kind: "repository"')
      expect(content).toContain('github_owner: "mohanagy"')
      expect(content).toContain('github_repo: "madar"')
      expect(content).toContain('github_topics: ["typescript", "knowledge-graph"]')
      expect(content).toContain('contributor: "madar"')
      expect(content).toContain('# GitHub Repository: mohanagy/madar')
      expect(content).toContain('## About')
      expect(content).toContain('TypeScript-native graph extraction for code and docs.')
      expect(content).not.toContain('provenance:')
    })
  })

  test('saves GitHub issue URLs as structured issue markdown', async () => {
    await withTempDir(async (tempDir) => {
      stubHtmlFetch(readIngestFixture('github-issue.html'))

      const output = await ingest('https://github.com/mohanagy/madar/issues/123', join(tempDir, 'raw'), { contributor: 'madar' })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: github_issue')
      expect(content).toContain('source_url: "https://github.com/mohanagy/madar/issues/123"')
      expect(content).toContain('github_kind: "issue"')
      expect(content).toContain('github_owner: "mohanagy"')
      expect(content).toContain('github_repo: "madar"')
      expect(content).toContain('github_number: "123"')
      expect(content).toContain('github_state: "open"')
      expect(content).toContain('github_labels: ["bug", "triage"]')
      expect(content).toContain('author: "octocat"')
      expect(content).toContain('# GitHub Issue #123: Parser crashes on sidecar fallback')
      expect(content).toContain('## Body')
      expect(content).toContain('Hidden DOCX sidecars should still lift metadata on fallback.')
    })
  })

  test('preserves GitHub issue body text when the issue body contains nested div wrappers', async () => {
    await withTempDir(async (tempDir) => {
      stubHtmlFetch(readIngestFixture('github-issue-nested-body.html'))

      const output = await ingest('https://github.com/mohanagy/madar/issues/321', join(tempDir, 'raw'), { contributor: 'madar' })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('Before code block.')
      expect(content).toContain('const value = 1')
      expect(content).toContain('After code block.')
    })
  })

  test('saves GitHub pull request URLs as structured pull request markdown', async () => {
    await withTempDir(async (tempDir) => {
      stubHtmlFetch(readIngestFixture('github-pull-request.html'))

      const output = await ingest('https://github.com/mohanagy/madar/pull/456', join(tempDir, 'raw'), { contributor: 'madar' })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: github_pull_request')
      expect(content).toContain('source_url: "https://github.com/mohanagy/madar/pull/456"')
      expect(content).toContain('github_kind: "pull_request"')
      expect(content).toContain('github_number: "456"')
      expect(content).toContain('github_state: "merged"')
      expect(content).toContain('github_labels: ["enhancement", "tests"]')
      expect(content).toContain('author: "madar-maintainer"')
      expect(content).toContain('# GitHub Pull Request #456: Add structured GitHub ingest')
      expect(content).toContain('This adds route-aware GitHub ingestion without changing non-GitHub handlers.')
    })
  })

  test('saves GitHub discussion URLs as structured discussion markdown', async () => {
    await withTempDir(async (tempDir) => {
      stubHtmlFetch(readIngestFixture('github-discussion.html'))

      const output = await ingest('https://github.com/mohanagy/madar/discussions/789', join(tempDir, 'raw'), { contributor: 'madar' })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: github_discussion')
      expect(content).toContain('source_url: "https://github.com/mohanagy/madar/discussions/789"')
      expect(content).toContain('github_kind: "discussion"')
      expect(content).toContain('github_number: "789"')
      expect(content).toContain('github_state: "open"')
      expect(content).toContain('github_category: "Ideas"')
      expect(content).toContain('author: "mohanagy"')
      expect(content).toContain('# GitHub Discussion #789: Roadmap for structured GitHub ingest')
      expect(content).toContain('Capture repository, issue, pull request, and discussion context as first-class markdown sections.')
    })
  })

  test('saves GitHub commit URLs as structured commit markdown', async () => {
    await withTempDir(async (tempDir) => {
      stubHtmlFetch(readIngestFixture('github-commit.html'))

      const output = await ingest(
        'https://github.com/mohanagy/madar/commit/abcdef1?diff=split',
        join(tempDir, 'raw'),
        { contributor: 'madar' },
      )
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: github_commit')
      expect(content).toContain('source_url: "https://github.com/mohanagy/madar/commit/abcdef1234567890abcdef1234567890abcdef12"')
      expect(content).toContain('github_kind: "commit"')
      expect(content).toContain('github_owner: "mohanagy"')
      expect(content).toContain('github_repo: "madar"')
      expect(content).toContain('github_commit_sha: "abcdef1234567890abcdef1234567890abcdef12"')
      expect(content).toContain('author: "madar-maintainer"')
      expect(content).toContain('contributor: "madar"')
      expect(content).toContain('# GitHub Commit abcdef1: feat: add GitHub commit ingest')
      expect(content).toContain('## Message')
      expect(content).toContain('Teach the ingest layer about exact GitHub commit routes.')
      expect(content).toContain('Keep unsupported GitHub page kinds on webpage fallback.')
      expect(content).not.toContain('provenance:')
    })
  })

  test('falls back to generic webpage capture when fetched GitHub commit HTML does not confirm a commit page', async () => {
    await withTempDir(async (tempDir) => {
      stubHtmlFetch(
        '<html><head><title>Commit abc1234</title><link rel="canonical" href="https://github.com/mohanagy/madar/commit/abc1234" /></head><body><p>Generic commit page.</p></body></html>',
      )

      const output = await ingest('https://github.com/mohanagy/madar/commit/abc1234', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: webpage')
      expect(content).toContain('Source: https://github.com/mohanagy/madar/commit/abc1234')
      expect(content).not.toContain('github_kind:')
    })
  })

  test('falls back to generic webpage capture for GitHub commit subpages with extra path segments', async () => {
    await withTempDir(async (tempDir) => {
      stubHtmlFetch(
        readIngestFixture('github-commit.html').replace(
          'https://github.com/mohanagy/madar/commit/abcdef1234567890abcdef1234567890abcdef12',
          'https://github.com/mohanagy/madar/commit/abcdef1234567890abcdef1234567890abcdef12/checks',
        ),
      )

      const output = await ingest(
        'https://github.com/mohanagy/madar/commit/abcdef1234567890abcdef1234567890abcdef12/checks',
        join(tempDir, 'raw'),
      )
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: webpage')
      expect(content).toContain('Source: https://github.com/mohanagy/madar/commit/abcdef1234567890abcdef1234567890abcdef12/checks')
      expect(content).not.toContain('github_kind:')
    })
  })

  test('falls back to generic webpage capture for unsupported GitHub page kinds', async () => {
    await withTempDir(async (tempDir) => {
      stubHtmlFetch(
        '<html><head><title>Compare changes</title><link rel="canonical" href="https://github.com/mohanagy/madar/compare/main...feature" /></head><body><main><p>Compare branches.</p></main></body></html>',
      )

      const output = await ingest('https://github.com/mohanagy/madar/compare/main...feature', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: webpage')
      expect(content).toContain('Source: https://github.com/mohanagy/madar/compare/main...feature')
      expect(content).not.toContain('github_kind:')
    })
  })

  test('falls back to generic webpage capture for non-repository github.com top-level routes', async () => {
    await withTempDir(async (tempDir) => {
      stubHtmlFetch(
        '<html><head><title>GitHub Copilot</title><link rel="canonical" href="https://github.com/features/copilot" /></head><body><main><h1>GitHub Copilot</h1><p>Build faster.</p></main></body></html>',
      )

      const output = await ingest('https://github.com/features/copilot', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: webpage')
      expect(content).toContain('Source: https://github.com/features/copilot')
      expect(content).not.toContain('github_kind:')
    })
  })

  test('falls back to generic webpage capture when fetched GitHub HTML resolves to an interstitial page', async () => {
    await withTempDir(async (tempDir) => {
      stubHtmlFetch(
        '<html><head><title>Sign in to GitHub</title><link rel="canonical" href="https://github.com/login" /></head><body><main><p>Sign in to continue.</p></main></body></html>',
      )

      const output = await ingest('https://github.com/mohanagy/madar/issues/999', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: webpage')
      expect(content).toContain('source_url: "https://github.com/login"')
      expect(content).not.toContain('github_kind:')
    })
  })

  test('saves Reddit thread URLs as structured thread markdown', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          expect(requestUrl).toBe(
            'https://www.reddit.com/r/madar/comments/abc123/structured_ingest_roadmap_update.json?limit=3&depth=1&raw_json=1',
          )
          return new Response(readIngestFixture('reddit-thread.json'), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }),
      )

      const output = await ingest(
        'https://old.reddit.com/r/madar/comments/abc123/structured_ingest_roadmap_update/?utm_source=share',
        join(tempDir, 'raw'),
        { contributor: 'madar' },
      )
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: reddit_thread')
      expect(content).toContain('source_url: "https://www.reddit.com/r/madar/comments/abc123/structured_ingest_roadmap_update"')
      expect(content).toContain('title: "Structured ingest roadmap update"')
      expect(content).toContain('author: "graph_builder"')
      expect(content).toContain('contributor: "madar"')
      expect(content).toContain('reddit_subreddit: "madar"')
      expect(content).toContain('reddit_post_id: "abc123"')
      expect(content).toContain('reddit_score: "128"')
      expect(content).toContain('reddit_comment_count: "42"')
      expect(content).toContain('reddit_capture_status: "json"')
      expect(content).toContain('# Reddit Thread: Structured ingest roadmap update')
      expect(content).toContain('## Post')
      expect(content).toContain('Madar-ts now captures richer structured inputs.')
      expect(content).toContain('## Thread Highlights')
      expect(content).toContain('### Comment by u/helper_bot')
      expect(content).toContain('Nice direction. Capture fallback boundaries explicitly.')
      expect(content).toContain('### Comment by u/schema_fan')
      expect(content).toContain('The capability registry work is paying off.')
      expect(content).toContain('## Context')
      expect(content).toContain('- Platform: reddit')
      expect(content).toContain('- Subreddit: r/madar')
      expect(content).toContain('- Post ID: abc123')
      expect(content).toContain('- Score: 128')
      expect(content).toContain('- Comment Count: 42')
      expect(content).toContain('- Capture Status: json')
      expect(content).toContain('## Links')
      expect(content).toContain('[Open Thread](https://www.reddit.com/r/madar/comments/abc123/structured_ingest_roadmap_update)')
      expect(content).toContain('[Linked URL](https://github.com/mohanagy/madar)')
      expect(content).not.toContain('provenance:')
    })
  })

  test('saves Reddit short thread URLs as structured thread markdown', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          expect(requestUrl).toBe('https://www.reddit.com/comments/abc123.json?limit=3&depth=1&raw_json=1')
          return new Response(readIngestFixture('reddit-thread.json'), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }),
      )

      const output = await ingest('https://redd.it/abc123', join(tempDir, 'raw'), { contributor: 'madar' })
      const content = readFileSync(output, 'utf8')

      expect(basename(output)).toBe('reddit_madar_abc123.md')
      expect(content).toContain('type: reddit_thread')
      expect(content).toContain('source_url: "https://www.reddit.com/r/madar/comments/abc123/structured_ingest_roadmap_update"')
      expect(content).toContain('title: "Structured ingest roadmap update"')
      expect(content).toContain('author: "graph_builder"')
      expect(content).toContain('reddit_subreddit: "madar"')
      expect(content).toContain('reddit_post_id: "abc123"')
      expect(content).toContain('reddit_capture_status: "json"')
      expect(content).toContain('[Open Thread](https://www.reddit.com/r/madar/comments/abc123/structured_ingest_roadmap_update)')
      expect(content).toContain('[Linked URL](https://github.com/mohanagy/madar)')
    })
  })

  test('saves Reddit comment permalink URLs as structured comment markdown', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          expect(requestUrl).toBe(
            'https://www.reddit.com/r/madar/comments/abc123/structured_ingest_roadmap_update/jkl456.json?limit=3&depth=1&raw_json=1',
          )
          return new Response(readIngestFixture('reddit-comment.json'), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }),
      )

      const output = await ingest(
        'https://www.reddit.com/r/madar/comments/abc123/structured_ingest_roadmap_update/jkl456/?context=3',
        join(tempDir, 'raw'),
        { contributor: 'madar' },
      )
      const content = readFileSync(output, 'utf8')

      expect(basename(output)).toBe('reddit_madar_abc123_jkl456.md')
      expect(content).toContain('type: reddit_comment')
      expect(content).toContain('source_url: "https://www.reddit.com/r/madar/comments/abc123/structured_ingest_roadmap_update/jkl456"')
      expect(content).toContain('title: "Comment on: Structured ingest roadmap update"')
      expect(content).toContain('author: "helper_bot"')
      expect(content).toContain('contributor: "madar"')
      expect(content).toContain('reddit_subreddit: "madar"')
      expect(content).toContain('reddit_post_id: "abc123"')
      expect(content).toContain('reddit_comment_id: "jkl456"')
      expect(content).toContain('reddit_comment_score: "30"')
      expect(content).toContain('reddit_capture_status: "json"')
      expect(content).toContain('# Reddit Comment: Structured ingest roadmap update')
      expect(content).toContain('## Comment')
      expect(content).toContain('Nice direction. Capture fallback boundaries explicitly.')
      expect(content).toContain('## Thread')
      expect(content).toContain('Madar-ts now captures richer structured inputs.')
      expect(content).toContain('## Context')
      expect(content).toContain('- Platform: reddit')
      expect(content).toContain('- Subreddit: r/madar')
      expect(content).toContain('- Post ID: abc123')
      expect(content).toContain('- Comment ID: jkl456')
      expect(content).toContain('- Thread Author: graph_builder')
      expect(content).toContain('- Comment Score: 30')
      expect(content).toContain('- Thread Score: 128')
      expect(content).toContain('- Comment Count: 42')
      expect(content).toContain('- Capture Status: json')
      expect(content).toContain('## Links')
      expect(content).toContain('[Open Comment](https://www.reddit.com/r/madar/comments/abc123/structured_ingest_roadmap_update/jkl456)')
      expect(content).toContain('[Open Thread](https://www.reddit.com/r/madar/comments/abc123/structured_ingest_roadmap_update)')
      expect(content).toContain('[Linked URL](https://github.com/mohanagy/madar)')
      expect(content).not.toContain('provenance:')
    })
  })

  test('makes reddit thread fallback behavior explicit when thread JSON fetch fails', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('rate limited', { status: 429, headers: { 'content-type': 'text/plain' } })),
      )

      const output = await ingest('https://www.reddit.com/r/madar/comments/def456/social_thread_roadmap/?utm_source=share', join(tempDir, 'raw'), {
        contributor: 'madar',
      })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: reddit_thread')
      expect(content).toContain('source_url: "https://www.reddit.com/r/madar/comments/def456/social_thread_roadmap"')
      expect(content).toContain('title: "Reddit Thread: def456"')
      expect(content).toContain('author: "unknown"')
      expect(content).toContain('reddit_subreddit: "madar"')
      expect(content).toContain('reddit_post_id: "def456"')
      expect(content).toContain('reddit_capture_status: "fallback"')
      expect(content).toContain('## Post')
      expect(content).toContain('Reddit thread metadata could not be fetched.')
      expect(content).toContain('## Context')
      expect(content).toContain('- Platform: reddit')
      expect(content).toContain('- Subreddit: r/madar')
      expect(content).toContain('- Post ID: def456')
      expect(content).toContain('- Capture Status: fallback')
      expect(content).toContain('- Note: thread JSON unavailable; preserved canonical thread URL and derived Reddit metadata only.')
      expect(content).toContain('## Links')
      expect(content).toContain('[Open Thread](https://www.reddit.com/r/madar/comments/def456/social_thread_roadmap)')
      expect(content).not.toContain('provenance:')
    })
  })

  test('makes reddit short thread fallback behavior explicit when thread JSON fetch fails', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('rate limited', { status: 429, headers: { 'content-type': 'text/plain' } })),
      )

      const output = await ingest('https://www.reddit.com/comments/def456?utm_source=share', join(tempDir, 'raw'), {
        contributor: 'madar',
      })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: reddit_thread')
      expect(content).toContain('source_url: "https://www.reddit.com/comments/def456"')
      expect(content).toContain('title: "Reddit Thread: def456"')
      expect(content).toContain('author: "unknown"')
      expect(content).toContain('reddit_post_id: "def456"')
      expect(content).not.toContain('reddit_subreddit:')
      expect(content).toContain('reddit_capture_status: "fallback"')
      expect(content).toContain('## Post')
      expect(content).toContain('Reddit thread metadata could not be fetched.')
      expect(content).toContain('## Context')
      expect(content).toContain('- Platform: reddit')
      expect(content).not.toContain('- Subreddit: ')
      expect(content).toContain('- Post ID: def456')
      expect(content).toContain('- Capture Status: fallback')
      expect(content).toContain('- Note: thread JSON unavailable; preserved canonical thread URL and derived Reddit metadata only.')
      expect(content).toContain('## Links')
      expect(content).toContain('[Open Thread](https://www.reddit.com/comments/def456)')
      expect(content).not.toContain('provenance:')
    })
  })

  test('makes reddit comment fallback behavior explicit when comment JSON fetch fails', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('rate limited', { status: 429, headers: { 'content-type': 'text/plain' } })),
      )

      const output = await ingest('https://www.reddit.com/r/madar/comments/def456/social_thread_roadmap/jkl456/?context=3', join(tempDir, 'raw'), {
        contributor: 'madar',
      })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: reddit_comment')
      expect(content).toContain('source_url: "https://www.reddit.com/r/madar/comments/def456/social_thread_roadmap/jkl456"')
      expect(content).toContain('title: "Reddit Comment: def456/jkl456"')
      expect(content).toContain('author: "unknown"')
      expect(content).toContain('reddit_subreddit: "madar"')
      expect(content).toContain('reddit_post_id: "def456"')
      expect(content).toContain('reddit_comment_id: "jkl456"')
      expect(content).toContain('reddit_capture_status: "fallback"')
      expect(content).toContain('## Comment')
      expect(content).toContain('Reddit comment metadata could not be fetched.')
      expect(content).toContain('## Thread')
      expect(content).toContain('Reddit thread metadata could not be fetched.')
      expect(content).toContain('## Context')
      expect(content).toContain('- Platform: reddit')
      expect(content).toContain('- Subreddit: r/madar')
      expect(content).toContain('- Post ID: def456')
      expect(content).toContain('- Comment ID: jkl456')
      expect(content).toContain('- Capture Status: fallback')
      expect(content).toContain('- Note: comment JSON unavailable; preserved canonical comment URL and derived Reddit metadata only.')
      expect(content).toContain('## Links')
      expect(content).toContain('[Open Comment](https://www.reddit.com/r/madar/comments/def456/social_thread_roadmap/jkl456)')
      expect(content).toContain('[Open Thread](https://www.reddit.com/r/madar/comments/def456/social_thread_roadmap)')
      expect(content).not.toContain('provenance:')
    })
  })

  test('does not emit a fake linked url when reddit self-post JSON points back to the same thread', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(
            JSON.stringify([
              {
                kind: 'Listing',
                data: {
                  children: [
                    {
                      kind: 't3',
                      data: {
                        subreddit: 'madar',
                        author: 'thread_author',
                        title: 'Self post example',
                        selftext: 'This thread should not render a duplicate Reddit self-link.',
                        score: 12,
                        num_comments: 3,
                        permalink: '/r/madar/comments/ghi789/self_post_example/',
                        url: 'https://old.reddit.com/r/madar/comments/ghi789/self_post_example/',
                      },
                    },
                  ],
                },
              },
              {
                kind: 'Listing',
                data: {
                  children: [],
                },
              },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      )

      const output = await ingest('https://www.reddit.com/r/madar/comments/ghi789/self_post_example/', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('[Open Thread](https://www.reddit.com/r/madar/comments/ghi789/self_post_example)')
      expect(content).not.toContain('[Linked URL](https://old.reddit.com/r/madar/comments/ghi789/self_post_example/)')
    })
  })

  test('saves Hacker News item URLs as structured discussion markdown', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          if (requestUrl === 'https://hacker-news.firebaseio.com/v0/item/8863.json') {
            return new Response(readIngestFixture('hackernews-story.json'), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          }
          if (requestUrl === 'https://hacker-news.firebaseio.com/v0/item/2921983.json') {
            return new Response(JSON.stringify({ id: 2921983, type: 'comment', by: 'pg', text: '<p>Love this.</p>' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          }
          if (requestUrl === 'https://hacker-news.firebaseio.com/v0/item/2922097.json') {
            return new Response(JSON.stringify({ id: 2922097, type: 'comment', by: 'sama', text: '<p>We use this every day.</p>' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          }
          throw new Error(`Unexpected URL: ${requestUrl}`)
        }),
      )

      const output = await ingest('https://news.ycombinator.com/item?id=8863&utm_source=share', join(tempDir, 'raw'), {
        contributor: 'madar',
      })
      const content = readFileSync(output, 'utf8')

      expect(basename(output)).toBe('hackernews_8863.md')
      expect(content).toContain('type: hackernews_item')
      expect(content).toContain('source_url: "https://news.ycombinator.com/item?id=8863"')
      expect(content).toContain('title: "My YC app: Dropbox - Throw away your USB drive"')
      expect(content).toContain('author: "dhouston"')
      expect(content).toContain('contributor: "madar"')
      expect(content).toContain('hackernews_item_id: "8863"')
      expect(content).toContain('hackernews_score: "104"')
      expect(content).toContain('hackernews_comment_count: "71"')
      expect(content).toContain('hackernews_capture_status: "api"')
      expect(content).toContain('# Hacker News Item: My YC app: Dropbox - Throw away your USB drive')
      expect(content).toContain('## Item')
      expect(content).toContain('The file syncing magic continues.')
      expect(content).toContain('## Discussion Highlights')
      expect(content).toContain('### Comment by pg')
      expect(content).toContain('Love this.')
      expect(content).toContain('### Comment by sama')
      expect(content).toContain('We use this every day.')
      expect(content).toContain('## Context')
      expect(content).toContain('- Platform: hackernews')
      expect(content).toContain('- Item ID: 8863')
      expect(content).toContain('- Score: 104')
      expect(content).toContain('- Comment Count: 71')
      expect(content).toContain('- Capture Status: api')
      expect(content).toContain('## Links')
      expect(content).toContain('[Open Discussion](https://news.ycombinator.com/item?id=8863)')
      expect(content).toContain('[Linked URL](http://www.getdropbox.com/u/2/screencast.html)')
      expect(content).not.toContain('provenance:')
    })
  })

  test('makes hackernews fallback behavior explicit when item metadata fetch fails', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('unavailable', { status: 503, headers: { 'content-type': 'text/plain' } })),
      )

      const output = await ingest('https://news.ycombinator.com/item?id=12345', join(tempDir, 'raw'), {
        contributor: 'madar',
      })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: hackernews_item')
      expect(content).toContain('source_url: "https://news.ycombinator.com/item?id=12345"')
      expect(content).toContain('title: "Hacker News Item: 12345"')
      expect(content).toContain('author: "unknown"')
      expect(content).toContain('hackernews_item_id: "12345"')
      expect(content).toContain('hackernews_capture_status: "fallback"')
      expect(content).toContain('## Item')
      expect(content).toContain('Hacker News item metadata could not be fetched.')
      expect(content).toContain('## Context')
      expect(content).toContain('- Platform: hackernews')
      expect(content).toContain('- Item ID: 12345')
      expect(content).toContain('- Capture Status: fallback')
      expect(content).toContain('- Note: Hacker News API unavailable; preserved canonical discussion URL and derived item metadata only.')
      expect(content).toContain('## Links')
      expect(content).toContain('[Open Discussion](https://news.ycombinator.com/item?id=12345)')
      expect(content).not.toContain('provenance:')
    })
  })

  test('collects the first three usable hackernews discussion highlights even when early child comments are empty', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          if (requestUrl === 'https://hacker-news.firebaseio.com/v0/item/777.json') {
            return new Response(
              JSON.stringify({
                id: 777,
                type: 'story',
                by: 'dang',
                title: 'Structured ingest notes',
                text: '<p>Item body.</p>',
                score: 55,
                descendants: 4,
                kids: [901, 902, 903, 904],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
          }
          if (requestUrl === 'https://hacker-news.firebaseio.com/v0/item/901.json') {
            return new Response(JSON.stringify({ id: 901, type: 'comment', by: 'empty', text: '<p> </p>' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          }
          if (requestUrl === 'https://hacker-news.firebaseio.com/v0/item/902.json') {
            return new Response(JSON.stringify({ id: 902, type: 'comment', by: 'alice', text: '<p>First usable.</p>' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          }
          if (requestUrl === 'https://hacker-news.firebaseio.com/v0/item/903.json') {
            return new Response(JSON.stringify({ id: 903, type: 'comment', by: 'bob', text: '<p>Second usable.</p>' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          }
          if (requestUrl === 'https://hacker-news.firebaseio.com/v0/item/904.json') {
            return new Response(JSON.stringify({ id: 904, type: 'comment', by: 'carol', text: '<p>Third usable.</p>' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          }
          throw new Error(`Unexpected URL: ${requestUrl}`)
        }),
      )

      const output = await ingest('https://news.ycombinator.com/item?id=777', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('### Comment by alice')
      expect(content).toContain('First usable.')
      expect(content).toContain('### Comment by bob')
      expect(content).toContain('Second usable.')
      expect(content).toContain('### Comment by carol')
      expect(content).toContain('Third usable.')
      expect(content).not.toContain('### Comment by empty')
    })
  })

  test('saves YouTube video URLs as structured video markdown', async () => {
    await withTempDir(async (tempDir) => {
      const requestUrls: string[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          requestUrls.push(requestUrl)
          if (requestUrl === 'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json') {
            return new Response(
              JSON.stringify({
                title: 'Madar Demo Walkthrough',
                author_name: 'Madar Channel',
                author_url: 'https://www.youtube.com/@madar',
                provider_name: 'YouTube',
                thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
              }),
              {
                status: 200,
                headers: { 'content-type': 'application/json' },
              },
            )
          }

          if (requestUrl === 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en') {
            return new Response(readIngestFixture('youtube-caption-en.xml'), {
              status: 200,
              headers: { 'content-type': 'application/xml; charset=utf-8' },
            })
          }

          expect(requestUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
          return new Response(readIngestFixture('youtube-video-no-chapters.html'), {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        }),
      )

      const output = await ingest('https://youtu.be/dQw4w9WgXcQ?si=madar', join(tempDir, 'raw'), { contributor: 'madar' })
      const content = readFileSync(output, 'utf8')

      expect(requestUrls).toEqual([
        'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json',
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en',
      ])
      expect(content).toContain('type: youtube_video')
      expect(content).toContain('source_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"')
      expect(content).toContain('title: "Madar Demo Walkthrough"')
      expect(content).toContain('author: "Madar Channel"')
      expect(content).toContain('contributor: "madar"')
      expect(content).toContain('video_platform: "youtube"')
      expect(content).toContain('video_id: "dQw4w9WgXcQ"')
      expect(content).toContain('video_provider: "YouTube"')
      expect(content).toContain('video_capture_status: "oembed"')
      expect(content).toContain('video_channel_url: "https://www.youtube.com/@madar"')
      expect(content).toContain('video_published_date: "2026-04-10"')
      expect(content).toContain('video_duration_seconds: 462')
      expect(content).toContain('video_transcript_available: true')
      expect(content).toContain('video_caption_track_count: 2')
      expect(content).toContain('video_caption_language_codes: ["en", "es"]')
      expect(content).toContain('video_transcript_language_code: "en"')
      expect(content).toContain('video_transcript_segment_count: 3')
      expect(content).toContain('video_thumbnail_url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"')
      expect(content).toContain('video_embed_url: "https://www.youtube.com/embed/dQw4w9WgXcQ"')
      expect(content).toContain('# YouTube Video: Madar Demo Walkthrough')
      expect(content).toContain('## Video')
      expect(content).toContain('[Madar Channel](https://www.youtube.com/@madar)')
      expect(content).toContain('## Transcript')
      expect(content).toContain("- 00:00-00:04 Hello & welcome.")
      expect(content).toContain("- 00:15-00:20 Route-aware ingest's next step.")
      expect(content).toContain('- 00:32-00:37 Transcript line with cue evidence.')
      expect(content).toContain('## Context')
      expect(content).toContain('- Platform: youtube')
      expect(content).toContain('- Video ID: dQw4w9WgXcQ')
      expect(content).toContain('- Published: 2026-04-10')
      expect(content).toContain('- Duration: 07:42')
      expect(content).toContain('- Transcript: available')
      expect(content).toContain('- Caption Languages: en, es')
      expect(content).toContain('- Transcript Language: en')
      expect(content).toContain('- Transcript Segments: 3')
      expect(content).toContain('- Capture Status: oembed')
      expect(content).toContain('## Links')
      expect(content).toContain('[Watch on YouTube](https://www.youtube.com/watch?v=dQw4w9WgXcQ)')
      expect(content).toContain('[Embed Player](https://www.youtube.com/embed/dQw4w9WgXcQ)')
      expect(content).toContain('[Thumbnail](https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg)')
      expect(content).not.toContain('video_chapter_count:')
      expect(content).not.toContain('## Chapters')
      expect(content).not.toContain('provenance:')
    })
  })

  test('adds YouTube chapter context when the canonical watch page exposes chapter markers', async () => {
    await withTempDir(async (tempDir) => {
      const requestUrls: string[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          requestUrls.push(requestUrl)
          if (requestUrl === 'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json') {
            return new Response(
              JSON.stringify({
                title: 'Madar Demo Walkthrough',
                author_name: 'Madar Channel',
                author_url: 'https://www.youtube.com/@madar',
                provider_name: 'YouTube',
                thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
              }),
              {
                status: 200,
                headers: { 'content-type': 'application/json' },
              },
            )
          }

          if (requestUrl === 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en') {
            return new Response(readIngestFixture('youtube-caption-en.xml'), {
              status: 200,
              headers: { 'content-type': 'application/xml; charset=utf-8' },
            })
          }

          expect(requestUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
          return new Response(readIngestFixture('youtube-video.html'), {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        }),
      )

      const output = await ingest('https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=share', join(tempDir, 'raw'), {
        contributor: 'madar',
      })
      const content = readFileSync(output, 'utf8')

      expect(requestUrls).toEqual([
        'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json',
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en',
      ])
      expect(content).toContain('type: youtube_video')
      expect(content).toContain('source_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"')
      expect(content).toContain('video_capture_status: "oembed"')
      expect(content).toContain('video_published_date: "2026-04-10"')
      expect(content).toContain('video_duration_seconds: 462')
      expect(content).toContain('video_transcript_available: true')
      expect(content).toContain('video_caption_track_count: 2')
      expect(content).toContain('video_caption_language_codes: ["en", "es"]')
      expect(content).toContain('video_transcript_language_code: "en"')
      expect(content).toContain('video_transcript_segment_count: 3')
      expect(content).toContain('video_chapter_count: 3')
      expect(content).toContain('## Transcript')
      expect(content).toContain("- 00:00-00:04 Hello & welcome.")
      expect(content).toContain("- 00:15-00:20 Route-aware ingest's next step.")
      expect(content).toContain('- 00:32-00:37 Transcript line with cue evidence.')
      expect(content).toContain('## Chapters')
      expect(content).toContain('- 00:00 Intro')
      expect(content).toContain('- 02:35 Route-aware ingest')
      expect(content).toContain('- 05:20 Next roadmap slice')
      expect(content).toContain('## Context')
      expect(content).toContain('- Published: 2026-04-10')
      expect(content).toContain('- Duration: 07:42')
      expect(content).toContain('- Transcript: available')
      expect(content).toContain('- Caption Languages: en, es')
      expect(content).toContain('- Transcript Language: en')
      expect(content).toContain('- Transcript Segments: 3')
      expect(content).toContain('- Chapters: 3')
      expect(content).not.toContain('feature=share')
      expect(content).not.toContain('provenance:')
    })
  })

  test('prefers non-auto YouTube caption tracks over auto-generated tracks in the primary language', async () => {
    await withTempDir(async (tempDir) => {
      const requestUrls: string[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          requestUrls.push(requestUrl)
          if (requestUrl === 'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json') {
            return new Response(
              JSON.stringify({
                title: 'Madar Demo Walkthrough',
                author_name: 'Madar Channel',
                author_url: 'https://www.youtube.com/@madar',
                provider_name: 'YouTube',
                thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
              }),
              {
                status: 200,
                headers: { 'content-type': 'application/json' },
              },
            )
          }

          if (requestUrl === 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en') {
            return new Response(readIngestFixture('youtube-caption-en.xml'), {
              status: 200,
              headers: { 'content-type': 'application/xml; charset=utf-8' },
            })
          }

          if (requestUrl === 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&kind=asr') {
            return new Response(readIngestFixture('youtube-caption-en-auto.xml'), {
              status: 200,
              headers: { 'content-type': 'application/xml; charset=utf-8' },
            })
          }

          expect(requestUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
          return new Response(
            '<html><head><title>Madar Demo Walkthrough - YouTube</title><link rel="canonical" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ" /><meta property="og:url" content="https://www.youtube.com/watch?v=dQw4w9WgXcQ" /><meta property="og:title" content="Madar Demo Walkthrough" /><meta property="og:image" content="https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" /><meta itemprop="datePublished" content="2026-04-10" /><meta itemprop="duration" content="PT7M42S" /><meta name="author" content="Madar Channel" /><script>var ytInitialData = {"videoDetails":{"videoId":"dQw4w9WgXcQ","title":"Madar Demo Walkthrough"}}; var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&kind=asr","languageCode":"en","kind":"asr","name":{"simpleText":"English (auto-generated)"}},{"baseUrl":"https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en","languageCode":"en","name":{"simpleText":"English"}},{"baseUrl":"https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=es","languageCode":"es","name":{"simpleText":"Español"}}]}}};</script></head><body><ytd-watch-flexy><main><h1>Madar Demo Walkthrough</h1></main></ytd-watch-flexy></body></html>',
            {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            },
          )
        }),
      )

      const output = await ingest('https://www.youtube.com/watch?v=dQw4w9WgXcQ', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(requestUrls).toEqual([
        'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json',
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en',
      ])
      expect(content).toContain('video_transcript_language_code: "en"')
      expect(content).toContain('video_transcript_segment_count: 3')
      expect(content).toContain('video_caption_track_count: 3')
      expect(content).toContain('video_caption_language_codes: ["en", "es"]')
      expect(content).toContain("- 00:00-00:04 Hello & welcome.")
      expect(content).not.toContain('Auto-generated intro.')
    })
  })

  test('falls back to another confirmed caption track when the preferred YouTube transcript track yields no cues', async () => {
    await withTempDir(async (tempDir) => {
      const requestUrls: string[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          requestUrls.push(requestUrl)
          if (requestUrl === 'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json') {
            return new Response(
              JSON.stringify({
                title: 'Madar Demo Walkthrough',
                author_name: 'Madar Channel',
                author_url: 'https://www.youtube.com/@madar',
                provider_name: 'YouTube',
                thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
              }),
              {
                status: 200,
                headers: { 'content-type': 'application/json' },
              },
            )
          }

          if (requestUrl === 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en') {
            return new Response('<transcript></transcript>', {
              status: 200,
              headers: { 'content-type': 'application/xml; charset=utf-8' },
            })
          }

          if (requestUrl === 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&kind=asr') {
            return new Response(readIngestFixture('youtube-caption-en-auto.xml'), {
              status: 200,
              headers: { 'content-type': 'application/xml; charset=utf-8' },
            })
          }

          expect(requestUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
          return new Response(
            '<html><head><title>Madar Demo Walkthrough - YouTube</title><link rel="canonical" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ" /><meta property="og:url" content="https://www.youtube.com/watch?v=dQw4w9WgXcQ" /><meta property="og:title" content="Madar Demo Walkthrough" /><meta property="og:image" content="https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" /><meta itemprop="datePublished" content="2026-04-10" /><meta itemprop="duration" content="PT7M42S" /><meta name="author" content="Madar Channel" /><script>var ytInitialData = {"videoDetails":{"videoId":"dQw4w9WgXcQ","title":"Madar Demo Walkthrough"}}; var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&kind=asr","languageCode":"en","kind":"asr","name":{"simpleText":"English (auto-generated)"}},{"baseUrl":"https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en","languageCode":"en","name":{"simpleText":"English"}},{"baseUrl":"https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=es","languageCode":"es","name":{"simpleText":"Español"}}]}}};</script></head><body><ytd-watch-flexy><main><h1>Madar Demo Walkthrough</h1></main></ytd-watch-flexy></body></html>',
            {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            },
          )
        }),
      )

      const output = await ingest('https://www.youtube.com/watch?v=dQw4w9WgXcQ', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(requestUrls).toEqual([
        'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json',
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en',
        'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&kind=asr',
      ])
      expect(content).toContain('video_transcript_language_code: "en"')
      expect(content).toContain('video_transcript_segment_count: 3')
      expect(content).toContain('- 00:00-00:03 Auto-generated intro.')
      expect(content).toContain('- 00:09-00:12 Auto-generated fallback path.')
      expect(content).not.toContain('Hello & welcome.')
    })
  })

  test('keeps YouTube watch metadata optional when the canonical watch page does not expose publish, duration, or transcript fields', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          if (requestUrl === 'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json') {
            return new Response(
              JSON.stringify({
                title: 'Madar Demo Walkthrough',
                author_name: 'Madar Channel',
                author_url: 'https://www.youtube.com/@madar',
                provider_name: 'YouTube',
                thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
              }),
              {
                status: 200,
                headers: { 'content-type': 'application/json' },
              },
            )
          }

          expect(requestUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
          return new Response(
            '<html><head><title>Madar Demo Walkthrough - YouTube</title><link rel="canonical" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ" /><meta property="og:url" content="https://www.youtube.com/watch?v=dQw4w9WgXcQ" /><meta property="og:title" content="Madar Demo Walkthrough" /><meta property="og:image" content="https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" /><meta name="author" content="Madar Channel" /></head><body><main><h1>Madar Demo Walkthrough</h1></main></body></html>',
            {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            },
          )
        }),
      )

      const output = await ingest('https://www.youtube.com/watch?v=dQw4w9WgXcQ', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: youtube_video')
      expect(content).not.toContain('video_published_date:')
      expect(content).not.toContain('video_duration_seconds:')
      expect(content).not.toContain('video_transcript_available:')
      expect(content).not.toContain('video_caption_track_count:')
      expect(content).not.toContain('video_caption_language_codes:')
      expect(content).not.toContain('- Published:')
      expect(content).not.toContain('- Duration:')
      expect(content).not.toContain('- Transcript:')
      expect(content).not.toContain('- Caption Languages:')
    })
  })

  test('preserves raw YouTube caption track count even when multiple tracks share a language code', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          if (requestUrl === 'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json') {
            return new Response(
              JSON.stringify({
                title: 'Madar Demo Walkthrough',
                author_name: 'Madar Channel',
                author_url: 'https://www.youtube.com/@madar',
                provider_name: 'YouTube',
                thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
              }),
              {
                status: 200,
                headers: { 'content-type': 'application/json' },
              },
            )
          }

          expect(requestUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
          return new Response(
            '<html><head><title>Madar Demo Walkthrough - YouTube</title><link rel="canonical" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ" /><meta property="og:url" content="https://www.youtube.com/watch?v=dQw4w9WgXcQ" /><meta property="og:title" content="Madar Demo Walkthrough" /><meta property="og:image" content="https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" /><meta itemprop="datePublished" content="2026-04-10" /><meta itemprop="duration" content="PT7M42S" /><meta name="author" content="Madar Channel" /><script>var ytInitialData = {"videoDetails":{"videoId":"dQw4w9WgXcQ","title":"Madar Demo Walkthrough"}}; var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en","languageCode":"en","name":{"simpleText":"English"}},{"baseUrl":"https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&kind=asr","languageCode":"en","name":{"simpleText":"English (auto-generated)"}},{"baseUrl":"https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=es","languageCode":"es","name":{"simpleText":"Español"}}]}}};</script></head><body><ytd-watch-flexy><main><h1>Madar Demo Walkthrough</h1></main></ytd-watch-flexy></body></html>',
            {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            },
          )
        }),
      )

      const output = await ingest('https://www.youtube.com/watch?v=dQw4w9WgXcQ', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: youtube_video')
      expect(content).toContain('video_transcript_available: true')
      expect(content).toContain('video_caption_track_count: 3')
      expect(content).toContain('video_caption_language_codes: ["en", "es"]')
      expect(content).toContain('- Transcript: available')
      expect(content).toContain('- Caption Languages: en, es')
    })
  })

  test('emits a zero caption-track count when confirmed watch HTML exposes an empty caption track list', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          if (requestUrl === 'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json') {
            return new Response(
              JSON.stringify({
                title: 'Madar Demo Walkthrough',
                author_name: 'Madar Channel',
                author_url: 'https://www.youtube.com/@madar',
                provider_name: 'YouTube',
                thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
              }),
              {
                status: 200,
                headers: { 'content-type': 'application/json' },
              },
            )
          }

          expect(requestUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
          return new Response(
            '<html><head><title>Madar Demo Walkthrough - YouTube</title><link rel="canonical" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ" /><meta property="og:url" content="https://www.youtube.com/watch?v=dQw4w9WgXcQ" /><meta property="og:title" content="Madar Demo Walkthrough" /><meta property="og:image" content="https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" /><meta name="author" content="Madar Channel" /><script>var ytInitialData = {"videoDetails":{"videoId":"dQw4w9WgXcQ","title":"Madar Demo Walkthrough"}}; var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[]}}};</script></head><body><ytd-watch-flexy><main><h1>Madar Demo Walkthrough</h1></main></ytd-watch-flexy></body></html>',
            {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            },
          )
        }),
      )

      const output = await ingest('https://www.youtube.com/watch?v=dQw4w9WgXcQ', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: youtube_video')
      expect(content).toContain('video_caption_track_count: 0')
      expect(content).not.toContain('video_transcript_available:')
      expect(content).not.toContain('video_caption_language_codes:')
      expect(content).not.toContain('- Transcript:')
      expect(content).not.toContain('- Caption Languages:')
    })
  })

  test('keeps YouTube transcript cue evidence optional when all confirmed caption track fetches fail', async () => {
    await withTempDir(async (tempDir) => {
      const requestUrls: string[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          requestUrls.push(requestUrl)
          if (requestUrl === 'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json') {
            return new Response(
              JSON.stringify({
                title: 'Madar Demo Walkthrough',
                author_name: 'Madar Channel',
                author_url: 'https://www.youtube.com/@madar',
                provider_name: 'YouTube',
                thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
              }),
              {
                status: 200,
                headers: { 'content-type': 'application/json' },
              },
            )
          }

          if (requestUrl === 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en') {
            return new Response('upstream unavailable', {
              status: 502,
              headers: { 'content-type': 'text/plain; charset=utf-8' },
            })
          }

          if (requestUrl === 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=es') {
            return new Response('upstream unavailable', {
              status: 502,
              headers: { 'content-type': 'text/plain; charset=utf-8' },
            })
          }

          expect(requestUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
          return new Response(readIngestFixture('youtube-video-no-chapters.html'), {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        }),
      )

      const output = await ingest('https://www.youtube.com/watch?v=dQw4w9WgXcQ', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(requestUrls).toEqual([
        'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json',
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en',
        'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=es',
      ])
      expect(content).toContain('type: youtube_video')
      expect(content).toContain('video_transcript_available: true')
      expect(content).toContain('video_caption_track_count: 2')
      expect(content).toContain('video_caption_language_codes: ["en", "es"]')
      expect(content).not.toContain('video_transcript_language_code:')
      expect(content).not.toContain('video_transcript_segment_count:')
      expect(content).not.toContain('## Transcript')
      expect(content).not.toContain('- Transcript Language:')
      expect(content).not.toContain('- Transcript Segments:')
    })
  })

  test('keeps start-only YouTube transcript cue bullets for malformed durations and skips malformed starts', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          if (requestUrl === 'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json') {
            return new Response(
              JSON.stringify({
                title: 'Madar Demo Walkthrough',
                author_name: 'Madar Channel',
                author_url: 'https://www.youtube.com/@madar',
                provider_name: 'YouTube',
                thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
              }),
              {
                status: 200,
                headers: { 'content-type': 'application/json' },
              },
            )
          }

          if (requestUrl === 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en') {
            return new Response(readIngestFixture('youtube-caption-mixed-timing.xml'), {
              status: 200,
              headers: { 'content-type': 'application/xml; charset=utf-8' },
            })
          }

          expect(requestUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
          return new Response(readIngestFixture('youtube-video-no-chapters.html'), {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        }),
      )

      const output = await ingest('https://www.youtube.com/watch?v=dQw4w9WgXcQ', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: youtube_video')
      expect(content).toContain('video_transcript_language_code: "en"')
      expect(content).toContain('video_transcript_segment_count: 3')
      expect(content).toContain('## Transcript')
      expect(content).toContain('- 00:00-00:04 Timed intro.')
      expect(content).toContain('- 00:08 Start-only cue.')
      expect(content).toContain('- 00:12 Invalid-duration cue.')
      expect(content).not.toContain('Invalid-start cue.')
    })
  })

  test('does not enrich YouTube watch metadata from same-url HTML that lacks a real watch-page marker', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          if (requestUrl === 'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json') {
            return new Response(
              JSON.stringify({
                title: 'Madar Demo Walkthrough',
                author_name: 'Madar Channel',
                author_url: 'https://www.youtube.com/@madar',
                provider_name: 'YouTube',
                thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
              }),
              {
                status: 200,
                headers: { 'content-type': 'application/json' },
              },
            )
          }

          expect(requestUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
          return new Response(
            '<html><head><title>Before you continue - YouTube</title><link rel="canonical" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ" /><meta property="og:url" content="https://www.youtube.com/watch?v=dQw4w9WgXcQ" /><meta itemprop="datePublished" content="2026-04-10" /><meta itemprop="duration" content="PT7M42S" /><script>var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en","languageCode":"en","name":{"simpleText":"English"}}]}}}; var ytInitialData = {"videoDetails":{"videoId":"dQw4w9WgXcQ","title":"Madar Demo Walkthrough"},"consentRenderer":{"message":"Consent required"},"playerOverlays":{"consentBumpRenderer":{}}};</script></head><body><div id="consent-bump">Consent required</div></body></html>',
            {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            },
          )
        }),
      )

      const output = await ingest('https://www.youtube.com/watch?v=dQw4w9WgXcQ', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: youtube_video')
      expect(content).toContain('video_capture_status: "oembed"')
      expect(content).not.toContain('video_published_date:')
      expect(content).not.toContain('video_duration_seconds:')
      expect(content).not.toContain('video_transcript_available:')
      expect(content).not.toContain('video_caption_track_count:')
      expect(content).not.toContain('video_caption_language_codes:')
      expect(content).not.toContain('- Published:')
      expect(content).not.toContain('- Duration:')
      expect(content).not.toContain('- Transcript:')
      expect(content).not.toContain('- Caption Languages:')
    })
  })

  test('does not enrich YouTube watch metadata when watch-shell HTML confirms a different video identity', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          if (requestUrl === 'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json') {
            return new Response(
              JSON.stringify({
                title: 'Madar Demo Walkthrough',
                author_name: 'Madar Channel',
                author_url: 'https://www.youtube.com/@madar',
                provider_name: 'YouTube',
                thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
              }),
              {
                status: 200,
                headers: { 'content-type': 'application/json' },
              },
            )
          }

          expect(requestUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
          return new Response(
            '<html><head><title>Different Video - YouTube</title><link rel="canonical" href="https://www.youtube.com/watch?v=oHg5SJYRHA0" /><meta property="og:url" content="https://www.youtube.com/watch?v=oHg5SJYRHA0" /><meta itemprop="datePublished" content="2026-04-10" /><meta itemprop="duration" content="PT7M42S" /><script>var ytInitialData = {"videoDetails":{"videoId":"oHg5SJYRHA0","title":"Different Video"}}; var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=oHg5SJYRHA0&lang=en","languageCode":"en","name":{"simpleText":"English"}}]}}};</script></head><body><ytd-watch-flexy><main><h1>Different Video</h1></main></ytd-watch-flexy></body></html>',
            {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            },
          )
        }),
      )

      const output = await ingest('https://www.youtube.com/watch?v=dQw4w9WgXcQ', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: youtube_video')
      expect(content).toContain('video_capture_status: "oembed"')
      expect(content).not.toContain('video_published_date:')
      expect(content).not.toContain('video_duration_seconds:')
      expect(content).not.toContain('video_transcript_available:')
      expect(content).not.toContain('video_caption_track_count:')
      expect(content).not.toContain('video_caption_language_codes:')
      expect(content).not.toContain('- Published:')
      expect(content).not.toContain('- Duration:')
      expect(content).not.toContain('- Transcript:')
      expect(content).not.toContain('- Caption Languages:')
    })
  })

  test('does not enrich YouTube watch metadata when HTML identity signals conflict', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          if (requestUrl === 'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json') {
            return new Response(
              JSON.stringify({
                title: 'Madar Demo Walkthrough',
                author_name: 'Madar Channel',
                author_url: 'https://www.youtube.com/@madar',
                provider_name: 'YouTube',
                thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
              }),
              {
                status: 200,
                headers: { 'content-type': 'application/json' },
              },
            )
          }

          expect(requestUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
          return new Response(
            '<html><head><title>Conflicting Video - YouTube</title><link rel="canonical" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ" /><meta property="og:url" content="https://www.youtube.com/watch?v=dQw4w9WgXcQ" /><meta itemprop="datePublished" content="2026-04-10" /><meta itemprop="duration" content="PT7M42S" /><script>var ytInitialData = {"videoDetails":{"videoId":"oHg5SJYRHA0","title":"Conflicting Video"}}; var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=oHg5SJYRHA0&lang=en","languageCode":"en","name":{"simpleText":"English"}}]}}};</script></head><body><ytd-watch-flexy><main><h1>Conflicting Video</h1></main></ytd-watch-flexy></body></html>',
            {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            },
          )
        }),
      )

      const output = await ingest('https://www.youtube.com/watch?v=dQw4w9WgXcQ', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: youtube_video')
      expect(content).toContain('video_capture_status: "oembed"')
      expect(content).not.toContain('video_published_date:')
      expect(content).not.toContain('video_duration_seconds:')
      expect(content).not.toContain('video_transcript_available:')
      expect(content).not.toContain('video_caption_track_count:')
      expect(content).not.toContain('video_caption_language_codes:')
      expect(content).not.toContain('- Published:')
      expect(content).not.toContain('- Duration:')
      expect(content).not.toContain('- Transcript:')
      expect(content).not.toContain('- Caption Languages:')
    })
  })

  test('canonicalizes YouTube shorts, live, and embed URLs to the same structured video asset', async () => {
    await withTempDir(async (tempDir) => {
      const requestUrls: string[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          requestUrls.push(requestUrl)
          if (requestUrl === 'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json') {
            return new Response(
              JSON.stringify({
                title: 'Madar Demo Walkthrough',
                author_name: 'Madar Channel',
                author_url: 'https://www.youtube.com/@madar',
                provider_name: 'YouTube',
                thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
              }),
              {
                status: 200,
                headers: { 'content-type': 'application/json' },
              },
            )
          }

          if (requestUrl === 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en') {
            return new Response(readIngestFixture('youtube-caption-en.xml'), {
              status: 200,
              headers: { 'content-type': 'application/xml; charset=utf-8' },
            })
          }

          expect(requestUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
          return new Response(readIngestFixture('youtube-video-no-chapters.html'), {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        }),
      )

      const shortsOutput = await ingest('https://www.youtube.com/shorts/dQw4w9WgXcQ?feature=share', join(tempDir, 'raw'))
      const liveOutput = await ingest('https://www.youtube.com/live/dQw4w9WgXcQ?feature=share', join(tempDir, 'raw'))
      const embedOutput = await ingest('https://www.youtube.com/embed/dQw4w9WgXcQ?start=30', join(tempDir, 'raw'))
      const content = readFileSync(embedOutput, 'utf8')

      expect(requestUrls).toEqual([
        'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json',
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en',
        'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json',
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en',
        'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json',
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en',
      ])
      expect(basename(shortsOutput)).toBe('youtube_dQw4w9WgXcQ.md')
      expect(basename(liveOutput)).toMatch(/^youtube_dQw4w9WgXcQ(?:_\d+)?\.md$/)
      expect(basename(embedOutput)).toMatch(/^youtube_dQw4w9WgXcQ(?:_\d+)?\.md$/)
      expect(content).toContain('type: youtube_video')
      expect(content).toContain('source_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"')
      expect(content).toContain('video_id: "dQw4w9WgXcQ"')
      expect(content).toContain('video_capture_status: "oembed"')
      expect(content).toContain('video_transcript_available: true')
      expect(content).toContain('video_caption_language_codes: ["en", "es"]')
      expect(content).toContain('video_transcript_language_code: "en"')
      expect(content).toContain('video_transcript_segment_count: 3')
      expect(content).toContain('[Watch on YouTube](https://www.youtube.com/watch?v=dQw4w9WgXcQ)')
      expect(content).toContain('[Embed Player](https://www.youtube.com/embed/dQw4w9WgXcQ)')
      expect(content).toContain('## Transcript')
      expect(content).toContain('- 00:00-00:04 Hello & welcome.')
      expect(content).toContain("- 00:15-00:20 Route-aware ingest's next step.")
      expect(content).toContain('- 00:32-00:37 Transcript line with cue evidence.')
      expect(content).not.toContain('## Chapters')
    })
  })

  test('saves YouTube playlist URLs as structured playlist markdown', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          expect(requestUrl).toBe('https://www.youtube.com/playlist?list=PLmadarRoadmap123')
          return new Response(readIngestFixture('youtube-playlist.html'), {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        }),
      )

      const output = await ingest('https://www.youtube.com/playlist?list=PLmadarRoadmap123&feature=share', join(tempDir, 'raw'), {
        contributor: 'madar',
      })
      const content = readFileSync(output, 'utf8')

      expect(basename(output)).toBe('youtube_playlist_PLmadarRoadmap123.md')
      expect(content).toContain('type: youtube_playlist')
      expect(content).toContain('source_url: "https://www.youtube.com/playlist?list=PLmadarRoadmap123"')
      expect(content).toContain('title: "Madar Roadmap Sessions"')
      expect(content).toContain('author: "Madar Channel"')
      expect(content).toContain('description: "Deterministic roadmap demos and implementation updates for madar."')
      expect(content).toContain('contributor: "madar"')
      expect(content).toContain('youtube_platform: "youtube"')
      expect(content).toContain('youtube_kind: "playlist"')
      expect(content).toContain('youtube_playlist_id: "PLmadarRoadmap123"')
      expect(content).toContain('youtube_capture_status: "html"')
      expect(content).toContain('youtube_thumbnail_url: "https://i.ytimg.com/vi_webp/playlist/default.jpg"')
      expect(content).toContain('# YouTube Playlist: Madar Roadmap Sessions')
      expect(content).toContain('## Playlist')
      expect(content).toContain('Playlist by Madar Channel.')
      expect(content).toContain('Deterministic roadmap demos and implementation updates for madar.')
      expect(content).toContain('## Context')
      expect(content).toContain('- Platform: youtube')
      expect(content).toContain('- Kind: playlist')
      expect(content).toContain('- Playlist ID: PLmadarRoadmap123')
      expect(content).toContain('- Capture Status: html')
      expect(content).toContain('## Links')
      expect(content).toContain('[Open Playlist](https://www.youtube.com/playlist?list=PLmadarRoadmap123)')
      expect(content).toContain('[Thumbnail](https://i.ytimg.com/vi_webp/playlist/default.jpg)')
      expect(content).not.toContain('feature=share')
      expect(content).not.toContain('provenance:')
    })
  })

  test('falls back to generic webpage capture when fetched YouTube playlist HTML does not confirm a playlist page', async () => {
    await withTempDir(async (tempDir) => {
      stubHtmlFetch(
        '<html><head><title>Madar Demo Walkthrough - YouTube</title><link rel="canonical" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ" /></head><body><main><p>Video page.</p></main></body></html>',
      )

      const output = await ingest('https://www.youtube.com/playlist?list=PLmadarRoadmap123', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: webpage')
      expect(content).toContain('source_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"')
      expect(content).not.toContain('type: youtube_playlist')
      expect(content).not.toContain('youtube_kind:')
    })
  })

  test('falls back to generic webpage capture when a non-playlist YouTube page echoes the requested playlist id', async () => {
    await withTempDir(async (tempDir) => {
      stubHtmlFetch(
        '<html><head><title>Madar Consent - YouTube</title><link rel="canonical" href="https://www.youtube.com/playlist?list=PLmadarRoadmap123" /></head><body><main><script>var ytInitialData = {"playlistId":"PLmadarRoadmap123"};</script><p>Consent page.</p></main></body></html>',
      )

      const output = await ingest('https://www.youtube.com/playlist?list=PLmadarRoadmap123', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: webpage')
      expect(content).toContain('source_url: "https://www.youtube.com/playlist?list=PLmadarRoadmap123"')
      expect(content).not.toContain('type: youtube_playlist')
      expect(content).not.toContain('youtube_kind:')
    })
  })

  test('falls back to generic webpage capture for YouTube playlist routes with a trailing slash', async () => {
    await withTempDir(async (tempDir) => {
      stubHtmlFetch(readIngestFixture('youtube-playlist.html'))

      const output = await ingest('https://www.youtube.com/playlist/?list=PLmadarRoadmap123', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: webpage')
      expect(content).toContain('source_url: "https://www.youtube.com/playlist?list=PLmadarRoadmap123"')
      expect(content).not.toContain('type: youtube_playlist')
      expect(content).not.toContain('youtube_kind:')
    })
  })

  test('saves YouTube @handle channel URLs as structured channel markdown', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          expect(requestUrl).toBe('https://www.youtube.com/@madar')
          return new Response(readIngestFixture('youtube-channel.html'), {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        }),
      )

      const output = await ingest('https://www.youtube.com/@madar?feature=share', join(tempDir, 'raw'), {
        contributor: 'madar',
      })
      const content = readFileSync(output, 'utf8')

      expect(basename(output)).toBe('youtube_channel_madar.md')
      expect(content).toContain('type: youtube_channel')
      expect(content).toContain('source_url: "https://www.youtube.com/@madar"')
      expect(content).toContain('title: "Madar Channel"')
      expect(content).toContain('author: "Madar Channel"')
      expect(content).toContain('description: "Deterministic roadmap demos, graph explainers, and structured ingest updates."')
      expect(content).toContain('contributor: "madar"')
      expect(content).toContain('youtube_platform: "youtube"')
      expect(content).toContain('youtube_kind: "channel"')
      expect(content).toContain('youtube_channel_handle: "madar"')
      expect(content).toContain('youtube_channel_id: "UCmadarRoadmap1234567890"')
      expect(content).toContain('youtube_capture_status: "html"')
      expect(content).toContain('youtube_thumbnail_url: "https://yt3.googleusercontent.com/madar-channel-photo=s176"')
      expect(content).toContain('# YouTube Channel: Madar Channel')
      expect(content).toContain('## Channel')
      expect(content).toContain('YouTube channel @madar.')
      expect(content).toContain('Deterministic roadmap demos, graph explainers, and structured ingest updates.')
      expect(content).toContain('## Context')
      expect(content).toContain('- Platform: youtube')
      expect(content).toContain('- Kind: channel')
      expect(content).toContain('- Handle: @madar')
      expect(content).toContain('- Channel ID: UCmadarRoadmap1234567890')
      expect(content).toContain('- Capture Status: html')
      expect(content).toContain('## Links')
      expect(content).toContain('[Open Channel](https://www.youtube.com/@madar)')
      expect(content).toContain('[Thumbnail](https://yt3.googleusercontent.com/madar-channel-photo=s176)')
      expect(content).not.toContain('feature=share')
      expect(content).not.toContain('provenance:')
    })
  })

  test('canonicalizes YouTube @handle channel urls case-insensitively before structured capture', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          expect(requestUrl).toBe('https://www.youtube.com/@madar')
          return new Response(readIngestFixture('youtube-channel.html'), {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        }),
      )

      const output = await ingest('https://www.youtube.com/@Madar?feature=share', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(basename(output)).toBe('youtube_channel_madar.md')
      expect(content).toContain('type: youtube_channel')
      expect(content).toContain('source_url: "https://www.youtube.com/@madar"')
      expect(content).not.toContain('@Madar')
    })
  })

  test('saves YouTube /channel/<id> URLs as structured channel markdown', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          expect(requestUrl).toBe('https://www.youtube.com/channel/UCmadarRoadmap1234567890')
          return new Response(readIngestFixture('youtube-channel.html'), {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        }),
      )

      const output = await ingest('https://www.youtube.com/channel/UCmadarRoadmap1234567890?feature=share', join(tempDir, 'raw'), {
        contributor: 'madar',
      })
      const content = readFileSync(output, 'utf8')

      expect(basename(output)).toBe('youtube_channel_madar.md')
      expect(content).toContain('type: youtube_channel')
      expect(content).toContain('source_url: "https://www.youtube.com/@madar"')
      expect(content).toContain('title: "Madar Channel"')
      expect(content).toContain('author: "Madar Channel"')
      expect(content).toContain('description: "Deterministic roadmap demos, graph explainers, and structured ingest updates."')
      expect(content).toContain('contributor: "madar"')
      expect(content).toContain('youtube_platform: "youtube"')
      expect(content).toContain('youtube_kind: "channel"')
      expect(content).toContain('youtube_channel_handle: "madar"')
      expect(content).toContain('youtube_channel_id: "UCmadarRoadmap1234567890"')
      expect(content).toContain('youtube_capture_status: "html"')
      expect(content).toContain('youtube_thumbnail_url: "https://yt3.googleusercontent.com/madar-channel-photo=s176"')
      expect(content).toContain('# YouTube Channel: Madar Channel')
      expect(content).toContain('## Channel')
      expect(content).toContain('YouTube channel @madar.')
      expect(content).toContain('## Context')
      expect(content).toContain('- Handle: @madar')
      expect(content).toContain('- Channel ID: UCmadarRoadmap1234567890')
      expect(content).toContain('- Capture Status: html')
      expect(content).toContain('## Links')
      expect(content).toContain('[Open Channel](https://www.youtube.com/@madar)')
      expect(content).not.toContain('feature=share')
      expect(content).not.toContain('provenance:')
    })
  })

  test('saves YouTube /c/<slug> URLs as structured channel markdown', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          expect(requestUrl).toBe('https://www.youtube.com/c/madar')
          return new Response(readIngestFixture('youtube-channel.html'), {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        }),
      )

      const output = await ingest('https://www.youtube.com/c/madar?feature=share', join(tempDir, 'raw'), {
        contributor: 'madar',
      })
      const content = readFileSync(output, 'utf8')

      expect(basename(output)).toBe('youtube_channel_madar.md')
      expect(content).toContain('type: youtube_channel')
      expect(content).toContain('source_url: "https://www.youtube.com/@madar"')
      expect(content).toContain('title: "Madar Channel"')
      expect(content).toContain('author: "Madar Channel"')
      expect(content).toContain('description: "Deterministic roadmap demos, graph explainers, and structured ingest updates."')
      expect(content).toContain('contributor: "madar"')
      expect(content).toContain('youtube_platform: "youtube"')
      expect(content).toContain('youtube_kind: "channel"')
      expect(content).toContain('youtube_channel_handle: "madar"')
      expect(content).toContain('youtube_channel_id: "UCmadarRoadmap1234567890"')
      expect(content).toContain('youtube_channel_custom_slug: "madar"')
      expect(content).toContain('youtube_capture_status: "html"')
      expect(content).toContain('youtube_thumbnail_url: "https://yt3.googleusercontent.com/madar-channel-photo=s176"')
      expect(content).toContain('# YouTube Channel: Madar Channel')
      expect(content).toContain('## Channel')
      expect(content).toContain('YouTube channel @madar.')
      expect(content).toContain('## Context')
      expect(content).toContain('- Handle: @madar')
      expect(content).toContain('- Channel ID: UCmadarRoadmap1234567890')
      expect(content).toContain('- Custom URL: /c/madar')
      expect(content).toContain('- Capture Status: html')
      expect(content).toContain('## Links')
      expect(content).toContain('[Open Channel](https://www.youtube.com/@madar)')
      expect(content).not.toContain('feature=share')
      expect(content).not.toContain('provenance:')
    })
  })

  test('saves YouTube /c/<slug> URLs as structured channel markdown when the root page canonicalizes to @handle without exposing externalId', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          expect(requestUrl).toBe('https://www.youtube.com/c/madar')
          return new Response(
            '<html><head><title>Madar Channel - YouTube</title><link rel="canonical" href="https://www.youtube.com/@madar" /><meta property="og:url" content="https://www.youtube.com/@madar" /><meta property="og:title" content="Madar Channel" /><meta property="og:description" content="Deterministic roadmap demos, graph explainers, and structured ingest updates." /><meta property="og:image" content="https://yt3.googleusercontent.com/madar-channel-photo=s176" /><meta name="author" content="Madar Channel" /><script>var ytInitialData = {"header":{"c4TabbedHeaderRenderer":{"channelHandleText":{"simpleText":"@madar"}}},"metadata":{"channelMetadataRenderer":{"title":"Madar Channel","description":"Deterministic roadmap demos, graph explainers, and structured ingest updates.","vanityChannelUrl":"https://www.youtube.com/@madar"}}};</script></head><body><main><h1>Madar Channel</h1></main></body></html>',
            {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            },
          )
        }),
      )

      const output = await ingest('https://www.youtube.com/c/madar', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: youtube_channel')
      expect(content).toContain('source_url: "https://www.youtube.com/@madar"')
      expect(content).toContain('youtube_channel_handle: "madar"')
      expect(content).toContain('youtube_channel_custom_slug: "madar"')
      expect(content).toContain('youtube_capture_status: "html"')
      expect(content).not.toContain('type: webpage')
    })
  })

  test('drops unconfirmed /c/<slug> metadata when a custom-channel request redirects to a different root channel identity', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          if (requestUrl === 'https://www.youtube.com/c/madar') {
            return new Response(null, {
              status: 302,
              headers: { location: 'https://www.youtube.com/@otherchannel' },
            })
          }

          expect(requestUrl).toBe('https://www.youtube.com/@otherchannel')
          return new Response(
            '<html><head><title>Other Channel - YouTube</title><link rel="canonical" href="https://www.youtube.com/@otherchannel" /><meta property="og:url" content="https://www.youtube.com/@otherchannel" /><meta property="og:title" content="Other Channel" /><meta property="og:description" content="Different redirected channel." /><meta property="og:image" content="https://yt3.googleusercontent.com/other-channel-photo=s176" /><meta name="author" content="Other Channel" /><script>var ytInitialData = {"header":{"c4TabbedHeaderRenderer":{"channelHandleText":{"simpleText":"@otherchannel"}}},"metadata":{"channelMetadataRenderer":{"title":"Other Channel","description":"Different redirected channel.","vanityChannelUrl":"https://www.youtube.com/@otherchannel","externalId":"UC1234567890123456789012"}}};</script></head><body><main><h1>Other Channel</h1></main></body></html>',
            {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            },
          )
        }),
      )

      const output = await ingest('https://www.youtube.com/c/madar', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(basename(output)).toBe('youtube_channel_otherchannel.md')
      expect(content).toContain('type: youtube_channel')
      expect(content).toContain('source_url: "https://www.youtube.com/@otherchannel"')
      expect(content).toContain('youtube_channel_handle: "otherchannel"')
      expect(content).toContain('youtube_channel_id: "UC1234567890123456789012"')
      expect(content).not.toContain('youtube_channel_custom_slug:')
      expect(content).not.toContain('- Custom URL: /c/madar')
      expect(content).not.toContain('type: webpage')
    })
  })

  test('saves YouTube /channel/<id> URLs as structured channel markdown when the root page canonicalizes to @handle without exposing externalId', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          expect(requestUrl).toBe('https://www.youtube.com/channel/UCmadarRoadmap1234567890')
          return new Response(
            '<html><head><title>Madar Channel - YouTube</title><link rel="canonical" href="https://www.youtube.com/@madar" /><meta property="og:url" content="https://www.youtube.com/@madar" /><meta property="og:title" content="Madar Channel" /><meta property="og:description" content="Deterministic roadmap demos, graph explainers, and structured ingest updates." /><meta property="og:image" content="https://yt3.googleusercontent.com/madar-channel-photo=s176" /><meta name="author" content="Madar Channel" /><script>var ytInitialData = {"header":{"c4TabbedHeaderRenderer":{"channelHandleText":{"simpleText":"@madar"}}},"metadata":{"channelMetadataRenderer":{"title":"Madar Channel","description":"Deterministic roadmap demos, graph explainers, and structured ingest updates.","vanityChannelUrl":"https://www.youtube.com/@madar"}}};</script></head><body><main><h1>Madar Channel</h1></main></body></html>',
            {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            },
          )
        }),
      )

      const output = await ingest('https://www.youtube.com/channel/UCmadarRoadmap1234567890', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: youtube_channel')
      expect(content).toContain('source_url: "https://www.youtube.com/@madar"')
      expect(content).toContain('youtube_channel_handle: "madar"')
      expect(content).toContain('youtube_channel_id: "UCmadarRoadmap1234567890"')
      expect(content).toContain('youtube_capture_status: "html"')
      expect(content).not.toContain('type: webpage')
    })
  })

  test('falls back to generic webpage capture when fetched YouTube @handle HTML does not confirm a channel page', async () => {
    await withTempDir(async (tempDir) => {
      stubHtmlFetch(
        '<html><head><title>Madar Consent - YouTube</title><link rel="canonical" href="https://www.youtube.com/@madar" /></head><body><main><script>var ytInitialData = {"vanityChannelUrl":"https://www.youtube.com/@madar"};</script><p>Consent page.</p></main></body></html>',
      )

      const output = await ingest('https://www.youtube.com/@madar', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: webpage')
      expect(content).toContain('source_url: "https://www.youtube.com/@madar"')
      expect(content).not.toContain('type: youtube_channel')
      expect(content).not.toContain('youtube_kind:')
    })
  })

  test('falls back to generic webpage capture when fetched YouTube /c/<slug> HTML does not confirm a channel page', async () => {
    await withTempDir(async (tempDir) => {
      stubHtmlFetch(
        '<html><head><title>Madar Consent - YouTube</title><link rel="canonical" href="https://www.youtube.com/c/madar" /></head><body><main><script>var ytInitialData = {"vanityChannelUrl":"https://www.youtube.com/@madar"};</script><p>Consent page.</p></main></body></html>',
      )

      const output = await ingest('https://www.youtube.com/c/madar', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: webpage')
      expect(content).toContain('source_url: "https://www.youtube.com/c/madar"')
      expect(content).not.toContain('type: youtube_channel')
      expect(content).not.toContain('youtube_kind:')
    })
  })

  test('falls back to generic webpage capture when a root YouTube @handle request resolves to a nested channel tab', async () => {
    await withTempDir(async (tempDir) => {
      stubHtmlFetch(
        '<html><head><title>Madar Videos - YouTube</title><link rel="canonical" href="https://www.youtube.com/@madar/videos" /><meta property="og:url" content="https://www.youtube.com/@madar/videos" /><meta property="og:title" content="Madar Videos" /><meta name="description" content="Channel videos tab." /></head><body><main><script>var ytInitialData = {"channelMetadataRenderer":{"title":"Madar Channel","vanityChannelUrl":"https://www.youtube.com/@madar","externalId":"UCmadarRoadmap1234567890"},"header":{"c4TabbedHeaderRenderer":{"channelHandleText":{"simpleText":"@madar"}}}};</script><p>Videos tab content.</p></main></body></html>',
      )

      const output = await ingest('https://www.youtube.com/@madar', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: webpage')
      expect(content).toContain('source_url: "https://www.youtube.com/@madar/videos"')
      expect(content).not.toContain('type: youtube_channel')
      expect(content).not.toContain('youtube_kind:')
    })
  })

  test('falls back to generic webpage capture when a root YouTube /c/<slug> request resolves to a nested channel tab', async () => {
    await withTempDir(async (tempDir) => {
      stubHtmlFetch(
        '<html><head><title>Madar Videos - YouTube</title><link rel="canonical" href="https://www.youtube.com/@madar/videos" /><meta property="og:url" content="https://www.youtube.com/@madar/videos" /><meta property="og:title" content="Madar Videos" /><meta name="description" content="Channel videos tab." /></head><body><main><script>var ytInitialData = {"channelMetadataRenderer":{"title":"Madar Channel","vanityChannelUrl":"https://www.youtube.com/@madar","externalId":"UCmadarRoadmap1234567890"},"header":{"c4TabbedHeaderRenderer":{"channelHandleText":{"simpleText":"@madar"}}}};</script><p>Videos tab content.</p></main></body></html>',
      )

      const output = await ingest('https://www.youtube.com/c/madar', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: webpage')
      expect(content).toContain('source_url: "https://www.youtube.com/@madar/videos"')
      expect(content).not.toContain('type: youtube_channel')
      expect(content).not.toContain('youtube_kind:')
    })
  })

  test('falls back to generic webpage capture when a root YouTube /channel/<id> request resolves to a nested channel tab', async () => {
    await withTempDir(async (tempDir) => {
      stubHtmlFetch(
        '<html><head><title>Madar Videos - YouTube</title><link rel="canonical" href="https://www.youtube.com/@madar/videos" /><meta property="og:url" content="https://www.youtube.com/@madar/videos" /><meta property="og:title" content="Madar Videos" /><meta name="description" content="Channel videos tab." /></head><body><main><script>var ytInitialData = {"channelMetadataRenderer":{"title":"Madar Channel","vanityChannelUrl":"https://www.youtube.com/@madar","externalId":"UCmadarRoadmap1234567890"},"header":{"c4TabbedHeaderRenderer":{"channelHandleText":{"simpleText":"@madar"}}}};</script><p>Videos tab content.</p></main></body></html>',
      )

      const output = await ingest('https://www.youtube.com/channel/UCmadarRoadmap1234567890', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: webpage')
      expect(content).toContain('source_url: "https://www.youtube.com/@madar/videos"')
      expect(content).not.toContain('type: youtube_channel')
      expect(content).not.toContain('youtube_kind:')
    })
  })

  test('falls back to generic webpage capture for YouTube @handle routes with a trailing slash', async () => {
    await withTempDir(async (tempDir) => {
      stubHtmlFetch(readIngestFixture('youtube-channel.html'))

      const output = await ingest('https://www.youtube.com/@madar/', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: webpage')
      expect(content).toContain('source_url: "https://www.youtube.com/@madar"')
      expect(content).not.toContain('type: youtube_channel')
      expect(content).not.toContain('youtube_kind:')
    })
  })

  test('falls back to generic webpage capture for YouTube /c/<slug> routes with a trailing slash', async () => {
    await withTempDir(async (tempDir) => {
      stubHtmlFetch(
        '<html><head><title>Madar Channel - YouTube</title><link rel="canonical" href="https://www.youtube.com/c/madar" /><meta property="og:url" content="https://www.youtube.com/c/madar" /></head><body><main><p>Channel page.</p></main></body></html>',
      )

      const output = await ingest('https://www.youtube.com/c/madar/', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: webpage')
      expect(content).toContain('source_url: "https://www.youtube.com/c/madar"')
      expect(content).not.toContain('type: youtube_channel')
      expect(content).not.toContain('youtube_kind:')
    })
  })

  test('falls back to generic webpage capture for YouTube /channel/<id> routes with a trailing slash', async () => {
    await withTempDir(async (tempDir) => {
      stubHtmlFetch(
        '<html><head><title>Madar Channel - YouTube</title><link rel="canonical" href="https://www.youtube.com/channel/UCmadarRoadmap1234567890" /><meta property="og:url" content="https://www.youtube.com/channel/UCmadarRoadmap1234567890" /></head><body><main><p>Channel page.</p></main></body></html>',
      )

      const output = await ingest('https://www.youtube.com/channel/UCmadarRoadmap1234567890/', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: webpage')
      expect(content).toContain('source_url: "https://www.youtube.com/channel/UCmadarRoadmap1234567890"')
      expect(content).not.toContain('type: youtube_channel')
      expect(content).not.toContain('youtube_kind:')
    })
  })

  test('makes youtube channel fallback behavior explicit when channel metadata fetch fails', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('unavailable', { status: 503, headers: { 'content-type': 'text/plain' } })),
      )

      const output = await ingest('https://www.youtube.com/@madar?feature=share', join(tempDir, 'raw'), {
        contributor: 'madar',
      })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: youtube_channel')
      expect(content).toContain('source_url: "https://www.youtube.com/@madar"')
      expect(content).toContain('title: "YouTube Channel: @madar"')
      expect(content).toContain('author: "@madar"')
      expect(content).toContain('youtube_platform: "youtube"')
      expect(content).toContain('youtube_kind: "channel"')
      expect(content).toContain('youtube_channel_handle: "madar"')
      expect(content).toContain('youtube_capture_status: "fallback"')
      expect(content).toContain('# YouTube Channel: @madar')
      expect(content).toContain('## Channel')
      expect(content).toContain('Channel metadata could not be fetched.')
      expect(content).toContain('## Context')
      expect(content).toContain('- Kind: channel')
      expect(content).toContain('- Handle: @madar')
      expect(content).toContain('- Capture Status: fallback')
      expect(content).toContain('- Note: channel metadata unavailable; preserved canonical channel URL and derived handle metadata only.')
      expect(content).toContain('## Links')
      expect(content).toContain('[Open Channel](https://www.youtube.com/@madar)')
      expect(content).not.toContain('feature=share')
      expect(content).not.toContain('provenance:')
    })
  })

  test('makes youtube custom-channel fallback behavior explicit when channel metadata fetch fails', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('unavailable', { status: 503, headers: { 'content-type': 'text/plain' } })),
      )

      const output = await ingest('https://www.youtube.com/c/madar?feature=share', join(tempDir, 'raw'), {
        contributor: 'madar',
      })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: youtube_channel')
      expect(content).toContain('source_url: "https://www.youtube.com/c/madar"')
      expect(content).toContain('title: "YouTube Channel: /c/madar"')
      expect(content).toContain('author: "unknown"')
      expect(content).toContain('youtube_platform: "youtube"')
      expect(content).toContain('youtube_kind: "channel"')
      expect(content).not.toContain('youtube_channel_handle:')
      expect(content).toContain('youtube_channel_custom_slug: "madar"')
      expect(content).toContain('youtube_capture_status: "fallback"')
      expect(content).toContain('# YouTube Channel: /c/madar')
      expect(content).toContain('## Channel')
      expect(content).toContain('Channel metadata could not be fetched.')
      expect(content).toContain('## Context')
      expect(content).toContain('- Custom URL: /c/madar')
      expect(content).toContain('- Capture Status: fallback')
      expect(content).toContain('- Note: channel metadata unavailable; preserved canonical channel URL and derived custom-channel metadata only.')
      expect(content).toContain('## Links')
      expect(content).toContain('[Open Channel](https://www.youtube.com/c/madar)')
      expect(content).not.toContain('feature=share')
      expect(content).not.toContain('provenance:')
    })
  })

  test('makes youtube channel-id fallback behavior explicit when channel metadata fetch fails', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('unavailable', { status: 503, headers: { 'content-type': 'text/plain' } })),
      )

      const output = await ingest('https://www.youtube.com/channel/UCmadarRoadmap1234567890?feature=share', join(tempDir, 'raw'), {
        contributor: 'madar',
      })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: youtube_channel')
      expect(content).toContain('source_url: "https://www.youtube.com/channel/UCmadarRoadmap1234567890"')
      expect(content).toContain('title: "YouTube Channel: UCmadarRoadmap1234567890"')
      expect(content).toContain('author: "unknown"')
      expect(content).toContain('youtube_platform: "youtube"')
      expect(content).toContain('youtube_kind: "channel"')
      expect(content).not.toContain('youtube_channel_handle:')
      expect(content).toContain('youtube_channel_id: "UCmadarRoadmap1234567890"')
      expect(content).toContain('youtube_capture_status: "fallback"')
      expect(content).toContain('# YouTube Channel: UCmadarRoadmap1234567890')
      expect(content).toContain('## Channel')
      expect(content).toContain('Channel metadata could not be fetched.')
      expect(content).toContain('## Context')
      expect(content).toContain('- Channel ID: UCmadarRoadmap1234567890')
      expect(content).toContain('- Capture Status: fallback')
      expect(content).toContain('- Note: channel metadata unavailable; preserved canonical channel URL and derived channel-id metadata only.')
      expect(content).toContain('## Links')
      expect(content).toContain('[Open Channel](https://www.youtube.com/channel/UCmadarRoadmap1234567890)')
      expect(content).not.toContain('feature=share')
      expect(content).not.toContain('provenance:')
    })
  })

  test('makes youtube fallback behavior explicit when oEmbed fetch fails', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('unavailable', { status: 503, headers: { 'content-type': 'text/plain' } })),
      )

      const output = await ingest('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLmadar', join(tempDir, 'raw'), {
        contributor: 'madar',
      })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: youtube_video')
      expect(content).toContain('source_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"')
      expect(content).toContain('title: "YouTube Video: dQw4w9WgXcQ"')
      expect(content).toContain('author: "unknown"')
      expect(content).toContain('video_platform: "youtube"')
      expect(content).toContain('video_id: "dQw4w9WgXcQ"')
      expect(content).toContain('video_capture_status: "fallback"')
      expect(content).toContain('video_embed_url: "https://www.youtube.com/embed/dQw4w9WgXcQ"')
      expect(content).toContain('# YouTube Video: dQw4w9WgXcQ')
      expect(content).toContain('## Video')
      expect(content).toContain('Video metadata could not be fetched.')
      expect(content).toContain('## Context')
      expect(content).toContain('- Capture Status: fallback')
      expect(content).toContain('- Note: oEmbed unavailable; preserved canonical video URL and derived video metadata only.')
      expect(content).toContain('## Links')
      expect(content).toContain('[Watch on YouTube](https://www.youtube.com/watch?v=dQw4w9WgXcQ)')
      expect(content).toContain('[Embed Player](https://www.youtube.com/embed/dQw4w9WgXcQ)')
      expect(content).not.toContain('provenance:')
    })
  })

  test('makes youtube playlist fallback behavior explicit when playlist metadata fetch fails', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('unavailable', { status: 503, headers: { 'content-type': 'text/plain' } })),
      )

      const output = await ingest('https://www.youtube.com/playlist?list=PLmadarRoadmap123&feature=share', join(tempDir, 'raw'), {
        contributor: 'madar',
      })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: youtube_playlist')
      expect(content).toContain('source_url: "https://www.youtube.com/playlist?list=PLmadarRoadmap123"')
      expect(content).toContain('title: "YouTube Playlist: PLmadarRoadmap123"')
      expect(content).toContain('author: "unknown"')
      expect(content).toContain('youtube_platform: "youtube"')
      expect(content).toContain('youtube_kind: "playlist"')
      expect(content).toContain('youtube_playlist_id: "PLmadarRoadmap123"')
      expect(content).toContain('youtube_capture_status: "fallback"')
      expect(content).toContain('# YouTube Playlist: PLmadarRoadmap123')
      expect(content).toContain('## Playlist')
      expect(content).toContain('Playlist metadata could not be fetched.')
      expect(content).toContain('## Context')
      expect(content).toContain('- Kind: playlist')
      expect(content).toContain('- Capture Status: fallback')
      expect(content).toContain('- Note: playlist metadata unavailable; preserved canonical playlist URL and derived playlist metadata only.')
      expect(content).toContain('## Links')
      expect(content).toContain('[Open Playlist](https://www.youtube.com/playlist?list=PLmadarRoadmap123)')
      expect(content).not.toContain('feature=share')
      expect(content).not.toContain('provenance:')
    })
  })

  test('canonicalizes youtube live urls before fallback handling', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('unavailable', { status: 503, headers: { 'content-type': 'text/plain' } })),
      )

      const output = await ingest('https://www.youtube.com/live/dQw4w9WgXcQ?feature=share', join(tempDir, 'raw'), {
        contributor: 'madar',
      })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: youtube_video')
      expect(content).toContain('source_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"')
      expect(content).toContain('title: "YouTube Video: dQw4w9WgXcQ"')
      expect(content).toContain('video_platform: "youtube"')
      expect(content).toContain('video_id: "dQw4w9WgXcQ"')
      expect(content).toContain('video_capture_status: "fallback"')
      expect(content).toContain('[Watch on YouTube](https://www.youtube.com/watch?v=dQw4w9WgXcQ)')
      expect(content).toContain('[Embed Player](https://www.youtube.com/embed/dQw4w9WgXcQ)')
      expect(content).not.toContain('/live/dQw4w9WgXcQ')
      expect(content).not.toContain('provenance:')
    })
  })

  test('uses stable per-video filenames for structured YouTube ingest', async () => {
    await withTempDir(async (tempDir) => {
      const responses = [
        {
          title: 'Madar Demo Walkthrough',
          author_name: 'Madar Channel',
          provider_name: 'YouTube',
        },
        {
          title: 'Madar Roadmap Update',
          author_name: 'Madar Channel',
          provider_name: 'YouTube',
        },
      ]

      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          if (requestUrl.includes('/oembed?url=')) {
            return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { 'content-type': 'application/json' } })
          }

          return new Response(readIngestFixture('youtube-video-no-chapters.html'), {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        }),
      )

      const firstOutput = await ingest('https://youtu.be/dQw4w9WgXcQ', join(tempDir, 'raw'))
      const secondOutput = await ingest('https://www.youtube.com/watch?v=9bZkp7q19f0', join(tempDir, 'raw'))

      expect(basename(firstOutput)).toBe('youtube_dQw4w9WgXcQ.md')
      expect(basename(secondOutput)).toBe('youtube_9bZkp7q19f0.md')
      expect(firstOutput).not.toBe(secondOutput)
    })
  })

  test('saves tweets as structured social markdown without nested provenance', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          expect(requestUrl).toContain('publish.twitter.com/oembed?url=')
          return new Response(JSON.stringify({ html: '<blockquote>Graph edges everywhere</blockquote>', author_name: 'Madar Bot' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }),
      )

      const output = await ingest('https://x.com/madar/status/1', join(tempDir, 'raw'), { contributor: 'madar' })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: tweet')
      expect(content).toContain('source_url: "https://x.com/madar/status/1"')
      expect(content).toContain('title: "Tweet by @madar"')
      expect(content).toContain('author: "Madar Bot"')
      expect(content).toContain('contributor: "madar"')
      expect(content).toContain('social_platform: "x"')
      expect(content).toContain('social_author_handle: "madar"')
      expect(content).toContain('social_post_id: "1"')
      expect(content).toContain('social_capture_status: "oembed"')
      expect(content).toContain('# Tweet by @madar')
      expect(content).toContain('## Post')
      expect(content).toContain('Graph edges everywhere')
      expect(content).toContain('## Context')
      expect(content).toContain('- Platform: x')
      expect(content).toContain('- Handle: @madar')
      expect(content).toContain('- Post ID: 1')
      expect(content).toContain('- Capture Status: oembed')
      expect(content).not.toContain('provenance:')
    })
  })

  test('canonicalizes tweet media alias urls to the base structured post url', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          expect(requestUrl).toContain('publish.twitter.com/oembed?url=')
          expect(decodeURIComponent(requestUrl)).toContain('https://twitter.com/madar/status/4')
          expect(decodeURIComponent(requestUrl)).not.toContain('/photo/1')
          return new Response(JSON.stringify({ html: '<blockquote>Canonical media alias capture</blockquote>', author_name: 'Madar Bot' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }),
      )

      const output = await ingest('https://x.com/madar/status/4/photo/1?utm_source=share', join(tempDir, 'raw'), {
        contributor: 'madar',
      })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: tweet')
      expect(content).toContain('source_url: "https://x.com/madar/status/4"')
      expect(content).toContain('title: "Tweet by @madar"')
      expect(content).toContain('author: "Madar Bot"')
      expect(content).toContain('social_platform: "x"')
      expect(content).toContain('social_author_handle: "madar"')
      expect(content).toContain('social_post_id: "4"')
      expect(content).toContain('Canonical media alias capture')
      expect(content).not.toContain('/photo/1')
      expect(content).not.toContain('provenance:')
    })
  })

  test('makes tweet fallback behavior explicit when oEmbed fetch fails', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('rate limited', { status: 429, headers: { 'content-type': 'text/plain' } })),
      )

      const output = await ingest('https://x.com/madar/status/2', join(tempDir, 'raw'), { contributor: 'madar' })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: tweet')
      expect(content).toContain('source_url: "https://x.com/madar/status/2"')
      expect(content).toContain('title: "Tweet by @madar"')
      expect(content).toContain('author: "madar"')
      expect(content).toContain('social_author_handle: "madar"')
      expect(content).toContain('social_post_id: "2"')
      expect(content).toContain('social_capture_status: "fallback"')
      expect(content).toContain('## Post')
      expect(content).toContain('Tweet content could not be fetched.')
      expect(content).toContain('## Context')
      expect(content).toContain('- Capture Status: fallback')
      expect(content).toContain('- Note: oEmbed unavailable; preserved source URL and derived social metadata only.')
      expect(content).not.toContain('provenance:')
    })
  })

  test('canonicalizes handle-less tweet media aliases before fallback handling', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('rate limited', { status: 429, headers: { 'content-type': 'text/plain' } })),
      )

      const output = await ingest('https://twitter.com/i/web/status/5/video/1?utm_source=share', join(tempDir, 'raw'), {
        contributor: 'madar',
      })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: tweet')
      expect(content).toContain('source_url: "https://twitter.com/i/web/status/5"')
      expect(content).toContain('title: "Tweet"')
      expect(content).toContain('author: "unknown"')
      expect(content).toContain('social_platform: "twitter"')
      expect(content).toContain('social_post_id: "5"')
      expect(content).toContain('social_capture_status: "fallback"')
      expect(content).toContain('Tweet content could not be fetched.')
      expect(content).toContain('- Note: oEmbed unavailable; preserved source URL and derived social metadata only.')
      expect(content).not.toContain('/video/1')
      expect(content).not.toContain('provenance:')
    })
  })

  test('uses a neutral title for handle-less status urls instead of inventing a handle', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          expect(requestUrl).toContain('publish.twitter.com/oembed?url=')
          expect(decodeURIComponent(requestUrl)).toContain('https://twitter.com/i/web/status/3')
          return new Response(JSON.stringify({ html: '<blockquote>Handle-less status capture</blockquote>', author_name: 'Madar Bot' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }),
      )

      const output = await ingest('https://twitter.com/i/web/status/3', join(tempDir, 'raw'), { contributor: 'madar' })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: tweet')
      expect(content).toContain('source_url: "https://twitter.com/i/web/status/3"')
      expect(content).toContain('title: "Tweet by Madar Bot"')
      expect(content).toContain('author: "Madar Bot"')
      expect(content).toContain('social_platform: "twitter"')
      expect(content).toContain('social_post_id: "3"')
      expect(content).not.toContain('social_author_handle:')
      expect(content).toContain('# Tweet by Madar Bot')
      expect(content).toContain('Handle-less status capture')
      expect(content).not.toContain('@Madar Bot')
      expect(content).not.toContain('- Handle:')
      expect(content).not.toContain('provenance:')
    })
  })

  test('saves arxiv papers as flat annotated markdown without nested provenance', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          expect(requestUrl).toBe('https://export.arxiv.org/abs/1706.03762')
          return new Response(
            [
              '<html>',
              '<h1 class="title mathjax">Attention Is All You Need</h1>',
              '<div class="authors">Ashish Vaswani</div>',
              '<blockquote class="abstract mathjax">Sequence modeling with attention.</blockquote>',
              '</html>',
            ].join(''),
            { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
          )
        }),
      )

      const output = await ingest('https://arxiv.org/abs/1706.03762', join(tempDir, 'raw'), { contributor: 'madar' })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: paper')
      expect(content).toContain('source_url: "https://arxiv.org/abs/1706.03762"')
      expect(content).toContain('arxiv_id: "1706.03762"')
      expect(content).toContain('title: "Attention Is All You Need"')
      expect(content).toContain('paper_authors: "Ashish Vaswani"')
      expect(content).toContain('contributor: "madar"')
      expect(content).not.toContain('provenance:')
    })
  })

  test('downloads binary assets directly and persists hidden ingest metadata sidecars', async () => {
    await withTempDir(async (tempDir) => {
      const payload = Uint8Array.from([1, 2, 3, 4])
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(payload, { status: 200 })),
      )

      const cases = [
        {
          url: 'https://example.com/file.pdf',
          expectedSuffix: '.pdf',
        },
        {
          url: 'https://example.com/diagram.png',
          expectedSuffix: '.png',
        },
        {
          url: 'https://example.com/audio/episode.mp3?download=1',
          expectedSuffix: '.mp3',
        },
        {
          url: 'https://example.com/video/demo.mp4?download=1',
          expectedSuffix: '.mp4',
        },
      ]

      for (const testCase of cases) {
        const output = await ingest(testCase.url, join(tempDir, 'raw'), { contributor: 'madar' })
        const sidecarPath = binaryIngestSidecarPath(output)
        const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) as Record<string, unknown>

        expect(output.endsWith(testCase.expectedSuffix)).toBe(true)
        expect(readFileSync(output)).toEqual(Buffer.from(payload))
        expect(existsSync(sidecarPath)).toBe(true)
        expect(sidecar).toEqual(
          expect.objectContaining({
            source_url: testCase.url,
            captured_at: expect.any(String),
            contributor: 'madar',
          }),
        )
        expect(typeof sidecar.captured_at).toBe('string')
      }
    })
  })

  test('falls back to binary ingest when a webpage-typed url responds with direct audio bytes', async () => {
    await withTempDir(async (tempDir) => {
      const payload = Uint8Array.from([9, 8, 7, 6])
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          expect(requestUrl).toBe('https://example.com/download/audio')
          return new Response(payload, {
            status: 200,
            headers: { 'content-type': 'audio/mpeg' },
          })
        }),
      )

      const output = await ingest('https://example.com/download/audio', join(tempDir, 'raw'), { contributor: 'madar' })
      const sidecarPath = binaryIngestSidecarPath(output)
      const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) as Record<string, unknown>

      expect(output.endsWith('.mp3')).toBe(true)
      expect(readFileSync(output)).toEqual(Buffer.from(payload))
      expect(existsSync(sidecarPath)).toBe(true)
      expect(sidecar).toEqual(
        expect.objectContaining({
          ingest_url_type: 'audio',
          source_url: 'https://example.com/download/audio',
          captured_at: expect.any(String),
          contributor: 'madar',
        }),
      )
    })
  })

  test('canonicalizes redirected binary ingests to the final asset url and suffix', async () => {
    await withTempDir(async (tempDir) => {
      const payload = Uint8Array.from([5, 6, 7, 8])
      const requestUrls: string[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          requestUrls.push(requestUrl)
          if (requestUrl === 'https://example.com/video/download.mp4') {
            return new Response(null, {
              status: 302,
              headers: { location: 'https://cdn.example.com/assets/demo.webm' },
            })
          }

          expect(requestUrl).toBe('https://cdn.example.com/assets/demo.webm')
          return new Response(payload, {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
          })
        }),
      )

      const output = await ingest('https://example.com/video/download.mp4', join(tempDir, 'raw'), { contributor: 'madar' })
      const sidecarPath = binaryIngestSidecarPath(output)
      const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) as Record<string, unknown>

      expect(requestUrls).toEqual(['https://example.com/video/download.mp4', 'https://cdn.example.com/assets/demo.webm'])
      expect(output.endsWith('.webm')).toBe(true)
      expect(readFileSync(output)).toEqual(Buffer.from(payload))
      expect(existsSync(sidecarPath)).toBe(true)
      expect(sidecar).toEqual(
        expect.objectContaining({
          source_url: 'https://cdn.example.com/assets/demo.webm',
          captured_at: expect.any(String),
          contributor: 'madar',
        }),
      )
    })
  })

  test('preserves webpage ingest when a redirected final url looks like media but the response is still html', async () => {
    await withTempDir(async (tempDir) => {
      const requestUrls: string[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          requestUrls.push(requestUrl)
          if (requestUrl === 'https://example.com/download/landing') {
            return new Response(null, {
              status: 302,
              headers: { location: 'https://cdn.example.com/assets/episode.mp3' },
            })
          }

          expect(requestUrl).toBe('https://cdn.example.com/assets/episode.mp3')
          return new Response('<html><head><title>Episode landing page</title></head><body><main><h1>Episode landing page</h1></main></body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        }),
      )

      const output = await ingest('https://example.com/download/landing', join(tempDir, 'raw'), { contributor: 'madar' })
      const content = readFileSync(output, 'utf8')

      expect(requestUrls).toEqual(['https://example.com/download/landing', 'https://cdn.example.com/assets/episode.mp3'])
      expect(output.endsWith('.md')).toBe(true)
      expect(existsSync(binaryIngestSidecarPath(output))).toBe(false)
      expect(content).toContain('type: webpage')
      expect(content).toContain('Episode landing page')
    })
  })

  test('preserves the handler-decided binary suffix when a binary response content type disagrees with the final url extension', async () => {
    await withTempDir(async (tempDir) => {
      const payload = Uint8Array.from([4, 3, 2, 1])
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          if (requestUrl === 'https://example.com/download/audio') {
            return new Response(null, {
              status: 302,
              headers: { location: 'https://cdn.example.com/assets/episode.mp4' },
            })
          }

          expect(requestUrl).toBe('https://cdn.example.com/assets/episode.mp4')
          return new Response(payload, {
            status: 200,
            headers: { 'content-type': 'audio/mpeg' },
          })
        }),
      )

      const output = await ingest('https://example.com/download/audio', join(tempDir, 'raw'), { contributor: 'madar' })
      const sidecarPath = binaryIngestSidecarPath(output)
      const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) as Record<string, unknown>

      expect(output.endsWith('.mp3')).toBe(true)
      expect(readFileSync(output)).toEqual(Buffer.from(payload))
      expect(sidecar).toEqual(
        expect.objectContaining({
          source_url: 'https://cdn.example.com/assets/episode.mp4',
          contributor: 'madar',
        }),
      )
    })
  })

  test('uses the final redirected html url as the webpage source and relative-link base when no canonical tag is present', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          if (requestUrl === 'https://example.com/short') {
            return new Response(null, {
              status: 302,
              headers: { location: 'https://example.com/articles/episode' },
            })
          }

          expect(requestUrl).toBe('https://example.com/articles/episode')
          return new Response(
            '<html><head><title>Episode Notes</title><meta name="description" content="Landing page after redirect." /></head><body><main><p>Read <a href="notes">notes</a>.</p></main></body></html>',
            {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            },
          )
        }),
      )

      const output = await ingest('https://example.com/short', join(tempDir, 'raw'), { contributor: 'madar' })
      const content = readFileSync(output, 'utf8')

      expect(output.endsWith('.md')).toBe(true)
      expect(content).toContain('source_url: "https://example.com/articles/episode"')
      expect(content).toContain('[notes](https://example.com/articles/notes)')
    })
  })

  test('preserves webpage ingest when a direct media url returns html instead of binary bytes', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          expect(requestUrl).toBe('https://example.com/audio/episode.mp3')
          return new Response('<html><head><title>Episode Page</title></head><body><main><h1>Episode Page</h1></main></body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        }),
      )

      const output = await ingest('https://example.com/audio/episode.mp3', join(tempDir, 'raw'), { contributor: 'madar' })
      const content = readFileSync(output, 'utf8')

      expect(output.endsWith('.md')).toBe(true)
      expect(existsSync(binaryIngestSidecarPath(output))).toBe(false)
      expect(content).toContain('type: webpage')
      expect(content).toContain('Episode Page')
    })
  })

  test('resolves relative canonical urls when a direct media url falls back to webpage ingest', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          expect(requestUrl).toBe('https://example.com/audio/episode.mp3')
          return new Response(
            '<html><head><title>Episode Page</title><link rel="canonical" href="/episodes/landing" /></head><body><main><p>Read <a href="notes">notes</a>.</p></main></body></html>',
            {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            },
          )
        }),
      )

      const output = await ingest('https://example.com/audio/episode.mp3', join(tempDir, 'raw'), { contributor: 'madar' })
      const content = readFileSync(output, 'utf8')

      expect(output.endsWith('.md')).toBe(true)
      expect(existsSync(binaryIngestSidecarPath(output))).toBe(false)
      expect(content).toContain('source_url: "https://example.com/episodes/landing"')
      expect(content).toContain('[notes](https://example.com/episodes/notes)')
    })
  })

  test('rejects disallowed urls', async () => {
    await withTempDir(async (tempDir) => {
      await expect(ingest('file:///etc/passwd', join(tempDir, 'raw'))).rejects.toThrow(/file/i)
    })
  })
})
