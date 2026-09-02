import { readFileSync } from 'node:fs'

const leftPath = process.env.C_RESULT
const rightPath = process.env.CUTF8_RESULT
if (!leftPath || !rightPath) throw new Error('C_RESULT and CUTF8_RESULT are required')

const left = JSON.parse(readFileSync(leftPath, 'utf8'))
const right = JSON.parse(readFileSync(rightPath, 'utf8'))
if (left.total !== 3 || right.total !== 3 || left.passed !== 3 || right.passed !== 3) {
  throw new Error(`holdout anchor gate not 3/3 in both locales: C=${left.passed}/${left.total}, C.UTF-8=${right.passed}/${right.total}`)
}
for (let index = 0; index < left.results.length; index += 1) {
  const a = left.results[index]
  const b = right.results[index]
  if (a.id !== b.id) throw new Error(`case ordering mismatch at ${index}`)
  if (a.digests.some((digest) => digest !== a.digests[0])) throw new Error(`${a.id} is not deterministic in C locale`)
  if (b.digests.some((digest) => digest !== b.digests[0])) throw new Error(`${b.id} is not deterministic in C.UTF-8 locale`)
  if (a.digests[0] !== b.digests[0]) throw new Error(`${a.id} digest differs across locales`)
}
console.log(JSON.stringify({
  schema_version: 1,
  passed: 3,
  total: 3,
  locales: [left.locale, right.locale],
  digests: Object.fromEntries(left.results.map((result) => [result.id, result.digests[0]])),
}, null, 2))
