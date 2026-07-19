import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptRoot = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptRoot, '..', '..', '..')
const defaultContractPath = resolve(
  repositoryRoot,
  'tools/eval/core-reset/contracts/evaluation-contract.json',
)
const gitBinary = process.platform === 'win32' ? 'git.exe' : 'git'
const gitEnvironment = { ...process.env }
for (const name of Object.keys(gitEnvironment)) {
  if (name.toUpperCase().startsWith('GIT_')) delete gitEnvironment[name]
}
Object.assign(gitEnvironment, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_TERMINAL_PROMPT: '0',
})

function usage() {
  return [
    'Usage:',
    '  node tools/eval/core-reset/verify-held-out-repositories.mjs \\',
    '    --repository openstatus=/path/to/openstatus \\',
    '    --repository documenso=/path/to/documenso \\',
    '    --repository formbricks=/path/to/formbricks',
    '',
    'Options:',
    '  --repository id=path  Repeat once for every repository in the frozen contract.',
    '  --contract path        Use another contract file (development only).',
    '  --help                 Print this help.',
    '',
    'The verifier reads only local Git objects and applies frozen patches in disposable temp directories.',
    'It never fetches, pulls, clones, or changes a supplied checkout.',
  ].join('\n')
}

function fail(message) {
  throw new Error(`${message}\n\n${usage()}`)
}

function parseArguments(argv) {
  let contractPath = defaultContractPath
  const repositories = new Map()

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help') {
      process.stdout.write(`${usage()}\n`)
      process.exit(0)
    }
    if (argument === '--contract') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) fail('--contract requires a path')
      contractPath = resolve(value)
      index += 1
      continue
    }
    if (argument === '--repository') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) fail('--repository requires id=path')
      const separator = value.indexOf('=')
      if (separator < 1 || separator === value.length - 1) {
        fail(`Invalid --repository value ${JSON.stringify(value)}; expected id=path`)
      }
      const id = value.slice(0, separator)
      const path = value.slice(separator + 1)
      if (repositories.has(id)) fail(`Repository ${id} was supplied more than once`)
      repositories.set(id, path)
      index += 1
      continue
    }
    fail(`Unknown argument ${JSON.stringify(argument)}`)
  }

  return { contractPath, repositories }
}

