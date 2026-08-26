import { readFileSync } from 'node:fs'
import { dirname, posix, relative, resolve } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Guards the decision that cannot be re-derived from types: which sorts write
 * persisted bytes and therefore must not consult the host's collation.
 *
 * Two of the sites this file pins have **no behavioural coverage, because none
 * is possible**: `extraction_strategy` and `fallback_reason` are closed
 * lowercase-ASCII sets that `parseIndexingManifest` validates on the way in, and
 * an exhaustive search over every locale this build collates finds no pair whose
 * collation order differs from code-point order. `fallback_reason` has a single
 * member, so it cannot have a pair at all. For those two this audit is the only
 * coverage, and saying so is the point.
 *
 * `reason` used to be listed here too, on a sweep of six hand-picked locales.
 * That was wrong: `az-AZ` reverses `empty_extraction` against `extractor_error`,
 * because Azerbaijani places `x` between `h` and `ı`. It now has a real
 * behavioural control, and the classification of all three domains is derived by
 * search in `persisted-ordering-locale-determinism.test.ts` rather than asserted
 * here.
 *
 * It also catches what a byte-comparison cannot. Shadowing the imported
 * comparator with a local definition of the same name is legal TypeScript and
 * leaves every call site looking correct, so the binding is checked, not just
 * the spelling.
 *
 * Ordering meant for human reading stays locale-sensitive. The display sites
 * below are asserted to carry a comment saying so, so that "why is this one
 * different?" has an answer in the file rather than in a review thread.
 */

const SRC = resolve(process.cwd(), 'src')
const OWNER = 'src/contracts/canonical-json.ts'
const DISPLAY_MARKER = 'Display ordering:'

/**
 * Every production site that must order by code point, with the number of
 * comparator calls it should contain. Adding a row is a reviewed decision; the
 * counts stop a site from quietly losing its comparator while the file keeps one.
 */
const MUST_USE_CODE_POINTS = new Map<string, number>([
  // outcomes (1, two keys), the four summary buckets (4), spi_diagnostics (1)
  ['src/pipeline/indexing-outcomes.ts', 7],
  // dedupePaths -> graph_build_freshness.git.dirty_files -> graph.madar
  ['src/shared/git.ts', 1],
  // the overlay's from|to|kind key, the same key family the SPI itself orders
  ['src/pipeline/spi/diff-overlay.ts', 1],
  // compare-summary discovery order in proof-report.md
  ['src/infrastructure/proof-report.ts', 1],
])

/**
 * Sites whose ordering is presentation, with the number of annotations each
 * should carry. These are deliberately left locale-sensitive.
 */
const DISPLAY_SITES = new Map<string, number>([
  ['src/shared/telemetry.ts', 1],
  ['src/infrastructure/compare.ts', 1],
  ['src/pipeline/wiki.ts', 1],
  ['src/pipeline/export.ts', 1],
  ['src/pipeline/export/community-summary.ts', 1],
  ['src/pipeline/export/overview-navigation.ts', 1],
])

function sourceFileFor(relativePath: string): ts.SourceFile {
  const absolute = resolve(process.cwd(), relativePath)
  return ts.createSourceFile(absolute, readFileSync(absolute, 'utf8'), ts.ScriptTarget.Latest, true)
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}

/** Every `x.localeCompare(...)` in the file, as `line:text`. */
function localeCompareCalls(source: ts.SourceFile): string[] {
  const found: string[] = []
  walk(source, (node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'localeCompare') {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
      found.push(`${line + 1}: ${node.getText(source).slice(0, 80)}`)
    }
  })
  return found
}

/**
 * Every use of the comparator, counting both forms the codebase uses: called
 * with two keys, `compareUnicodeCodePoints(a.path, b.path)`, and passed by
 * reference, `.sort(compareUnicodeCodePoints)`. Counting only calls would report
 * zero for a file that orders correctly by reference.
 */
function comparatorUses(source: ts.SourceFile): ts.Identifier[] {
  const found: ts.Identifier[] = []
  walk(source, (node) => {
    if (!ts.isIdentifier(node) || node.text !== 'compareUnicodeCodePoints') return
    if (ts.isImportSpecifier(node.parent)) return
    found.push(node)
  })
  return found
}

/**
 * Every binding of the name, split into the import that should exist and any
 * other declaration, which is what a shadowing mutation would add.
 */
function comparatorBindings(source: ts.SourceFile): { imports: ts.ImportDeclaration[]; others: string[] } {
  const imports: ts.ImportDeclaration[] = []
  const others: string[] = []
  walk(source, (node) => {
    if (ts.isImportSpecifier(node) && node.name.text === 'compareUnicodeCodePoints') {
      const declaration = node.parent.parent.parent
      if (ts.isImportDeclaration(declaration)) imports.push(declaration)
      return
    }
    const named = (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)
      || ts.isParameter(node) || ts.isBindingElement(node) || ts.isClassDeclaration(node))
      && node.name !== undefined && ts.isIdentifier(node.name)
      && node.name.text === 'compareUnicodeCodePoints'
    if (named) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
      others.push(`${relative(process.cwd(), source.fileName)}:${line + 1}`)
    }
  })
  return { imports, others }
}

