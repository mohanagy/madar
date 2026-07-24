import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '..', '..')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function readTarString(buffer, start, length) {
  const nul = buffer.indexOf(0, start)
  const end = nul >= start && nul < start + length ? nul : start + length
  return buffer.subarray(start, end).toString('utf8').trim()
}

function readTarOctal(buffer, start, length) {
  const value = readTarString(buffer, start, length).replace(/\0/g, '').trim()
  return value.length === 0 ? 0 : Number.parseInt(value, 8)
}

function parsePaxPath(buffer) {
  let offset = 0
  let path = null
  while (offset < buffer.length) {
    const separator = buffer.indexOf(0x20, offset)
    if (separator < 0) break
    const recordLength = Number.parseInt(buffer.subarray(offset, separator).toString('ascii'), 10)
    if (!Number.isFinite(recordLength) || recordLength <= 0) break
    const record = buffer.subarray(separator + 1, offset + recordLength).toString('utf8').replace(/\n$/, '')
    const equals = record.indexOf('=')
    if (equals > 0 && record.slice(0, equals) === 'path') {
      path = record.slice(equals + 1)
    }
    offset += recordLength
  }
  return path
}

function safeArchiveTarget(destination, archivePath) {
  const normalized = archivePath.replaceAll('\\', '/')
  if (!normalized.startsWith('package/') || normalized.split('/').includes('..')) {
    throw new Error(`Unsafe npm package path: ${archivePath}`)
  }
  const target = resolve(destination, ...normalized.split('/'))
  const prefix = destination.endsWith(sep) ? destination : `${destination}${sep}`
  if (!target.startsWith(prefix)) {
    throw new Error(`npm package path escaped extraction root: ${archivePath}`)
  }
  return target
}

function extractNpmTarball(tarballPath, destination) {
  const tar = gunzipSync(readFileSync(tarballPath))
  let offset = 0
  let pendingPath = null

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break

    const name = readTarString(header, 0, 100)
    const prefix = readTarString(header, 345, 155)
    const archivePath = pendingPath ?? (prefix ? `${prefix}/${name}` : name)
    const size = readTarOctal(header, 124, 12)
    const mode = readTarOctal(header, 100, 8)
    const type = String.fromCharCode(header[156] ?? 0)
    const contentStart = offset + 512
    const contentEnd = contentStart + size
    if (contentEnd > tar.length) {
      throw new Error(`Truncated npm package entry: ${archivePath}`)
    }
    const content = tar.subarray(contentStart, contentEnd)
    pendingPath = null

    if (type === 'x') {
      pendingPath = parsePaxPath(content)
    } else if (type === 'L') {
      pendingPath = content.toString('utf8').replace(/\0.*$/s, '').trim()
    } else if (type === '5') {
      mkdirSync(safeArchiveTarget(destination, archivePath), { recursive: true })
    } else if (type === '0' || type === '\0' || type === '') {
      const target = safeArchiveTarget(destination, archivePath)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
      if (mode > 0 && process.platform !== 'win32') chmodSync(target, mode)
    } else if (type !== 'g') {
      throw new Error(`Unsupported npm package entry type ${JSON.stringify(type)}: ${archivePath}`)
    }

    offset = contentStart + Math.ceil(size / 512) * 512
  }
}

async function createParityGraph(root, updateIndexInWorker) {
  const sourceRoot = join(root, 'workspace')
  const files = {
    route: join(sourceRoot, 'route.ts'),
    analytics: join(sourceRoot, 'analytics.ts'),
    redirect: join(sourceRoot, 'redirect.ts'),
  }
  mkdirSync(sourceRoot, { recursive: true })
  writeFileSync(files.route, [
    "import { trackClick } from './analytics.js'",
    "import { redirectToDestination } from './redirect.js'",
    'export function handleClick() { trackClick(); redirectToDestination() }',
    '',
  ].join('\n'))
  writeFileSync(files.analytics, 'export function trackClick() {}\n')
  writeFileSync(files.redirect, 'export function redirectToDestination() {}\n')
  const result = await updateIndexInWorker(sourceRoot)
  if (result.updateReceipt?.mode !== 'cold_reconcile' || !existsSync(result.graphPath)) {
    throw new Error('Packed parity fixture did not publish a canonical graph')
  }
  return result.graphPath
}

