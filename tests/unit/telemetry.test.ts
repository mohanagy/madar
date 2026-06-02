import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import {
  clearTelemetry,
  disableTelemetry,
  enableTelemetry,
  formatTelemetryStatus,
  getTelemetryStatus,
  graphSizeBucketFromNodeCount,
  readTelemetryReport,
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
        command: 'generate',
        stage: 'started',
        version: '0.27.4',
        os: 'darwin',
        nodeMajor: 20,
        spiEnabled: true,
      }, {
        configRoot,
        cacheRoot,
        env: {},
        now: () => 1_700_000_010_000,
        maxEvents: 2,
      })).toBe(true)

      expect(recordTelemetryEvent({
        command: 'generate',
        stage: 'succeeded',
        version: '0.27.4',
        os: 'darwin',
        nodeMajor: 20,
        repoSizeBucket: repoSizeBucketFromFileCount(240),
        graphSizeBucket: graphSizeBucketFromNodeCount(1_200),
        spiEnabled: true,
      }, {
        configRoot,
        cacheRoot,
        env: {},
        now: () => 1_700_000_020_000,
        maxEvents: 2,
      })).toBe(true)

      expect(recordTelemetryEvent({
        command: 'context_pack',
        stage: 'failed',
        version: '0.27.4',
        os: 'darwin',
        nodeMajor: 20,
        repoSizeBucket: repoSizeBucketFromFileCount(12),
        graphSizeBucket: graphSizeBucketFromNodeCount(5),
        failureBucket: 'invalid_params',
      }, {
        configRoot,
        cacheRoot,
        env: {},
        now: () => 1_700_000_030_000,
        maxEvents: 2,
      })).toBe(true)

      const spoolFile = join(cacheRoot, 'madar', 'telemetry-events.json')
      expect(JSON.parse(readFileSync(spoolFile, 'utf8'))).toEqual({
        schema_version: 2,
        events: [
          expect.objectContaining({
            command: 'generate',
            stage: 'succeeded',
            version: '0.27.4',
            os: 'darwin',
            node_major: 20,
            repo_size_bucket: '100-499',
            graph_size_bucket: '1000-4999',
            spi_enabled: true,
          }),
          expect.objectContaining({
            command: 'context_pack',
            stage: 'failed',
            version: '0.27.4',
            os: 'darwin',
            node_major: 20,
            repo_size_bucket: '1-24',
            graph_size_bucket: '1-99',
            failure_bucket: 'invalid_params',
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
        command: 'generate',
        stage: 'succeeded',
        version: '0.27.4',
        os: 'darwin',
        nodeMajor: 20,
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

  it('falls back to the default cap when maxEvents is zero or negative', () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'madar-telemetry-config-'))
    const cacheRoot = mkdtempSync(join(tmpdir(), 'madar-telemetry-cache-'))

    try {
      enableTelemetry({
        configRoot,
        cacheRoot,
        env: {},
      })

      expect(recordTelemetryEvent({
        command: 'generate',
        stage: 'succeeded',
        version: '0.27.4',
        os: 'darwin',
        nodeMajor: 20,
        repoSizeBucket: '25-99',
      }, {
        configRoot,
        cacheRoot,
        env: {},
        maxEvents: 0,
        now: () => 1_700_000_000_000,
      })).toBe(true)

      expect(recordTelemetryEvent({
        command: 'pack',
        stage: 'succeeded',
        version: '0.27.4',
        os: 'darwin',
        nodeMajor: 20,
        repoSizeBucket: '25-99',
      }, {
        configRoot,
        cacheRoot,
        env: {},
        maxEvents: -5,
        now: () => 1_700_000_010_000,
      })).toBe(true)

      const spoolFile = join(cacheRoot, 'madar', 'telemetry-events.json')
      expect(JSON.parse(readFileSync(spoolFile, 'utf8')).events).toHaveLength(2)
    } finally {
      rmSync(configRoot, { recursive: true, force: true })
      rmSync(cacheRoot, { recursive: true, force: true })
    }
  })

  it('clears the local telemetry spool without deleting the persisted preference', () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'madar-telemetry-config-'))
    const cacheRoot = mkdtempSync(join(tmpdir(), 'madar-telemetry-cache-'))

    try {
      enableTelemetry({
        configRoot,
        cacheRoot,
        env: {},
      })

      expect(recordTelemetryEvent({
        command: 'install',
        stage: 'started',
        version: '0.27.4',
        os: 'darwin',
        nodeMajor: 20,
        agentTarget: 'copilot',
      }, {
        configRoot,
        cacheRoot,
        env: {},
      })).toBe(true)

      const message = clearTelemetry({
        configRoot,
        cacheRoot,
        env: {},
      })

      expect(message).toContain('Telemetry cache cleared')
      expect(getTelemetryStatus({
        configRoot,
        cacheRoot,
        env: {},
      }).enabled).toBe(true)

      const spoolFile = join(cacheRoot, 'madar', 'telemetry-events.json')
      expect(JSON.parse(readFileSync(spoolFile, 'utf8'))).toEqual({
        schema_version: 2,
        events: [],
      })
    } finally {
      rmSync(configRoot, { recursive: true, force: true })
      rmSync(cacheRoot, { recursive: true, force: true })
    }
  })

  it('summarizes anonymized funnel counts from both v2 and legacy v1 spools', () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'madar-telemetry-config-'))
    const cacheRoot = mkdtempSync(join(tmpdir(), 'madar-telemetry-cache-'))

    try {
      const legacySpoolPath = join(cacheRoot, 'legacy-telemetry-events.json')
      writeFileSync(legacySpoolPath, JSON.stringify({
        schema_version: 1,
        events: [
          {
            event: 'install_success',
            recorded_at: '2026-06-02T00:00:00.000Z',
            version: '0.27.4',
            os: 'darwin',
            install_platform: 'cursor',
          },
          {
            event: 'generate_success',
            recorded_at: '2026-06-02T00:01:00.000Z',
            version: '0.27.4',
            os: 'darwin',
            repo_size_bucket: '25-99',
          },
        ],
      }, null, 2))

      enableTelemetry({
        configRoot,
        cacheRoot,
        env: {},
      })
      expect(recordTelemetryEvent({
        command: 'status',
        stage: 'succeeded',
        version: '0.27.8',
        os: 'darwin',
        nodeMajor: 20,
        statusBucket: 'healthy',
      }, {
        configRoot,
        cacheRoot,
        env: {},
      })).toBe(true)

      const report = readTelemetryReport({
        configRoot,
        cacheRoot,
        env: {},
      }, [legacySpoolPath])

      expect(report).toContain('Telemetry funnel summary')
      expect(report).toContain('install 1')
      expect(report).toContain('generate 1')
      expect(report).toContain('status 1')
      expect(report).toContain('cursor 1')
      expect(report).toContain('healthy 1')
    } finally {
      rmSync(configRoot, { recursive: true, force: true })
      rmSync(cacheRoot, { recursive: true, force: true })
    }
  })
})