/** Resolves an import declaration's specifier to a repo-relative `.ts` path. */
function resolvedSpecifier(source: ts.SourceFile, declaration: ts.ImportDeclaration): string {
  const specifier = (declaration.moduleSpecifier as ts.StringLiteral).text
  const fromDir = posix.dirname(relative(process.cwd(), source.fileName).split('\\').join('/'))
  return posix.normalize(posix.join(fromDir, specifier)).replace(/\.js$/, '.ts')
}

describe('persisted ordering call sites', () => {
  it('guards a non-empty set of sites', () => {
    // A guard over an empty set passes forever while guarding nothing.
    expect(MUST_USE_CODE_POINTS.size).toBeGreaterThan(0)
    expect(DISPLAY_SITES.size).toBeGreaterThan(0)
    expect(SRC).toContain('src')
  })

  for (const [file, expectedCalls] of MUST_USE_CODE_POINTS) {
    describe(file, () => {
      it('consults no host collation', () => {
        const offenders = localeCompareCalls(sourceFileFor(file))
        expect(
          offenders,
          `${file} orders with localeCompare, which answers according to the host's ICU `
          + 'locale, so two machines write different bytes for the same inputs. Use '
          + `compareUnicodeCodePoints from ${OWNER}.`,
        ).toEqual([])
      })

      it('orders through the single comparator owner, the expected number of times', () => {
        const uses = comparatorUses(sourceFileFor(file))
        // Not "the identifier appears somewhere": the import specifier is excluded,
        // and the count stops one site from silently losing its comparator while
        // the file still has others.
        expect(uses.length, `${file}: expected ${expectedCalls} comparator uses`).toBe(expectedCalls)
      })

      it('binds the comparator only by importing it from the owner', () => {
        const source = sourceFileFor(file)
        const { imports, others } = comparatorBindings(source)
        expect(
          others,
          `${file} declares compareUnicodeCodePoints locally. That is legal TypeScript and `
          + 'shadows the import, so every call site still reads correctly while the ordering '
          + 'silently changes.',
        ).toEqual([])
        expect(imports, `${file}: expected exactly one import of the comparator`).toHaveLength(1)
        expect(resolvedSpecifier(source, imports[0] as ts.ImportDeclaration)).toBe(OWNER)
      })

      it('passes no hand-rolled comparator to sort', () => {
        const source = sourceFileFor(file)
        const offenders: string[] = []
        walk(source, (node) => {
          if (!ts.isCallExpression(node)) return
          if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'sort') return
          const comparator = node.arguments[0]
          // A bare `.sort()` is UTF-16 code-unit order: already host-independent,
          // and used deliberately elsewhere in these files. Only a supplied
          // comparator has to route through the owner.
          if (comparator === undefined) return
          if (ts.isIdentifier(comparator) && comparator.text === 'compareUnicodeCodePoints') return
          const usesOwner = comparatorUses(source).some(
            (use) => use.getStart(source) >= comparator.getStart(source)
              && use.getEnd() <= comparator.getEnd(),
          )
          if (!usesOwner) {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
            offenders.push(`${file}:${line + 1}`)
          }
        })
        expect(
          offenders,
          'these sorts supply a comparator that never reaches compareUnicodeCodePoints',
        ).toEqual([])
      })
    })
  }

  for (const [file, expectedAnnotations] of DISPLAY_SITES) {
    it(`${file} says in the file why its ordering stays locale-sensitive`, () => {
      const text = readFileSync(resolve(process.cwd(), file), 'utf8')
      const found = text.split(DISPLAY_MARKER).length - 1
      expect(
        found,
        `${file} should carry ${expectedAnnotations} "${DISPLAY_MARKER}" annotation(s). `
        + 'Without it the next reader cannot tell a deliberate display sort from one that '
        + 'was missed.',
      ).toBe(expectedAnnotations)
      // And the annotation is only honest if the file really does still use it.
      expect(localeCompareCalls(sourceFileFor(file)).length, `${file}: annotated but no display sort left`)
        .toBeGreaterThan(0)
    })
  }

  it('leaves the comparator owner untouched by this policy', () => {
    // The owner defines the comparator; it must not be edited to satisfy the audit.
    const source = sourceFileFor(OWNER)
    expect(localeCompareCalls(source), `${OWNER} must not call localeCompare`).toEqual([])
    void dirname
  })
})