function normalizedResponse(response) {
  return JSON.parse(JSON.stringify(response, (key, value) =>
    key === 'checked_at' || key === 'generated_at' ? undefined : value))
}

function successfulRetrieve(response, label, expectedLabels) {
  if (response?.error) {
    throw new Error(`${label} returned an MCP error: ${JSON.stringify(response.error)}`)
  }
  const text = response?.result?.content?.[0]?.text
  if (typeof text !== 'string') {
    throw new Error(`${label} did not return text evidence`)
  }
  let result
  try {
    result = JSON.parse(text)
  } catch {
    throw new Error(`${label} did not return canonical JSON evidence`)
  }
  if (result?.schema !== 'madar.retrieve' || result?.outcome !== 'evidence') {
    throw new Error(`${label} did not complete successful evidence retrieval`)
  }
  const labels = new Set((result.matched_nodes ?? []).map((node) =>
    String(node.label ?? '').replaceAll(/[^a-z0-9]/gi, '').toLowerCase()))
  for (const expected of expectedLabels) {
    if (!labels.has(expected.toLowerCase())) {
      throw new Error(
        `${label} omitted expected declaration ${expected}; returned ${[...labels].join(', ')}`,
      )
    }
  }
  return result
}

const tempRoot = join(tmpdir(), `madar-packed-parity-${randomUUID()}`)
const packRoot = join(tempRoot, 'pack')
const extractionRoot = join(tempRoot, 'extracted')
const previousToolProfile = process.env.MADAR_TOOL_PROFILE

