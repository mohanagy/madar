import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import * as generateModule from '../../src/infrastructure/generate.js'
import { listPackQualityFixtures, runPackQualityFixture } from './helpers/pack-quality.js'

const tempFixtureNames: string[] = []

afterEach(() => {
  while (tempFixtureNames.length > 0) {
    const name = tempFixtureNames.pop()
    if (name) {
      rmSync(resolve('tests/fixtures/pack-quality', name), { recursive: true, force: true })
    }
  }
})

describe('pack-quality helper', () => {
  it('throws when a fixture manifest is malformed', async () => {
    const fixtureName = '__invalid-manifest-fixture'
    const fixtureRoot = resolve('tests/fixtures/pack-quality', fixtureName)
    tempFixtureNames.push(fixtureName)
    mkdirSync(join(fixtureRoot, 'workspace'), { recursive: true })
    writeFileSync(join(fixtureRoot, 'fixture.json'), JSON.stringify({
      expected_workflow_centers: [],
    }))

    await expect(runPackQualityFixture(fixtureName)).rejects.toThrow(/fixture\.json|prompt|expected_likely_edit_files/i)
  })

  it('fails fast when a fixture directory exists outside the declared fixture order', () => {
    const fixtureName = '__unlisted-fixture'
    const fixtureRoot = resolve('tests/fixtures/pack-quality', fixtureName)
    tempFixtureNames.push(fixtureName)
    mkdirSync(join(fixtureRoot, 'workspace'), { recursive: true })
    writeFileSync(join(fixtureRoot, 'fixture.json'), JSON.stringify({
      prompt: 'Explain auth flow',
      expected_workflow_centers: [],
      expected_likely_edit_files: [],
      expected_likely_test_files: [],
      expected_validation_commands: [],
      expected_negative_guidance: [],
    }), 'utf8')

    expect(() => listPackQualityFixtures()).toThrow(/unlisted pack-quality fixture/i)
  })

  it('uses SPI when a fixture declares SPI-only framework coverage', async () => {
    const generateSpy = vi.spyOn(generateModule, 'generateGraph')

    await runPackQualityFixture('framework-request-flow-owner')

    expect(generateSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        noHtml: true,
        useSpi: true,
      }),
    )
  })
})
