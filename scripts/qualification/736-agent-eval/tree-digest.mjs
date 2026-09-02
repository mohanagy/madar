import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const root = resolve(process.argv[2] ?? '.')
const files = []

function compareCodePoints(left, right) {
  const a = Array.from(left, (value) => value.codePointAt(0) ?? 0)
  const b = Array.from(right, (value) => value.codePointAt(0) ?? 0)
  const limit = Math.min(a.length, b.length)
  for (let index = 0; index < limit; index += 1) {
    if (a[index] < b[index]) return -1
    if (a[index] > b[index]) return 1
  }
  return a.length - b.length
}

function visit(directory) {
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => compareCodePoints(left.name, right.name))
  for (const entry of entries) {
    if (entry.name === '.git') continue
    const absolute = resolve(directory, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      visit(absolute)
      continue
    }
    if (entry.isFile()) files.push(absolute)
  }
}

visit(root)
files.sort((left, right) => compareCodePoints(relative(root, left), relative(root, right)))

const digest = createHash('sha256')
for (const file of files) {
  const path = relative(root, file).replaceAll('\\', '/')
  const stat = statSync(file)
  const content = readFileSync(file)
  const fileDigest = createHash('sha256').update(content).digest('hex')
  digest.update(`${path}\u0000${stat.mode & 0o111 ? 'x' : '-'}\u0000${fileDigest}\n`)
}

process.stdout.write(`${digest.digest('hex')}\n`)
