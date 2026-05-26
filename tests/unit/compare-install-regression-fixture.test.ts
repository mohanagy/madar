import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

function readFixtureReport(
  arm: 'no-install' | 'with-install',
  fileName: 'report.json' | 'report.share-safe.json',
): Record<string, unknown> {
  const reportPath = resolve('docs/benchmarks/regression/install-ab-govalidate-explain', arm, fileName)
  return JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>
}

describe('compare install regression fixture', () => {
  it('stores invalid vs valid measurement validity across the no-install and with-install arms', () => {
    const noInstallReport = readFixtureReport('no-install', 'report.json')
    const withInstallReport = readFixtureReport('with-install', 'report.json')
    const noInstallShareSafeReport = readFixtureReport('no-install', 'report.share-safe.json')
    const withInstallShareSafeReport = readFixtureReport('with-install', 'report.share-safe.json')

    expect(noInstallReport.install_verified).toBe(false)
    expect(noInstallReport.measurement_validity).toBe('invalid')
    expect(noInstallReport.madar_mcp_call_count).toBe(0)
    expect(withInstallReport.install_verified).toBe(true)
    expect(withInstallReport.measurement_validity).toBe('valid')
    expect(withInstallReport.madar_mcp_call_count).toBe(2)

    expect(noInstallShareSafeReport.install_verified).toBe(false)
    expect(noInstallShareSafeReport.measurement_validity).toBe('invalid')
    expect(noInstallShareSafeReport.madar_mcp_call_count).toBe(0)
    expect(withInstallShareSafeReport.install_verified).toBe(true)
    expect(withInstallShareSafeReport.measurement_validity).toBe('valid')
    expect(withInstallShareSafeReport.madar_mcp_call_count).toBe(2)
  })
})
