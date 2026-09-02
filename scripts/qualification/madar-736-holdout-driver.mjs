import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const workspace = process.env.GITHUB_WORKSPACE
if (!workspace) throw new Error('GITHUB_WORKSPACE is required')

const moduleUrl = pathToFileURL(resolve(workspace, 'madar/dist/src/runtime/evidence-navigation.js')).href
const { EvidenceNavigator } = await import(moduleUrl)

const cases = [
  {
    id: 'H1',
    root: resolve(workspace, 'targets/nest'),
    anchor: 'BadRequestException',
    expectedPath: 'packages/common/exceptions/bad-request.exception.ts',
    expectedRevision: '24db9f733537903f373ba5e68260ce37ef259ce9',
  },
  {
    id: 'H2',
    root: resolve(workspace, 'targets/typeorm-h2'),
    anchor: 'coord_dimension',
    expectedPath: 'src/driver/postgres/PostgresQueryRunner.ts',
    expectedRevision: '8cf22582d32f9b33ff2f2f5ab5c5f98832ab0d84',
  },
  {
    id: 'H3',
    root: resolve(workspace, 'targets/typeorm-h3'),
    anchor: 'OrmUtils.normalizeWhereCriteria',
    expectedPath: 'src/util/OrmUtils.ts',
    expectedRevision: '30f9fc717bcfaa472d56680437105a6b9581014d',
  },
]

const results = []
let failed = false
for (const testCase of cases) {
  const navigator = new EvidenceNavigator({ rootDir: testCase.root })
  const repetitions = [
    navigator.resolveAnchor(testCase.anchor),
    navigator.resolveAnchor(testCase.anchor),
    navigator.resolveAnchor(testCase.anchor),
  ]
  const digests = repetitions.map((result) => result.digest)
  const first = repetitions[0]
  const paths = first.evidence.map((item) => item.path)
  const deterministic = new Set(digests).size === 1
  const pass = deterministic
    && !['unresolved', 'unsupported'].includes(first.resolution)
    && first.repository_revision === testCase.expectedRevision
    && paths.includes(testCase.expectedPath)
  results.push({
    id: testCase.id,
    anchor: testCase.anchor,
    expected_path: testCase.expectedPath,
    expected_revision: testCase.expectedRevision,
    pass,
    deterministic,
    resolution: first.resolution,
    provider: first.provider,
    repository_revision: first.repository_revision,
    config_path: first.project.config_path,
    paths,
    digests,
  })
  if (!pass) failed = true
}

const payload = {
  schema_version: 1,
  madar_issue: 736,
  candidate: '736fe89603822a3003da11cfa2cc96983af8f30b',
  locale: process.env.LC_ALL ?? process.env.LANG ?? 'unknown',
  passed: results.filter((result) => result.pass).length,
  total: results.length,
  results,
}

if (process.env.OUTPUT_FILE) {
  writeFileSync(process.env.OUTPUT_FILE, `${JSON.stringify(payload, null, 2)}\n`)
}
console.log(JSON.stringify(payload, null, 2))
if (failed) process.exit(1)
