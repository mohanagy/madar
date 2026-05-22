import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { getUpdateNotification } from '../../src/shared/update-notifier.js'

describe('update notifier', () => {
  it('returns a notice and caches the latest version when a newer release exists', async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), 'madar-update-notifier-'))

    try {
      const notice = await getUpdateNotification({
        packageName: '@mohammednagy/madar',
        currentVersion: '0.22.8',
        cacheRoot,
        stdoutIsTTY: true,
        env: {},
        now: () => 1_700_000_000_000,
        fetchText: async () => JSON.stringify({ version: '0.22.9' }),
      })

      expect(notice).toContain('0.22.8')
      expect(notice).toContain('0.22.9')
      expect(notice).toContain('npm i -g @mohammednagy/madar@latest')

      const cacheFile = join(cacheRoot, 'madar', 'update-check.json')
      expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).toEqual({
        checked_at: 1_700_000_000_000,
        latest_version: '0.22.9',
        notified_at: 1_700_000_000_000,
      })
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true })
    }
  })

  it('uses a fresh cache instead of refetching the registry or repeating the banner', async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), 'madar-update-notifier-'))
    let fetchCalls = 0

    try {
      const firstNotice = await getUpdateNotification({
        packageName: '@mohammednagy/madar',
        currentVersion: '0.22.8',
        cacheRoot,
        stdoutIsTTY: true,
        env: {},
        now: () => 1_700_000_000_000,
        fetchText: async () => {
          fetchCalls += 1
          return JSON.stringify({ version: '0.22.9' })
        },
      })

      const secondNotice = await getUpdateNotification({
        packageName: '@mohammednagy/madar',
        currentVersion: '0.22.8',
        cacheRoot,
        stdoutIsTTY: true,
        env: {},
        now: () => 1_700_000_000_000 + 60_000,
        fetchText: async () => {
          fetchCalls += 1
          return JSON.stringify({ version: '9.9.9' })
        },
      })

      expect(firstNotice).toContain('0.22.9')
      expect(secondNotice).toBeNull()
      expect(fetchCalls).toBe(1)
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true })
    }
  })

  it('preserves the refreshed checked_at timestamp when a stale cache is re-notified', async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), 'madar-update-notifier-'))
    const cacheFile = join(cacheRoot, 'madar', 'update-check.json')

    try {
      mkdirSync(join(cacheRoot, 'madar'), { recursive: true })
      writeFileSync(cacheFile, JSON.stringify({
        checked_at: 1_700_000_000_000,
        latest_version: '0.22.9',
        notified_at: 1_700_000_000_000,
      }))

      const notice = await getUpdateNotification({
        packageName: '@mohammednagy/madar',
        currentVersion: '0.22.8',
        cacheRoot,
        stdoutIsTTY: true,
        env: {},
        now: () => 1_700_000_000_000 + 2 * 24 * 60 * 60 * 1000,
        fetchText: async () => JSON.stringify({ version: '0.22.9' }),
      })

      expect(notice).toContain('0.22.9')
      expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).toEqual({
        checked_at: 1_700_000_000_000 + 2 * 24 * 60 * 60 * 1000,
        latest_version: '0.22.9',
        notified_at: 1_700_000_000_000 + 2 * 24 * 60 * 60 * 1000,
      })
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true })
    }
  })

  it('writes a backoff cache entry when the registry refresh fails', async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), 'madar-update-notifier-'))
    const cacheFile = join(cacheRoot, 'madar', 'update-check.json')
    let fetchCalls = 0

    try {
      mkdirSync(join(cacheRoot, 'madar'), { recursive: true })
      writeFileSync(cacheFile, JSON.stringify({
        checked_at: 1_700_000_000_000,
        latest_version: '0.22.9',
        notified_at: 1_700_000_000_000,
      }))

      const notice = await getUpdateNotification({
        packageName: '@mohammednagy/madar',
        currentVersion: '0.22.8',
        cacheRoot,
        stdoutIsTTY: true,
        env: {},
        now: () => 1_700_000_000_000 + 2 * 24 * 60 * 60 * 1000,
        fetchText: async () => {
          fetchCalls += 1
          throw new Error('offline')
        },
      })

      const secondNotice = await getUpdateNotification({
        packageName: '@mohammednagy/madar',
        currentVersion: '0.22.8',
        cacheRoot,
        stdoutIsTTY: true,
        env: {},
        now: () => 1_700_000_000_000 + 2 * 24 * 60 * 60 * 1000 + 1_000,
        fetchText: async () => {
          fetchCalls += 1
          return JSON.stringify({ version: '9.9.9' })
        },
      })

      expect(notice).toBeNull()
      expect(secondNotice).toBeNull()
      expect(fetchCalls).toBe(1)
      expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).toEqual({
        checked_at: 1_700_000_000_000 + 2 * 24 * 60 * 60 * 1000,
        latest_version: '0.22.9',
        notified_at: 1_700_000_000_000,
      })
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true })
    }
  })

  it('skips checks when disabled or non-interactive', async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), 'madar-update-notifier-'))
    let fetchCalls = 0

    try {
      await expect(getUpdateNotification({
        packageName: '@mohammednagy/madar',
        currentVersion: '0.22.8',
        cacheRoot,
        stdoutIsTTY: false,
        env: {},
        fetchText: async () => {
          fetchCalls += 1
          return JSON.stringify({ version: '0.22.9' })
        },
      })).resolves.toBeNull()

      await expect(getUpdateNotification({
        packageName: '@mohammednagy/madar',
        currentVersion: '0.22.8',
        cacheRoot,
        stdoutIsTTY: true,
        env: { MADAR_DISABLE_UPDATE_NOTIFIER: '1' },
        fetchText: async () => {
          fetchCalls += 1
          return JSON.stringify({ version: '0.22.9' })
        },
      })).resolves.toBeNull()

      expect(fetchCalls).toBe(0)
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true })
    }
  })
})
