import { resolve } from 'node:path'

import { loadGraphArtifact } from '../../dist/src/adapters/filesystem/graph-artifact.js'
import { loadBenchmarkQuestions } from '../../dist-eval/tools/eval/lib/infrastructure/benchmark/questions.js'
import {
  evaluateRetrievalQuality,
  formatQualityReport,
} from '../../dist-eval/tools/eval/lib/infrastructure/benchmark/quality.js'
import { resolveMadarWorkspace } from '../../dist/src/shared/workspace.js'

const demoRoot = resolve('examples/demo-repo')
const graphPath = resolveMadarWorkspace(demoRoot).graphPath
const questionsPath = resolve('examples/demo-repo/benchmark-questions.v3.json')
const execTemplate = [
  'node .github/scripts/ci-prompt-runner.mjs',
  '--prompt {prompt_file}',
  '--output {output_file}',
  '--question {question}',
  '--mode {mode}',
].join(' ')

const report = await evaluateRetrievalQuality(
  loadGraphArtifact(graphPath),
  loadBenchmarkQuestions(questionsPath),
  3000,
  { graphPath, execTemplate },
)
process.stdout.write(`${formatQualityReport(report)}\n`)

const recall = report.avg_recall * 100
const snippetCoverage = report.avg_snippet_coverage * 100
if (recall < 90 || report.mrr < 0.95 || snippetCoverage < 95) {
  throw new Error(
    `eval thresholds failed: recall=${recall}, mrr=${report.mrr}, `
    + `snippet_coverage=${snippetCoverage}`,
  )
}
process.stdout.write(
  `::notice title=Eval grounded match rate::${(report.avg_grounded_match_rate * 100).toFixed(1)}% (report-only for now)\n`,
)
