import * as fs from 'node:fs'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectRootPackageValidation } from '../../src/runtime/validation-discovery.js'

vi.mock('node:fs', async () => ({
  ...await vi.importActual<typeof import('node:fs')>('node:fs'),
}))

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'madar-validation-'))
  roots.push(root)
  return { root, path: join(root, 'package.json') }
}
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))

describe('root package validation discovery', () => {
  it('distinguishes inspected script availability without executing or inventing commands', () => {
    const { root, path } = fixture()
    for (const [json, result, scripts] of [
      [{ name: 'example', type: 'module' }, 'no_scripts', {}],
      [{ scripts: {} }, 'no_scripts', {}],
      [{ scripts: { start: 'node app.js' } }, 'no_supported_validation_scripts', { start: 'node app.js' }],
      [{ scripts: { test: '  ' } }, 'no_supported_validation_scripts', {}],
      [{ scripts: { test: 'never-executed-command', build: 'compile', 'test:run': 'runner', typecheck: 'check' } }, 'commands_available',
        { test: 'never-executed-command', build: 'compile', 'test:run': 'runner', typecheck: 'check' }],
    ] as const) {
      writeFileSync(path, JSON.stringify(json))
      const inspected = inspectRootPackageValidation(root)
      expect(inspected.discovery).toMatchObject({ source_file: 'package.json', scope: 'root_package_validation_scripts', status: 'inspected', result })
      expect(new Date(inspected.discovery.observed_at).toISOString()).toBe(inspected.discovery.observed_at)
      expect(inspected.scripts).toEqual(scripts)
    }
  })

  it('keeps malformed JSON, package shape and script values separate from verified absence', () => {
    const { root, path } = fixture()
    for (const [text, status] of [
      ['{', 'invalid_json'], ['null', 'invalid_package'], ['[]', 'invalid_package'], ['"package"', 'invalid_package'],
      ['{"scripts":null}', 'invalid_scripts'], ['{"scripts":[]}', 'invalid_scripts'],
      ['{"scripts":{"test":false}}', 'invalid_scripts'], ['{"scripts":{"test":"runner","other":0}}', 'invalid_scripts'],
    ]) {
      writeFileSync(path, text!)
      const inspected = inspectRootPackageValidation(root)
      expect(inspected.discovery.status).toBe(status)
      expect(inspected.discovery).not.toHaveProperty('result')
      expect(inspected.scripts).toEqual({})
    }
  })

  it('distinguishes unknown roots, missing manifests, unreadable files and bounded reads', () => {
    const { root, path } = fixture()
    expect(inspectRootPackageValidation().discovery.status).toBe('unknown_root')
    expect(inspectRootPackageValidation(join(root, 'absent')).discovery.status).toBe('unknown_root')
    expect(inspectRootPackageValidation(root).discovery.status).toBe('missing')
    writeFileSync(path, '{}')
    // chmod(0) does not revoke reads on Windows. Exercise the actual open
    // failure while keeping the preceding path and current-policy checks real.
    const canonicalPath = realpathSync(path)
    const open = fs.openSync
    const denied = vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
      if (args[0] === canonicalPath) throw Object.assign(new Error('Fixture access denied'), { code: 'EACCES' })
      return open(...args)
    })
    try { expect(inspectRootPackageValidation(root).discovery.status).toBe('unreadable') } finally { denied.mockRestore() }
    writeFileSync(path, ' '.repeat(256 * 1024))
    expect(inspectRootPackageValidation(root).discovery.status).toBe('bounded')
    rmSync(path)
    mkdirSync(path)
    expect(inspectRootPackageValidation(root).discovery.status).toBe('blocked')
  })

  it('honors explicit exclusions and bounded root ignore policy before inspecting the package', () => {
    const { root, path } = fixture()
    writeFileSync(path, '{"scripts":{"test":"runner"}}')
    for (const excludedPath of ['package.json', path, '.']) {
      expect(inspectRootPackageValidation(root, { excludedPaths: [excludedPath] }).discovery.status).toBe('blocked')
    }
    writeFileSync(join(root, '.madarignore'), '# root policy\npackage.json\n')
    expect(inspectRootPackageValidation(root).discovery.status).toBe('blocked')
    writeFileSync(join(root, '.madarignore'), 'package.json\n!package.json\n')
    expect(inspectRootPackageValidation(root).discovery.status).toBe('inspected')
    writeFileSync(join(root, '.madarignore'), 'x\n'.repeat(1025))
    expect(inspectRootPackageValidation(root).discovery.status).toBe('bounded')
  })

  it('confines symlinks and applies sensitive and ignore policy to their destinations', () => {
    const { root, path } = fixture()
    const external = fixture()
    writeFileSync(external.path, '{"scripts":{"test":"external"}}')
    symlinkSync(external.path, path)
    expect(inspectRootPackageValidation(root).discovery.status).toBe('blocked')
    rmSync(path)
    const secret = join(root, 'secrets.json')
    writeFileSync(secret, '{"scripts":{"test":"secret"}}')
    symlinkSync(secret, path)
    expect(inspectRootPackageValidation(root).discovery.status).toBe('blocked')
    rmSync(path)
    const manifest = join(root, 'manifest.json')
    writeFileSync(manifest, '{"scripts":{"test":"safe"}}')
    symlinkSync(manifest, path)
    expect(inspectRootPackageValidation(root).discovery).toMatchObject({ status: 'inspected', result: 'commands_available' })
    writeFileSync(join(root, '.madarignore'), 'manifest.json\n')
    expect(inspectRootPackageValidation(root).discovery.status).toBe('blocked')
    rmSync(join(root, '.madarignore'))
    symlinkSync(external.path, join(root, '.madarignore'))
    expect(inspectRootPackageValidation(root).discovery.status).toBe('blocked')
    rmSync(join(root, '.madarignore'))
    symlinkSync(join(root, 'missing-policy'), join(root, '.madarignore'))
    expect(inspectRootPackageValidation(root).discovery.status).toBe('blocked')
  })

  it('inspects current bytes again after same-size edits with restored timestamps', () => {
    const { root, path } = fixture()
    writeFileSync(path, '{"scripts":{"noop":"ok"}}')
    const before = statSync(path)
    expect(inspectRootPackageValidation(root).discovery).toMatchObject({ status: 'inspected', result: 'no_supported_validation_scripts' })
    writeFileSync(path, '{"scripts":{"test":"ok"}}')
    utimesSync(path, before.atime, before.mtime)
    const updated = inspectRootPackageValidation(root)
    expect(updated.discovery).toMatchObject({ status: 'inspected', result: 'commands_available' })
    expect(updated.scripts).toEqual({ test: 'ok' })
  })
})
