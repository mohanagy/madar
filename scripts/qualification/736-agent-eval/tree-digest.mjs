import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const root = resolve(process.argv[2] ?? '.')
const entries = []

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
  const children = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => compareCodePoints(left.name, right.name))
  for (const child of children) {
    if (child.name === '.git') continue
    const absolute = resolve(directory, child.name)
    if (child.isDirectory()) {
      visit(absolute)
      continue
    }
    if (child.isFile() || child.isSymbolicLink()) entries.push(absolute)
  }
}

visit(root)
entries.sort((left, right) => compareCodePoints(relative(root, left), relative(root, right)))

const digest = createHash('sha256')
for (const entry of entries) {
  const path = relative(root, entry).replaceAll('\\', '/')
  const stat = lstatSync(entry)
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(entry)
    const targetDigest = createHash('sha256').update(target).digest('hex')
    digest.update(`${path}\u0000symlink\u0000${targetDigest}\n`)
    continue
  }
  const content = readFileSync(entry)
  const fileDigest = createHash('sha256').update(content).digest('hex')
  digest.update(`${path}\u0000file\u0000${stat.mode & 0o111 ? 'x' : '-'}\u0000${fileDigest}\n`)
}

process.stdout.write(`${digest.digest('hex')}\n`)
