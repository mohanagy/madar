import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  inspectPackageContents,
  productionEvaluationLeaks,
  productionImportViolations,
  sourceInventory,
} from './record-baseline.mjs'

const scriptRoot = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptRoot, '..', '..', '..')
const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'))
const contract = JSON.parse(readFileSync(resolve(repositoryRoot, 'tools/eval/core-reset/contracts/evaluation-contract.json'), 'utf8'))
const buildConfig = JSON.parse(readFileSync(resolve(repositoryRoot, 'tsconfig.build.json'), 'utf8'))

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const inventory = sourceInventory()
const importViolations = productionImportViolations(inventory.paths)
const evaluationLeaks = productionEvaluationLeaks(inventory.paths, contract)
const packageMeasurement = inspectPackageContents()
const publishedRoots = new Set(packageJson.files ?? [])

assert(buildConfig.compilerOptions?.rootDir === 'src', 'tsconfig.build.json must keep rootDir at src')
assert(buildConfig.compilerOptions?.outDir === 'dist/src', 'tsconfig.build.json must keep outDir at dist/src')
assert(buildConfig.compilerOptions?.noEmitOnError === true, 'tsconfig.build.json must not emit after type errors')
assert((buildConfig.include ?? []).length === 1 && buildConfig.include[0] === 'src/**/*.ts', 'production build must include only src/**/*.ts')
assert(!publishedRoots.has('tools/') && !publishedRoots.has('docs/'), 'npm files allowlist must exclude tools and docs')
assert(importViolations.length === 0, `production imports evaluation evidence:\n${importViolations.join('\n')}`)
assert(evaluationLeaks.length === 0, `production embeds held-out evaluation data:\n${evaluationLeaks.join('\n')}`)
assert(packageMeasurement.forbidden_paths.length === 0, `npm package contains evaluation evidence:\n${packageMeasurement.forbidden_paths.join('\n')}`)
assert(packageMeasurement.forbidden_metadata.length === 0, `npm package metadata contains evaluation evidence:\n${packageMeasurement.forbidden_metadata.join('\n')}`)
assert(!existsSync(resolve(repositoryRoot, 'dist', 'tools')), 'build emitted dist/tools')
assert(!existsSync(resolve(repositoryRoot, 'dist', 'docs')), 'build emitted dist/docs')

process.stdout.write([
  'Core Reset isolation verified.',
  `- Production: ${inventory.files} TypeScript files / ${inventory.loc} LOC`,
  `- Package: ${packageMeasurement.file_count} files / ${packageMeasurement.unpacked_bytes} unpacked bytes`,
  '- Evaluation assets in package: 0',
  '- Evaluation commands or paths in package metadata: 0',
  '- Production imports from evaluation: 0',
  '- Held-out evaluation markers in production: 0',
].join('\n') + '\n')
