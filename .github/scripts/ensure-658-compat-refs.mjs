#!/usr/bin/env node
/**
 * Makes the two pinned #658 historical commits available to the actual-byte
 * compatibility proof.
 *
 * That proof does not describe what a pre-#658 reader would have done; it
 * compiles and runs the reader that actually stood at `31ad2168`, and the
 * writer that actually stood at `580f59f6`, by reading their source with
 * `git show <commit>:<path>`. `actions/checkout` clones with `fetch-depth: 1`,
 * so neither commit is an object in the CI checkout and every history-dependent
 * control in that suite fails at the first `git show`.
 *
 * Skipping or soft-failing the suite would delete the guarantee exactly where
 * it matters, so the commits are fetched instead -- two exact objects, not the
 * repository's history. This mirrors `ensure-v0321-compat-ref.mjs`, which does
 * the same for the released tag the old-reader control needs.
 *
 * Identity is asserted rather than assumed at every step. A fetch that lands a
 * different commit, or a commit missing the entry paths the proof reads, fails
 * the lane instead of letting the suite prove something about other source.
 */
import { execFileSync } from 'node:child_process'

/**
 * The commits the compatibility proof pins, with the entry paths it reads from
 * each and the exact blob every entry must be. The suite walks the
 * relative-import closure from those entries, and a depth-1 commit fetch
 * carries that commit's complete tree, so verifying the entries is enough to
 * know the closure is resolvable.
 */
const PINNED = [
  {
    name: 'pre-658',
    commit: '31ad2168c442891096911871116072934e7ae0a6',
    ref: 'refs/madar-compat/658/pre-658',
    paths: [
      { path: 'src/contracts/graph-artifact.ts', blob: '65e6c41c2323bcc0afed7321f69c8ddb03695670' },
    ],
  },
  {
    name: 'pre-stage3',
    commit: '580f59f6e423a257807593d162849cba11676346',
    ref: 'refs/madar-compat/658/pre-stage3',
    paths: [
      { path: 'src/contracts/graph-artifact.ts', blob: '65e6c41c2323bcc0afed7321f69c8ddb03695670' },
      { path: 'src/pipeline/build.ts', blob: 'a34b666233203f2f9c2cfb00523f2afcab4f1aec' },
    ],
  },
]

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** True when the exact commit object is already present in this checkout. */
function commitPresent(commit) {
  try {
    git(['cat-file', '-e', `${commit}^{commit}`])
    return true
  } catch {
    return false
  }
}

function resolve(revision) {
  try {
    return git(['rev-parse', `${revision}^{commit}`])
  } catch {
    return null
  }
}

/** Resolves any object (here, a blob at a path) or null when it is absent. */
function resolveObject(revision) {
  try {
    return git(['rev-parse', revision])
  } catch {
    return null
  }
}

/**
 * Fetches exactly one commit into a private ref.
 *
 * `--depth=1` keeps this to the single commit and its tree rather than the
 * ancestry behind it, and the private ref keeps that object reachable so a
 * later `git gc` cannot reclaim what the proof is about to read.
 */
function fetchExactCommit(entry) {
  git(['fetch', '--no-tags', '--depth=1', 'origin', `+${entry.commit}:${entry.ref}`])
}

let failed = false

for (const entry of PINNED) {
  if (commitPresent(entry.commit)) {
    console.log(`${entry.name}: ${entry.commit} is already present in this checkout.`)
  } else {
    console.log(`${entry.name}: ${entry.commit} is absent; fetching the single pinned commit.`)
    try {
      fetchExactCommit(entry)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      console.error(`${entry.name}: failed to fetch ${entry.commit}: ${detail}`)
      failed = true
      continue
    }
  }

  // Resolve through the private ref when we created one, so this verifies what
  // the fetch actually landed rather than re-asserting the string we asked for.
  const resolved = resolve(entry.ref) ?? resolve(entry.commit)
  if (resolved === null) {
    console.error(`${entry.name}: ${entry.commit} is still unresolvable after fetching.`)
    failed = true
    continue
  }

  if (resolved !== entry.commit) {
    console.error(
      `${entry.name}: resolved to ${resolved}, expected ${entry.commit}. `
      + 'The compatibility proof executes an exact historical source closure; a ref '
      + 'pointing elsewhere invalidates it rather than merely inconveniencing it.',
    )
    failed = true
    continue
  }

  // Blob identity, not mere presence. Fetching by exact SHA makes "the ref
  // resolves to the SHA we asked for" tautological, so on its own it would
  // accept any substituted commit. Pinning the entry blobs makes the assertion
  // about content: `src/pipeline/build.ts` happens to be byte-identical at
  // `580f59f6` and at today's head, so a check that only asked whether the path
  // existed would have passed a substituted commit without noticing.
  let pathsOk = true
  for (const { path, blob } of entry.paths) {
    const resolvedBlob = resolveObject(`${entry.commit}:${path}`)
    if (resolvedBlob === null) {
      console.error(`${entry.name}: ${entry.commit} does not carry the required entry path ${path}.`)
      pathsOk = false
      failed = true
      continue
    }
    if (resolvedBlob !== blob) {
      console.error(
        `${entry.name}: ${entry.commit}:${path} is blob ${resolvedBlob}, expected ${blob}. `
        + 'The compatibility proof compiles and executes this exact historical source; '
        + 'different content means it would prove something about a different reader.',
      )
      pathsOk = false
      failed = true
    }
  }

  if (pathsOk) {
    const verified = entry.paths.map(({ path, blob }) => `${path}@${blob.slice(0, 12)}`).join(', ')
    console.log(`${entry.name}: ${entry.commit} verified, entry blobs match: ${verified}`)
  }
}

if (failed) {
  console.error('The pinned #658 compatibility commits could not be provisioned.')
  process.exit(1)
}

console.log('All pinned #658 compatibility commits are available and verified.')