function git(cwd, args) {
  try {
    return execFileSync(gitBinary, ['-C', cwd, ...args], {
      encoding: 'utf8',
      env: gitEnvironment,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const stderr = typeof error?.stderr === 'string'
      ? error.stderr.trim()
      : Buffer.isBuffer(error?.stderr)
        ? error.stderr.toString('utf8').trim()
        : ''
    const detail = stderr ? `: ${stderr}` : ''
    throw new Error(`git ${args.join(' ')} failed in ${cwd}${detail}`)
  }
}

function gitBuffer(cwd, args) {
  try {
    return execFileSync(gitBinary, ['-C', cwd, ...args], {
      env: gitEnvironment,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const stderr = Buffer.isBuffer(error?.stderr)
      ? error.stderr.toString('utf8').trim()
      : (typeof error?.stderr === 'string' ? error.stderr.trim() : '')
    const detail = stderr ? `: ${stderr}` : ''
    throw new Error(`git ${args.join(' ')} failed in ${cwd}${detail}`)
  }
}

export function treePathHash(cwd, commit) {
  const paths = git(cwd, [
    'ls-tree',
    '-r',
    '-t',
    '--full-tree',
    '--name-only',
    commit,
  ])
    .trimEnd()
    .split(/\r?\n/)
    .filter(Boolean)
    .sort()

  return createHash('sha256').update(`${paths.join('\n')}\n`).digest('hex')
}

function assertContractPath(path, label) {
  if (isAbsolute(path) || path.includes('*') || path.split('/').includes('..')) {
    throw new Error(`${label} is not a safe repository-root-relative path: ${path}`)
  }
}

export function verifyRepository(repository, suppliedPath) {
  const resolvedPath = resolve(suppliedPath)
  if (!existsSync(resolvedPath)) {
    throw new Error(`${repository.id} checkout does not exist: ${resolvedPath}`)
  }
  const checkout = realpathSync(resolvedPath)

  if (git(checkout, ['rev-parse', '--is-inside-work-tree']).trim() !== 'true') {
    throw new Error(`${repository.id} path is not a Git worktree: ${checkout}`)
  }

  git(checkout, ['cat-file', '-e', `${repository.commit}^{commit}`])
  const resolvedCommit = git(checkout, ['rev-parse', `${repository.commit}^{commit}`]).trim()
  if (resolvedCommit !== repository.commit) {
    throw new Error(`${repository.id} resolved ${repository.commit} to unexpected commit ${resolvedCommit}`)
  }

  const observedTreeHash = treePathHash(checkout, repository.commit)
  if (observedTreeHash !== repository.tree_paths_sha256) {
    throw new Error(
      `${repository.id} tree-path hash ${observedTreeHash} does not match frozen ${repository.tree_paths_sha256}`,
    )
  }

  if (repository.graph_root === '.') {
    git(checkout, ['cat-file', '-e', `${repository.commit}^{tree}`])
  } else {
    assertContractPath(repository.graph_root, `${repository.id} graph_root`)
    const graphRootType = git(
      checkout,
      ['cat-file', '-t', `${repository.commit}:${repository.graph_root}`],
    ).trim()
    if (graphRootType !== 'tree') {
      throw new Error(`${repository.id} graph_root is not a tree at the frozen commit: ${repository.graph_root}`)
    }
  }

  for (const evidencePath of repository.verified_evidence_paths) {
    assertContractPath(evidencePath, `${repository.id} evidence path`)
    git(checkout, ['cat-file', '-e', `${repository.commit}:${evidencePath}`])
    const objectType = git(
      checkout,
      ['cat-file', '-t', `${repository.commit}:${evidencePath}`],
    ).trim()
    if (objectType !== 'blob') {
      throw new Error(`${repository.id} evidence path is not a file at the frozen commit: ${evidencePath}`)
    }
    const treeEntry = git(
      checkout,
      ['ls-tree', repository.commit, '--', evidencePath],
    ).trim()
    const mode = treeEntry.match(/^(\d{6})\s/)?.[1]
    if (!mode) {
      throw new Error(`${repository.id} evidence path has no tree entry at the frozen commit: ${evidencePath}`)
    }
    if (mode === '120000') {
      throw new Error(`${repository.id} evidence path is a symbolic link at the frozen commit: ${evidencePath}`)
    }
  }

  return {
    id: repository.id,
    checkout,
    commit: resolvedCommit,
    tree_paths_sha256: observedTreeHash,
    verified_evidence_paths: repository.verified_evidence_paths.length,
  }
}

export function verifyRefreshMutation(repository, mutation, suppliedPath) {
  const checkout = realpathSync(resolve(suppliedPath))
  assertContractPath(mutation.path, `${repository.id} refresh path`)
  assertContractPath(mutation.path_from_graph_root, `${repository.id} graph-root refresh path`)
  const expectedPath = repository.graph_root === '.'
    ? mutation.path_from_graph_root
    : `${repository.graph_root}/${mutation.path_from_graph_root}`
  if (mutation.path !== expectedPath) {
    throw new Error(`${repository.id} refresh path does not match graph_root coordinates: ${mutation.path}`)
  }

  const observedOid = git(checkout, ['rev-parse', `${repository.commit}:${mutation.path}`]).trim()
  if (observedOid !== mutation.base_git_blob_oid) {
    throw new Error(`${repository.id} refresh base blob OID ${observedOid} does not match frozen ${mutation.base_git_blob_oid}`)
  }
  const base = gitBuffer(checkout, ['cat-file', 'blob', observedOid])
  const baseSha256 = createHash('sha256').update(base).digest('hex')
  if (base.length !== mutation.base_bytes || baseSha256 !== mutation.base_blob_sha256) {
    throw new Error(`${repository.id} refresh base bytes/hash do not match the frozen mutation`)
  }

  const patch = Buffer.from(mutation.patch_utf8, 'utf8')
  const patchSha256 = createHash('sha256').update(patch).digest('hex')
  if (patch.length !== mutation.patch_bytes || patchSha256 !== mutation.patch_sha256) {
    throw new Error(`${repository.id} refresh patch bytes/hash do not match the frozen mutation`)
  }

  const temporaryRoot = mkdtempSync(join(tmpdir(), `madar-refresh-${repository.id}-`))
  try {
    git(temporaryRoot, ['init', '-q'])
    const target = join(temporaryRoot, ...mutation.path.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, base)
    git(temporaryRoot, ['add', '--', mutation.path])
    const patchPath = join(temporaryRoot, '.git', 'refresh.patch')
    writeFileSync(patchPath, patch)
    git(temporaryRoot, ['apply', '--check', '--whitespace=nowarn', patchPath])
    git(temporaryRoot, ['apply', '--whitespace=nowarn', patchPath])
    const changedPaths = new Set([
      ...git(temporaryRoot, ['diff', '--name-only', '--']).trim().split(/\r?\n/),
      ...git(temporaryRoot, ['diff', '--cached', '--name-only', '--']).trim().split(/\r?\n/),
      ...git(temporaryRoot, ['ls-files', '--others']).trim().split(/\r?\n/),
    ].filter(Boolean))
    if (changedPaths.size !== 1 || !changedPaths.has(mutation.path)) {
      throw new Error(
        `${repository.id} refresh patch changes paths other than its frozen target: ${[...changedPaths].sort().join(', ')}`,
      )
    }
    const result = readFileSync(target)
    const resultSha256 = createHash('sha256').update(result).digest('hex')
    if (result.length !== mutation.result_bytes || resultSha256 !== mutation.result_blob_sha256) {
      throw new Error(`${repository.id} refresh result bytes/hash do not match the frozen mutation`)
    }
    if (!result.toString('utf8').includes(mutation.expected_symbol)) {
      throw new Error(`${repository.id} refresh result does not contain ${mutation.expected_symbol}`)
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }

  return {
    path: mutation.path,
    base_git_blob_oid: observedOid,
    base_blob_sha256: baseSha256,
    patch_sha256: patchSha256,
    result_blob_sha256: mutation.result_blob_sha256,
  }
}

function main() {
  const { contractPath, repositories: suppliedRepositories } = parseArguments(process.argv.slice(2))
  if (!existsSync(contractPath)) fail(`Contract does not exist: ${contractPath}`)

  const contract = JSON.parse(readFileSync(contractPath, 'utf8'))
  const frozenRepositories = contract.repositories ?? []
  const frozenIds = new Set(frozenRepositories.map((repository) => repository.id))

  for (const id of suppliedRepositories.keys()) {
    if (!frozenIds.has(id)) fail(`Unknown repository id ${id}`)
  }
  const missing = frozenRepositories
    .map((repository) => repository.id)
    .filter((id) => !suppliedRepositories.has(id))
  if (missing.length > 0) {
    fail(`Missing frozen repositories: ${missing.join(', ')}`)
  }

  const refreshByRepository = new Map(
    (contract.trial_design?.refresh_measurement?.repositories ?? [])
      .map((entry) => [entry.repository_id, entry.mutation]),
  )
  const results = frozenRepositories.map((repository) => {
    const suppliedPath = suppliedRepositories.get(repository.id)
    const result = verifyRepository(repository, suppliedPath)
    const mutation = refreshByRepository.get(repository.id)
    return {
      ...result,
      refresh_mutation: mutation
        ? verifyRefreshMutation(repository, mutation, suppliedPath)
        : null,
    }
  })

  process.stdout.write([
    'Held-out repositories and refresh fixtures verified from local Git objects (no network operations).',
    ...results.map((result) => [
      `- ${result.id}: ${result.commit}`,
      `  tree paths: ${result.tree_paths_sha256}`,
      `  evidence files: ${result.verified_evidence_paths}`,
      ...(result.refresh_mutation
        ? [`  refresh fixture: ${result.refresh_mutation.path} (${result.refresh_mutation.patch_sha256})`]
        : []),
      `  checkout: ${result.checkout}`,
    ].join('\n')),
  ].join('\n') + '\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[core-reset preflight] ${message}\n`)
    process.exitCode = 1
  }
}
