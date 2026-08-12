import { assertAccountAccess, resolveRequestContext, type TokenDirectory } from '../auth/request-context.js'
import { UnknownEntryError, type LedgerService } from '../service/ledger-service.js'

export interface HttpRequest {
  method: string
  path: string
  headers: Record<string, string | undefined>
  params: Record<string, string>
  body: Record<string, unknown>
}

export interface HttpResponse {
  status: number
  body: Record<string, unknown>
}

export interface LedgerRouterDependencies {
  ledgerService: LedgerService
  tokenDirectory: TokenDirectory
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`field ${field} is required`)
  }
  return value
}

function requireNumber(body: Record<string, unknown>, field: string): number {
  const value = body[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`field ${field} is required`)
  }
  return value
}

export function createLedgerRouter(deps: LedgerRouterDependencies) {
  return {
    /** POST /accounts/:accountId/entries */
    postLedgerEntry(request: HttpRequest): HttpResponse {
      const context = resolveRequestContext(request.headers, deps.tokenDirectory)
      const accountId = request.params.accountId ?? ''

      assertAccountAccess(context.principal, accountId)

      const entry = deps.ledgerService.postEntry(context, {
        accountId,
        amountMinor: requireNumber(request.body, 'amountMinor'),
        currency: requireString(request.body, 'currency'),
        idempotencyKey: requireString(request.body, 'idempotencyKey'),
      })

      return { status: 201, body: { entry } }
    },

    /** POST /entries/:entryId/reversals */
    reverseLedgerEntry(request: HttpRequest): HttpResponse {
      const context = resolveRequestContext(request.headers, deps.tokenDirectory)
      const entryId = request.params.entryId ?? ''

      // seeded-reversal-authorization: unlike postLedgerEntry, this handler
      // never calls assertAccountAccess for the account that owns entryId, so
      // any authenticated principal can reverse another tenant's entry.
      try {
        const reversal = deps.ledgerService.reverseEntry(context, {
          entryId,
          idempotencyKey: requireString(request.body, 'idempotencyKey'),
        })
        return { status: 201, body: { entry: reversal } }
      } catch (error) {
        if (error instanceof UnknownEntryError) {
          return { status: 404, body: { error: error.message } }
        }
        throw error
      }
    },
  }
}
