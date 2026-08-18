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

/**
 * Builds the parity workspace by generating, not by hand-writing an artifact.
 *
 * The primary proof has to run against what Madar actually publishes. A
 * hand-written v1 fixture qualified the packed package against a format the
 * cutover no longer produces, so the gate could pass while canonical
 * generation was broken. The legacy shape is still covered separately below.
 */
function createParityGraph(root, cliPath) {
  const sourceRoot = join(root, 'workspace')
  mkdirSync(join(sourceRoot, 'out'), { recursive: true })
  const files = {
    route: join(sourceRoot, 'route.ts'),
    analytics: join(sourceRoot, 'analytics.ts'),
    redirect: join(sourceRoot, 'redirect.ts'),
  }
  writeFileSync(files.route, 'export function handleClick() { trackClick(); redirectToDestination() }\n')
  writeFileSync(files.analytics, 'export function trackClick() {}\n')
  writeFileSync(files.redirect, 'export function redirectToDestination() {}\n')
  execFileSync(process.execPath, [cliPath, 'generate', '.', '--no-html'], {
    cwd: sourceRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const canonicalPath = join(sourceRoot, 'out', 'graph.madar')
  if (!existsSync(canonicalPath)) {
    throw new Error('Parity generation did not publish out/graph.madar')
  }
  const header = readFileSync(canonicalPath, 'utf8').slice(0, 23)
  if (header !== 'MADAR_GRAPH_ARTIFACT/2\n') {
    throw new Error(`Parity artifact is not a v2 artifact: ${JSON.stringify(header)}`)
  }
  const tombstone = readFileSync(join(sourceRoot, 'out', 'graph.json'), 'utf8')
  if (tombstone !== EXPECTED_TOMBSTONE) {
    throw new Error('Parity workspace did not leave the exact tombstone at out/graph.json')
  }
  return canonicalPath
}

const EXPECTED_TOMBSTONE = [
  'MADAR_GRAPH_MOVED/2',
  'Use out/graph.madar with Madar >= the v2-supporting version.',
  '',
].join('\n')

/** Fields that legitimately differ between two runs of the same code. */
const NON_PARITY_FIELDS = new Set(['checked_at', 'generated_at', 'elapsed_ms'])

function normalizedResponse(response) {
  // elapsed_ms joined this list when the gate started running against a real
  // generated graph: retrieval over an actual artifact takes measurable and
  // varying time, so comparing it made the gate a stopwatch race rather than a
  // parity check. The hand-written fixture was small enough to hide that.
  const stripTimings = (value) => JSON.parse(JSON.stringify(value, (key, inner) =>
    NON_PARITY_FIELDS.has(key) ? undefined : inner))

  const normalized = stripTimings(response)
  // Retrieval payloads travel as a JSON string inside the response text, so the
  // timings inside them have to be stripped too.
  for (const entry of normalized?.result?.content ?? []) {
    if (typeof entry?.text !== 'string') continue
    try {
      entry.text = JSON.stringify(stripTimings(JSON.parse(entry.text)))
    } catch {
      // Not JSON; compared verbatim.
    }
  }
  return normalized
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
  for (const path of [checkoutServerPath, packedServerPath, checkoutMetadataPath, packedMetadataPath]) {
    if (!existsSync(path)) throw new Error(`Missing parity runtime module: ${path}`)
  }

  const [checkoutServer, packedServer, checkoutMetadata, packedMetadata] = await Promise.all([
    import(`${pathToFileURL(checkoutServerPath).href}?parity=checkout`),
    import(`${pathToFileURL(packedServerPath).href}?parity=packed`),
    import(`${pathToFileURL(checkoutMetadataPath).href}?parity=checkout`),
    import(`${pathToFileURL(packedMetadataPath).href}?parity=packed`),
  ])
  const checkoutVersion = checkoutMetadata.readPackageVersion(repositoryRoot)
  const packedVersion = packedMetadata.readPackageVersion(packedRoot)
  if (checkoutVersion !== packedVersion) {
    throw new Error(`Package version mismatch: checkout=${checkoutVersion} packed=${packedVersion}`)
  }

  process.env.MADAR_TOOL_PROFILE = 'full'
  const graphPath = createParityGraph(tempRoot, join(repositoryRoot, 'dist', 'src', 'cli', 'bin.js'))
  const prompt = 'How does Dub resolve a short-link click from request handling through analytics tracking and destination redirect?'
  const request = {
    jsonrpc: '2.0',
    id: 551,
    method: 'tools/call',
    params: {
      name: 'retrieve',
      arguments: {
        question: prompt,
        budget: 1200,
        retrieval_strategy: 'slice-v1',
        verbose: true,
      },
    },
  }
  const checkoutResponse = await Promise.resolve(checkoutServer.handleStdioRequest(graphPath, request))
  const packedResponse = await Promise.resolve(packedServer.handleStdioRequest(graphPath, request))
  const normalizedCheckout = normalizedResponse(checkoutResponse)
  const normalizedPacked = normalizedResponse(packedResponse)
  if (JSON.stringify(normalizedCheckout) !== JSON.stringify(normalizedPacked)) {
    writeFileSync(join(tempRoot, 'checkout-response.json'), JSON.stringify(normalizedCheckout, null, 2))
    writeFileSync(join(tempRoot, 'packed-response.json'), JSON.stringify(normalizedPacked, null, 2))
    throw new Error(`Packed retrieval differs from checkout retrieval; inspect ${tempRoot}`)
  }

  console.log(`Packed retrieval parity passed for @lubab/madar ${checkoutVersion}.`)
  console.log(`Artifact runtime: ${relative(tempRoot, packedServerPath)}`)
} finally {
  if (previousToolProfile === undefined) delete process.env.MADAR_TOOL_PROFILE
  else process.env.MADAR_TOOL_PROFILE = previousToolProfile
  if (process.env.MADAR_KEEP_PACK_PARITY_ARTIFACTS !== '1') {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}