try {
  mkdirSync(packRoot, { recursive: true })
  mkdirSync(extractionRoot, { recursive: true })
  const packOutput = execFileSync(npmCommand, [
    'pack',
    '--json',
    '--silent',
    '--pack-destination',
    packRoot,
  ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let packedFilename = null
  try {
    const parsed = JSON.parse(packOutput)
    packedFilename = Array.isArray(parsed) && typeof parsed[0]?.filename === 'string' ? parsed[0].filename : null
  } catch {
    // Older npm releases may add lifecycle output around --json. The archive
    // directory remains authoritative and contains exactly one package here.
  }
  const tarballPath = join(
    packRoot,
    packedFilename ?? readdirSync(packRoot).find((entry) => entry.endsWith('.tgz')) ?? '',
  )
  if (!existsSync(tarballPath)) throw new Error('npm pack did not produce a tarball')

  extractNpmTarball(tarballPath, extractionRoot)
  const packedRoot = join(extractionRoot, 'package')
  if (existsSync(join(packedRoot, 'docs'))) {
    throw new Error('Packed artifact unexpectedly contains checkout-only docs')
  }
  symlinkSync(
    join(repositoryRoot, 'node_modules'),
    join(packedRoot, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )

  const checkoutServerPath = join(repositoryRoot, 'dist', 'src', 'runtime', 'stdio-server.js')
  const packedServerPath = join(packedRoot, 'dist', 'src', 'runtime', 'stdio-server.js')
  const checkoutMetadataPath = join(repositoryRoot, 'dist', 'src', 'shared', 'package-metadata.js')
  const packedMetadataPath = join(packedRoot, 'dist', 'src', 'shared', 'package-metadata.js')
  const packedWatcherPath = join(packedRoot, 'dist', 'src', 'infrastructure', 'watch-index.js')
  const packedStorePath = join(packedRoot, 'dist', 'src', 'adapters', 'filesystem', 'index-store.js')
  const packedUpdatePath = join(packedRoot, 'dist', 'src', 'application', 'update-index.js')
  for (const path of [checkoutServerPath, packedServerPath, checkoutMetadataPath, packedMetadataPath, packedWatcherPath, packedStorePath, packedUpdatePath]) {
    if (!existsSync(path)) throw new Error(`Missing parity runtime module: ${path}`)
  }

  const [checkoutServer, packedServer, checkoutMetadata, packedMetadata, packedWatcher, packedStore] = await Promise.all([
    import(`${pathToFileURL(checkoutServerPath).href}?parity=checkout`),
    import(`${pathToFileURL(packedServerPath).href}?parity=packed`),
    import(`${pathToFileURL(checkoutMetadataPath).href}?parity=checkout`),
    import(`${pathToFileURL(packedMetadataPath).href}?parity=packed`),
    import(`${pathToFileURL(packedWatcherPath).href}?parity=packed`),
    import(`${pathToFileURL(packedStorePath).href}?parity=packed`),
  ])
  const checkoutVersion = checkoutMetadata.readPackageVersion(repositoryRoot)
  const packedVersion = packedMetadata.readPackageVersion(packedRoot)
  if (checkoutVersion !== packedVersion) {
    throw new Error(`Package version mismatch: checkout=${checkoutVersion} packed=${packedVersion}`)
  }

  process.env.MADAR_TOOL_PROFILE = 'full'
  const graphPath = await createParityGraph(tempRoot, packedWatcher.updateIndexInWorker)
  const prompt = 'Where is handleClick defined?'
  const request = {
    jsonrpc: '2.0',
    id: 551,
    method: 'tools/call',
    params: {
      name: 'retrieve',
      arguments: {
        question: prompt,
        budget: 1200,
      },
    },
  }
  const checkoutResponse = await Promise.resolve(checkoutServer.handleStdioRequest(graphPath, request))
  const packedResponse = await Promise.resolve(packedServer.handleStdioRequest(graphPath, request))
  const expectedDeclarations = ['handleclick']
  successfulRetrieve(
    checkoutResponse,
    'Checkout runtime',
    expectedDeclarations,
  )
  successfulRetrieve(
    packedResponse,
    'Packed runtime',
    expectedDeclarations,
  )
  const normalizedCheckout = normalizedResponse(checkoutResponse)
  const normalizedPacked = normalizedResponse(packedResponse)
  if (JSON.stringify(normalizedCheckout) !== JSON.stringify(normalizedPacked)) {
    writeFileSync(join(tempRoot, 'checkout-response.json'), JSON.stringify(normalizedCheckout, null, 2))
    writeFileSync(join(tempRoot, 'packed-response.json'), JSON.stringify(normalizedPacked, null, 2))
    throw new Error(`Packed retrieval differs from checkout retrieval; inspect ${tempRoot}`)
  }

  const workerRoot = join(tempRoot, 'worker-workspace')
  mkdirSync(workerRoot, { recursive: true })
  writeFileSync(join(workerRoot, 'main.ts'), 'export const workerValue = 1\n')
  const workerResult = await packedWatcher.updateIndexInWorker(workerRoot)
  if (workerResult.updateReceipt?.mode !== 'cold_reconcile' || !existsSync(workerResult.graphPath)) {
    throw new Error('Packed MCP index worker did not publish a canonical graph')
  }

  writeFileSync(join(workerRoot, 'main.ts'), 'export const workerValue = 2\n')
  const beforeContention = readFileSync(workerResult.graphPath, 'utf8')
  const releaseCompetingLease = packedStore.acquireIndexLease(join(workerRoot, 'out'))
  const childScript = `import { updateIndex } from ${JSON.stringify(pathToFileURL(packedUpdatePath).href)}; try { const result = updateIndex(${JSON.stringify(workerRoot)}); console.log(JSON.stringify({ mode: result.updateReceipt?.mode, buildId: result.buildId })) } catch (error) { console.log(JSON.stringify({ error: error?.name })) }`
  const runChild = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', childScript], { encoding: 'utf8' }).trim())
  const contended = runChild()
  if (contended.error !== 'IndexLeaseContentionError' || readFileSync(workerResult.graphPath, 'utf8') !== beforeContention) {
    throw new Error('Packed cross-process lease did not preserve the accepted graph under contention')
  }
  releaseCompetingLease()
  const reconciled = runChild()
  if (reconciled.mode !== 'cold_reconcile' || typeof reconciled.buildId !== 'string') {
    throw new Error('Packed cross-process lease did not permit one coherent successor')
  }

  const responsiveRoot = join(tempRoot, 'responsive-workspace')
  mkdirSync(responsiveRoot, { recursive: true })
  for (let index = 0; index < 300; index += 1) {
    writeFileSync(join(responsiveRoot, `file-${index}.ts`), `export const value${index} = ${index}\n`)
  }
  const responsiveGraph = await packedWatcher.updateIndexInWorker(responsiveRoot)
  writeFileSync(join(responsiveRoot, 'file-0.ts'), 'export const value0 = 999\n')
  const input = new PassThrough(), output = new PassThrough(), errorOutput = new PassThrough()
  let responseText = ''
  output.on('data', (chunk) => { responseText += chunk.toString('utf8') })
  const serverPromise = packedServer.serveGraphStdio({
    graphPath: responsiveGraph.graphPath, workspaceRoot: responsiveRoot, autoRefresh: true,
    autoRefreshDebounceSeconds: 0, autoRefreshRequestWaitMs: 30_000, input, output, errorOutput,
  })
  input.write(`${JSON.stringify({
    id: 701,
    method: 'tools/call',
    params: {
      name: 'retrieve',
      arguments: { question: 'What is value0?' },
    },
  })}\n`)
  input.write(`${JSON.stringify({ id: 702, method: 'ping' })}\n`)
  const pingDeadline = Date.now() + 5_000
  while (!responseText.includes('"id":702') && Date.now() < pingDeadline) await new Promise((done) => setTimeout(done, 10))
  if (!responseText.includes('"id":702') || responseText.includes('"id":701')) {
    throw new Error('Packed MCP stdio did not remain responsive during a worker reconcile')
  }
  input.end()
  await serverPromise
  const responses = responseText.trim().split(/\r?\n/).map((line) => JSON.parse(line))
  const retrieveResponse = responses.find((response) => response.id === 701)
  if (!retrieveResponse) {
    throw new Error('Packed MCP stdio dropped the queued retrieve request')
  }
  successfulRetrieve(retrieveResponse, 'Queued packed runtime', ['value0'])

  const crashRoot = join(tempRoot, 'crash-workspace')
  mkdirSync(crashRoot, { recursive: true })
  writeFileSync(join(crashRoot, 'main.ts'), 'export const crashValue = 1\n')
  writeFileSync(packedUpdatePath, [
    "import { join } from 'node:path'",
    "import { acquireIndexLease } from '../adapters/filesystem/index-store.js'",
    'export function updateIndex(rootPath = \'.\', options = {}) {',
    '  acquireIndexLease(join(rootPath, \'out\'), {}, options.leaseOwnerToken)',
    '  process.exit(17)',
    '}',
  ].join('\n'))
  let workerExited = false
  try { await packedWatcher.updateIndexInWorker(crashRoot) } catch { workerExited = true }
  if (!workerExited) throw new Error('Injected packed worker exit unexpectedly succeeded')
  const releaseAfterCrash = packedStore.acquireIndexLease(join(crashRoot, 'out'))
  releaseAfterCrash()

  console.log(`Packed retrieval parity passed for @lubab/madar ${checkoutVersion}.`)
  console.log(`Artifact runtime: ${relative(tempRoot, packedServerPath)}`)
} finally {
  if (previousToolProfile === undefined) delete process.env.MADAR_TOOL_PROFILE
  else process.env.MADAR_TOOL_PROFILE = previousToolProfile
  if (process.env.MADAR_KEEP_PACK_PARITY_ARTIFACTS !== '1') {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}
