export interface Principal {
  principalId: string
  accountIds: string[]
  scopes: string[]
}

export interface RequestContext {
  requestId: string
  principal: Principal
}

export class UnauthenticatedError extends Error {
  constructor() {
    super('missing or invalid bearer token')
    this.name = 'UnauthenticatedError'
  }
}

export class ForbiddenError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'ForbiddenError'
  }
}

export interface TokenDirectory {
  lookup(token: string): Principal | undefined
}

export function resolveRequestContext(
  headers: Record<string, string | undefined>,
  directory: TokenDirectory,
): RequestContext {
  const authorization = headers.authorization ?? ''
  const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : ''

  const principal = token ? directory.lookup(token) : undefined
  if (!principal) {
    throw new UnauthenticatedError()
  }

  return {
    requestId: headers['x-request-id'] ?? `req_${Math.random().toString(36).slice(2, 10)}`,
    principal,
  }
}

export function assertAccountAccess(principal: Principal, accountId: string): void {
  if (!principal.accountIds.includes(accountId)) {
    throw new ForbiddenError(`principal ${principal.principalId} may not act on account ${accountId}`)
  }
}
