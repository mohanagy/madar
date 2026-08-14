'use strict'

/**
 * The single definition of "which paths does a truth file cite".
 *
 * It lives here, in CommonJS, because both consumers need it and they cannot share an
 * ESM module: `.github/scripts/validate-qualification-contract.mjs` is ESM, and
 * `tests/unit/qualification-contract.test.ts` is TypeScript compiled without `allowJs`,
 * so it reaches this file through `createRequire`. Node imports CommonJS from ESM
 * natively, so the validator can import it directly.
 *
 * Both consumers previously carried their own copy of this traversal, including the
 * `new_path` exemption. A change to the exemption in one copy would have left the other
 * enforcing the old rule, and the test would have stopped covering the shipped guard
 * while still passing.
 *
 * `new_path` is exempt because a plan task proposes creating files that do not exist at
 * the pinned commit, so they cannot appear in the target's frozen blob manifest.
 *
 * @param {unknown} node - any subtree of a parsed truth file
 * @returns {Set<string>} every value recorded under a `path` key, at any depth
 */
function collectCitedPaths(node) {
  const cited = new Set()

  const walk = (value) => {
    if (Array.isArray(value)) {
      value.forEach(walk)
      return
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (key === 'path' && typeof child === 'string') {
          cited.add(child)
        } else if (key !== 'new_path') {
          walk(child)
        }
      }
    }
  }

  walk(node)
  return cited
}

module.exports = { collectCitedPaths }
