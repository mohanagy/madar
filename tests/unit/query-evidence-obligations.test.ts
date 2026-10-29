import { describe, expect, it } from 'vitest'
import {
  evaluateQueryEvidenceCoverage,
  queryEvidenceObligations,
} from '../../src/runtime/retrieve/conceptual-fallback.js'

const orderQuestion = 'How do pageOrders in orders/page.mjs, the ordering helpers in orders/order.mjs, and the cursor helpers in orders/cursor.mjs implement sorting, status filtering, after boundaries, and nextCursor, and which local tests cover them?'
const inventoryQuestion = 'How do availableStock(stock, events, now) in inventory/availability.mjs and reservation helpers in inventory/reservations.mjs select and sum active reservations, and what dependencies and local tests cover these exported APIs?'

describe('query evidence prose boundaries', () => {
  it('keeps a marked spaced member intact without swallowing the next sentence', () => {
    expect(queryEvidenceObligations('Trace AuthService . login(value) and its dependencies.')).toHaveLength(1)
    expect(queryEvidenceObligations('Explain processTicket. Then inspect retry delays.')).toHaveLength(2)
  })

  it('keeps dot path segments in one obligation while retaining sentence boundaries', () => {
    for (const path of ['./src/worker.ts', 'src/../src/worker.ts', './src/../src/worker.ts', '"./src/worker.ts"']) {
      expect(queryEvidenceObligations(`Show ${path}`), path).toHaveLength(1)
      expect(queryEvidenceObligations(`Show ${path}. Inspect local tests.`), path).toHaveLength(2)
    }
    expect(queryEvidenceObligations('Explain retries. Inspect local tests.')).toHaveLength(2)
    expect(queryEvidenceObligations('Explain retries... Inspect local tests.')).toHaveLength(2)
  })

  it('separates interrogative clauses without splitting literals, noun lists, or possessives', () => {
    expect(queryEvidenceObligations('Explain `perform` and how retries are scheduled.')).toHaveLength(2)
    expect(queryEvidenceObligations('Explain `perform` inputs and outputs.')).toHaveLength(1)
    expect(queryEvidenceObligations('Where is "ready and how next" defined?')).toHaveLength(1)
    expect(queryEvidenceObligations("Explain `start` and how retry's delay works and how reset's state is restored.")).toHaveLength(3)
  })

  it('keeps authentication evidence from satisfying a separate POST proof question', () => {
    const question = 'What authentication is required? Explain what a successful POST response proves! Inspect persistence errors.'
    const obligations = queryEvidenceObligations(question)
    expect(obligations).toHaveLength(3)
    expect(obligations[0]?.terms).toEqual(['authentication', 'required'])
    expect(obligations[1]?.terms).toEqual(expect.arrayContaining(['successful', 'post', 'response']))
    const coverage = evaluateQueryEvidenceCoverage(question, [{
      label: 'requireAuthentication', source_file: 'auth.ts',
      snippet: 'const authentication = "required";',
    }])
    expect(coverage.covered_obligations).toEqual(['query:obligation:1'])
    expect(coverage.missing_obligations).toContain('query:obligation:2')
  })

  it('requires a locally named subject for outcome and failure evidence without guessing the preceding topic', () => {
    const cases = [{
      prefix: 'Trace refund issuance.', generic: 'Explain what a successful POST response proves.',
      named: 'Explain what a successful refund POST response proves.',
      context: { label: 'issueRefund', source_file: 'refund.ts', snippet: 'function issueRefund() { return refund.issuance; }' },
      wrong: { label: 'POST', source_file: 'session.ts', snippet: 'function POST() { const renewal = session; return Response.json(renewal); }' },
      right: { label: 'POST', source_file: 'refund.ts', snippet: 'function POST() { return Response.json(refund.issuance); }' },
    }, {
      prefix: 'Trace invoice export.', generic: 'How are failures handled?', named: 'How are invoice export failures handled?',
      context: { label: 'invoiceExport', source_file: 'export.ts', snippet: 'function invoiceExport() { return invoice.export; }' },
      wrong: { label: 'uploadFailure', source_file: 'upload.ts', snippet: 'function uploadFailure(error) { const handled = error; return { upload: true, handled }; }' },
      right: { label: 'invoiceExport', source_file: 'export.ts', snippet: 'function invoiceExport(error) { const handled = error; return { invoice, export: true, handled }; }' },
    }]
    for (const entry of cases) {
      for (const suffix of [entry.generic, entry.named]) {
        expect(evaluateQueryEvidenceCoverage(`${entry.prefix} ${suffix}`, [entry.context, entry.wrong]).missing_obligations).toContain('query:obligation:2')
      }
      expect(evaluateQueryEvidenceCoverage(`${entry.prefix} ${entry.generic}`, [entry.context, entry.right]).missing_obligations).toContain('query:obligation:2')
      expect(evaluateQueryEvidenceCoverage(`${entry.prefix} ${entry.named}`, [entry.context, entry.right]).covered_obligations).toContain('query:obligation:2')
    }
    expect(evaluateQueryEvidenceCoverage('Trace invoice export and how are failures handled?', [cases[1]!.context, cases[1]!.wrong]).missing_obligations).toContain('query:obligation:2')
    expect(evaluateQueryEvidenceCoverage('Trace refund issuance. Separately explain successful session renewal.', [cases[0]!.context, cases[0]!.wrong]).covered).toBe(2)
    expect(evaluateQueryEvidenceCoverage('Trace invoice export. How are upload failures handled?', [cases[1]!.context, cases[1]!.wrong]).covered).toBe(2)
  })

  it('requires exact local subject tokens or explicit owner identity and leaves quoted question data unchanged', () => {
    const generic = { label: 'POST', source_file: 'session.ts', snippet: 'function POST() { return Response.json({ send: true, refundable: true }); }' }
    for (const subject of ['delivery', 'refund', 'operation', 'alpha beta gamma delta epsilon zeta eta']) {
      expect(evaluateQueryEvidenceCoverage(`What does a successful ${subject} POST response prove?`, [generic]).covered).toBe(0)
    }
    for (const symbol of ['Refund.submit', 'Refund . submit']) {
      const symbolQuestion = `What does a successful \`${symbol}\` POST response prove?`
      expect(evaluateQueryEvidenceCoverage(symbolQuestion, [generic]).covered).toBe(0)
      expect(evaluateQueryEvidenceCoverage(symbolQuestion, [{ ...generic, label: 'Refund.submit' }]).covered).toBe(1)
    }
    const pathQuestion = 'What does a successful `src/refund.ts` POST response prove?'
    expect(evaluateQueryEvidenceCoverage(pathQuestion, [generic]).covered).toBe(0)
    expect(evaluateQueryEvidenceCoverage(pathQuestion, [{ ...generic, source_file: '/repo/src/refund.ts' }]).covered).toBe(1)
    expect(evaluateQueryEvidenceCoverage('"Explain what a successful POST response proves"', [generic]).covered).toBe(1)
  })

  it.each(['"ready? continue!"', "'ready? continue!'", '`ready? continue!`',
    'select(ready ? continueValue : idle, marker! + offset)',
    '~~~text\nready? continue!\n~~~', '```text\nready? continue!\n```'])('does not split question punctuation inside prompt data: %s', literal => {
    const obligations = queryEvidenceObligations(`Explain the marker\n${literal}\n? Inspect retries! Inspect credentials.`)
    expect(obligations).toHaveLength(3)
    expect(obligations[0]?.terms).toContain('continue')
    expect(obligations[1]?.terms).toEqual(['inspect', 'retries'])
    expect(obligations[2]?.terms).toEqual(['inspect', 'credentials'])
  })

  it.each(['happen', 'happens', 'happened', 'happening'])('keeps %s to its object and retains the later capacity request within eight obligations', verb => {
    const question = `A profile has resource, resource-template, and prompt continuation cursors; an upstream resource-list-changed notification arrives while a prompt listing is in flight. Explain which routes/cursors remain usable and what ${verb} to stale discovery results. Assess the behavioral impact of replacing resource-specific invalidation with full profile invalidation. Include cursor capacity/reuse and wrong-profile behavior.`
    const obligations = queryEvidenceObligations(question)
    expect(obligations).toHaveLength(8)
    expect(obligations.some(({ terms }) => terms.length === 1 && terms[0] === verb)).toBe(false)
    expect(obligations.at(-1)?.terms).toEqual(expect.arrayContaining(['cursor', 'capacity', 'reuse', 'wrong', 'profile']))
    expect(obligations.every(({ terms }) => terms.length <= 6)).toBe(true)
  })

  it('preserves file identifiers and the separate trailing test obligation in the observed order query', () => {
    const obligations = queryEvidenceObligations(orderQuestion)
    expect(obligations.some(({ terms }) => terms.length === 1 && terms[0] === 'mjs')).toBe(false)
    for (const term of ['ordering', 'sorting', 'filtering', 'boundaries', 'next', 'tests']) {
      expect(obligations.some(({ terms }) => terms.includes(term)), term).toBe(true)
    }
    expect(obligations.find(({ terms }) => terms.includes('tests'))?.terms).not.toContain('next')
    expect(obligations.length).toBeLessThanOrEqual(8)
  })

  it('does not spend obligation slots on individual call parameters', () => {
    const obligations = queryEvidenceObligations(inventoryQuestion)
    expect(obligations.some(({ terms }) => terms.includes('tests'))).toBe(true)
    expect(obligations.some(({ terms }) => terms.length === 1 && ['stock', 'events', 'mjs'].includes(terms[0]!))).toBe(false)
    expect(obligations[0]?.terms).toEqual(expect.arrayContaining(['stock', 'events']))
  })

  it.each([orderQuestion, inventoryQuestion])('keeps missing local tests missing when only implementation source is supplied: %s', question => {
    const obligations = queryEvidenceObligations(question)
    const testObligation = obligations.find(({ terms }) => terms.includes('tests'))!
    expect(testObligation).toBeDefined()
    const coverage = evaluateQueryEvidenceCoverage(question, [{
      label: 'pageOrders availableStock nextCursor',
      source_file: 'orders/page.mjs',
      snippet: 'export function pageOrders(orders, options) { const cursor = options.after; return { items: orders.filter(order => order.status === options.status), nextCursor: cursor }; }\nexport function availableStock(stock, events, now) { return stock.map(item => ({ sku: item.sku, available: item.quantity - events.length })); }',
    }])
    expect(coverage.missing_obligations).toContain(`query:obligation:${testObligation.index + 1}`)
    expect(coverage.covered_obligations).not.toContain(`query:obligation:${testObligation.index + 1}`)
  })

  it('preserves quoted paths and inline code while keeping sentence and flow boundaries', () => {
    const obligations = queryEvidenceObligations('Explain "src/then.worker.ts" and `AuthService.login(user, token)`. Then dispatch the receipt, and inspect local tests.')
    expect(obligations[0]?.terms).toEqual(expect.arrayContaining(['src', 'worker', 'auth', 'service', 'login']))
    expect(obligations.some(({ terms }) => terms.length === 1 && ['ts', 'token'].includes(terms[0]!))).toBe(false)
    expect(obligations.some(({ terms }) => terms.includes('receipt'))).toBe(true)
    expect(obligations.at(-1)?.terms).toContain('tests')
  })

  it('protects nested argument commas without swallowing subsequent prose', () => {
    const obligations = queryEvidenceObligations('Explain buildReceipt(entries, transform(value, mode), "a,b"); then send the receipt. Inspect local tests.')
    expect(obligations[0]?.terms).toEqual(expect.arrayContaining(['receipt', 'entries', 'transform', 'value', 'mode']))
    expect(obligations.some(({ terms }) => terms.length === 1 && ['value', 'mode'].includes(terms[0]!))).toBe(false)
    expect(obligations[1]?.terms).toContain('@delivery')
    expect(obligations.at(-1)?.terms).toContain('tests')
  })

  it('retains ordinary punctuation and natural flow clauses', () => {
    const obligations = queryEvidenceObligations('Trace how accepted work becomes a record, then sends a receipt. Inspect local tests; compare failure behavior.')
    expect(obligations[0]?.terms).toContain('accepted')
    expect(obligations.some(({ terms }) => terms.includes('@transition'))).toBe(true)
    expect(obligations.some(({ terms }) => terms.includes('@delivery'))).toBe(true)
    expect(obligations.some(({ terms }) => terms.includes('tests'))).toBe(true)
    expect(obligations.at(-1)?.terms).toContain('@failure')
  })

  it.each(['reach', 'reaches', 'reached'])('does not let a quoted symbol satisfy unsupported behavior after %s', verb => {
    const question = `Trace how \`AuthController.login\` ${verb} persistence in the backend runtime pipeline`
    const obligations = queryEvidenceObligations(question)
    expect(obligations).toHaveLength(2)
    expect(obligations[0]?.terms).toEqual(['auth', 'controller', 'login'])
    expect(obligations[1]?.terms).toContain('persistence')
    const coverage = evaluateQueryEvidenceCoverage(question, [{
      label: 'AuthController.login',
      source_file: 'controller.ts',
      snippet: 'export class AuthController { login() {} }',
    }])
    expect(coverage.covered_obligations).toEqual(['query:obligation:1'])
    expect(coverage.missing_obligations).toEqual(['query:obligation:2'])
  })
})
