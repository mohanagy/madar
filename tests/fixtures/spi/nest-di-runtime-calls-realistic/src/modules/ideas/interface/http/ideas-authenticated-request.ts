export interface AuthenticatedIdeasRequest {
  userId: string
}

export function requireIdeasUserId(req: AuthenticatedIdeasRequest): string {
  return req.userId
}
