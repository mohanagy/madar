import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { describe, expect, it } from 'vitest'

import {
  acquireRefreshLeaseWithoutBlocking,
  tryAcquireRefreshLease,
} from '../../src/infrastructure/refresh-lease.js'

function withTempDir(callback: (tempDir: string) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'madar-refresh-lease-'))
  try {
    callback(tempDir)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

describe('refresh lease coordination', () => {
  it('reclaims a young lease whose recorded owner is dead', () => {
    withTempDir((tempDir) => {
      const outputDir = join(tempDir, 'out')
      const lockPath = join(outputDir, '.madar-refresh.lock')
      mkdirSync(outputDir, { recursive: true })
      writeFileSync(lockPath, `999999999 abandoned ${new Date().toISOString()}\n`, 'utf8')

      const release = tryAcquireRefreshLease(outputDir, {
        isProcessAlive: () => false,
      })

      expect(release).toBeTypeOf('function')
      release?.()
      expect(existsSync(lockPath)).toBe(false)
    })
  })

  it('does not reclaim an old lease while its recorded PID is alive', () => {
    withTempDir((tempDir) => {
      const outputDir = join(tempDir, 'out')
      const lockPath = join(outputDir, '.madar-refresh.lock')
      mkdirSync(outputDir, { recursive: true })
      const contents = `12345 active-owner ${new Date().toISOString()}\n`
      writeFileSync(lockPath, contents, 'utf8')
      const old = new Date(Date.now() - (2 * 60 * 60 * 1000))
      utimesSync(lockPath, old, old)

      expect(tryAcquireRefreshLease(outputDir, { isProcessAlive: () => true })).toBeNull()
      expect(readFileSync(lockPath, 'utf8')).toBe(contents)
    })
  })

  it('gives an in-progress owner time to finish writing lease metadata', () => {
    withTempDir((tempDir) => {
      const outputDir = join(tempDir, 'out')
      const lockPath = join(outputDir, '.madar-refresh.lock')
      mkdirSync(outputDir, { recursive: true })
      writeFileSync(lockPath, '', 'utf8')

      expect(tryAcquireRefreshLease(outputDir, { isProcessAlive: () => false })).toBeNull()
      expect(existsSync(lockPath)).toBe(true)
    })
  })

  it('recovers incomplete lease metadata after the write grace period', () => {
    withTempDir((tempDir) => {
      const outputDir = join(tempDir, 'out')
      const lockPath = join(outputDir, '.madar-refresh.lock')
      mkdirSync(outputDir, { recursive: true })
      writeFileSync(lockPath, '', 'utf8')
      const old = new Date(Date.now() - 10_000)
      utimesSync(lockPath, old, old)

      const release = tryAcquireRefreshLease(outputDir, { isProcessAlive: () => false })
      expect(release).toBeTypeOf('function')
      release?.()
      expect(existsSync(lockPath)).toBe(false)
    })
  })

  it('waits through live contention and acquires after the owner releases', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'madar-refresh-lease-'))
    const outputDir = join(tempDir, 'out')
    const ownerRelease = tryAcquireRefreshLease(outputDir)
    expect(ownerRelease).toBeTypeOf('function')

    let settled = false
    const waiter = acquireRefreshLeaseWithoutBlocking(outputDir, {
      retryMinMs: 5,
      retryMaxMs: 20,
    }).then((release) => {
      settled = true
      return release
    })

    try {
      await delay(75)
      expect(settled).toBe(false)
      ownerRelease?.()

      const waiterRelease = await waiter
      expect(waiterRelease).toBeTypeOf('function')
      waiterRelease?.()
      expect(existsSync(join(outputDir, '.madar-refresh.lock'))).toBe(false)
    } finally {
      ownerRelease?.()
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('stops waiting promptly when the watcher is aborted', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'madar-refresh-lease-'))
    const outputDir = join(tempDir, 'out')
    const ownerRelease = tryAcquireRefreshLease(outputDir)
    const controller = new AbortController()

    try {
      const waiter = acquireRefreshLeaseWithoutBlocking(outputDir, {
        signal: controller.signal,
        retryMinMs: 5,
        retryMaxMs: 20,
      })
      controller.abort()
      await expect(waiter).resolves.toBeNull()
    } finally {
      ownerRelease?.()
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
