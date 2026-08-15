#!/usr/bin/env node
/**
 * Makes the pinned v0.32.1 tag available to the old-reader compatibility proof.
 *
 * `actions/checkout` clones with `fetch-depth: 1` and no tags, so
 * `git rev-parse v0.32.1` fails in CI and the proof that a released v0.32.1
 * loader rejects artifact v2 cannot run at all. Skipping the fixture would
 * delete the guarantee precisely where it matters most, so the tag is fetched
 * instead — one ref, not the full history.
 *
 * The expected tag object is asserted here as well as in the fixture. A tag
 * resolving anywhere else is a failure, not something to work around.
 */
import { execFileSync } from 'node:child_process'

const TAG = 'v0.32.1'
// The tag OBJECT sha, which is what the fixture pins and what `git rev-parse
// v0.32.1` returns for an annotated tag. The peeled commit is a different
// value (06b373a4…); asserting the wrong one here fails a correct checkout.
const EXPECTED_TAG_OBJECT = '60266f238a838d73303c20a1e8894ba47d1444d7'

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim()
}

function resolveTagObject() {
  try {
    return git(['rev-parse', TAG])
  } catch {
    return null
  }
}

let tagObject = resolveTagObject()

if (tagObject === null) {
  console.log(`${TAG} is absent from this checkout; fetching the single pinned ref.`)
  try {
    git(['fetch', '--no-tags', '--depth=1', 'origin', `refs/tags/${TAG}:refs/tags/${TAG}`])
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`Failed to fetch refs/tags/${TAG}: ${detail}`)
    process.exit(1)
  }
  tagObject = resolveTagObject()
}

if (tagObject === null) {
  console.error(`refs/tags/${TAG} is still unresolvable after fetching.`)
  process.exit(1)
}

if (tagObject !== EXPECTED_TAG_OBJECT) {
  console.error(
    `refs/tags/${TAG} resolves to ${tagObject}, expected ${EXPECTED_TAG_OBJECT}. `
    + 'The old-reader proof pins an exact released commit; a tag pointing elsewhere '
    + 'invalidates it rather than merely inconveniencing it.',
  )
  process.exit(1)
}

console.log(`${TAG} -> ${tagObject} (matches the pinned old-reader tag object).`)
