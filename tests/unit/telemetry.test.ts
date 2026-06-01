import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import {
  disableTelemetry,
  enableTelemetry,
  formatTelemetryStatus,
  getTelemetryStatus,
  recordTelemetryEvent,
  repoSizeBucketFromFileCount,
} from '../../src/shared/telemetry.js'

describe('telemetry', () => {
  it('is disabled by default until explicitly enabled', () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'madar-telemetry-config-'))
    const cacheRoot = mkdtempSync(join(tmpdir(), 'madar-telemetry-cache-'))

    try {
      const status = getTelemetryStatus({
        configRoot,
        cacheRoot,
        env: {},
      })

      expect(status.enabled).toBe(false)
      expect(formatTelemetryStatus(status)).toContain('Telemetry: disabled')
      expect(formatTelemetryStatus(status)).toContain('disabled by default')
    } finally {
      rmSync(configRoot, { recursive: true, force: true })
      rmSync(cacheRoot, { recursive: true, force: true })
    }
  })

  it('records bounded source-safe events after explicit enable', () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'madar-telemetry-config-'))
    const cacheRoot = mkdtempSync(join(tmpdir(), 'madar-telemetry-cache-'))

    try {
      enableTelemetry({
        configRoot,
        cacheRoot,
        env: {},
        now: () => 1_700_000_000_000,
      })

      expect(recordTelemetryEvent({
        event: 'generate_success',
        version: '0.27.4',
        os: 'darwin',
        repoSizeBucket: repoSizeBucketFromFileCount(240),
      }, {
        configRoot,
        cacheRoot,
        env: {},
        now: () => 1_700_000_010_000,
        maxEvents: 2,
      })).toBe(true)

      expect(recordTelemetryEvent({
        event: 'pack_success',
        version: '0.27.4',
        os: 'darwin',
        repoSizeBucket: repoSizeBucketFromFileCount(12),
      }, {
        configRoot,
        cacheRoot,
        env: {},
        now: () => 1_700_000_020_000,
        maxEvents: 2,
      })).toBe(true)

      expect(recordTelemetryEvent({
        event: 'compare_success',
        version: '0.27.4',
        os: 'darwin',
        repoSizeBucket: repoSizeBucketFromFileCount(2_100),
      }, {
        configRoot,
        cacheRoot,
        env: {},
        now: () => 1_700_000_030_000,
        maxEvents: 2,
      })).toBe(true)

      const spoolFile = join(cacheRoot, 'madar', 'telemetry-events.json')
      expect(JSON.parse(readFileSync(spoolFile, 'utf8'))).toEqual({
        schema_version: 1,
        events: [
          expect.objectContaining({
            event: 'pack_success',
            version: '0.27.4',
            os: 'darwin',
            repo_size_bucket: '1-24',
          }),
          expect.objectContaining({
            event: 'compare_success',
            version: '0.27.4',
            os: 'darwin',
            repo_size_bucket: '1000+',
          }),
        ],
      })
    } finally {
      rmSync(configRoot, { recursive: true, force: true })
      rmSync(cacheRoot, { recursive: true, force: true })
    }
  })

  it('honors disable controls even when config is enabled', () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'madar-telemetry-config-'))
    const cacheRoot = mkdtempSync(join(tmpdir(), 'madar-telemetry-cache-'))

    try {
      enableTelemetry({
        configRoot,
        cacheRoot,
        env: {},
      })

      const status = getTelemetryStatus({
        configRoot,
        cacheRoot,
        env: { MADAR_DISABLE_TELEMETRY: '1' },
      })

      expect(status.enabled).toBe(false)
      expect(formatTelemetryStatus(status)).toContain('MADAR_DISABLE_TELEMETRY=1')
      expect(recordTelemetryEvent({
        event: 'generate_success',
        version: '0.27.4',
        os: 'darwin',
        repoSizeBucket: '100-499',
      }, {
        configRoot,
        cacheRoot,
        env: { MADAR_DISABLE_TELEMETRY: '1' },
      })).toBe(false)

      disableTelemetry({
        configRoot,
        cacheRoot,
        env: {},
      })
    } finally {
      rmSync(configRoot, { recursive: true, force: true })
      rmSync(cacheRoot, { recursive: true, force: true })
    }
  })

  it('reports persisted preference changes even when env overrides the current runtime state', () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'madar-telemetry-config-'))
    const cacheRoot = mkdtempSync(join(tmpdir(), 'madar-telemetry-cache-'))

    try {
      const enabled = enableTelemetry({
        configRoot,
        cacheRoot,
        env: { MADAR_DISABLE_TELEMETRY: '1' },
        now: () => 1_700_000_000_000,
      })
      const disabled = disableTelemetry({
        configRoot,
        cacheRoot,
        env: { MADAR_ENABLE_TELEMETRY: '1' },
        now: () => 1_700_000_010_000,
      })

      expect(enabled).toContain('Telemetry preference: enabled')
      expect(enabled).toContain('Current runtime override: disabled by MADAR_DISABLE_TELEMETRY=1')
      expect(disabled).toContain('Telemetry preference: disabled')
      expect(disabled).toContain('Current runtime override: enabled by MADAR_ENABLE_TELEMETRY=1')
    } finally {
      rmSync(configRoot, { recursive: true, force: true })
      rmSync(cacheRoot, { recursive: true, force: true })
    }
  })
})
