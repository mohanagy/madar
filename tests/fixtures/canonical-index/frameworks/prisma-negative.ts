class PrismaClient {
  user = { findMany(): unknown[] { return [] } }
}
export const fakePrisma = new PrismaClient()
export function listFakePrismaUsers(): unknown[] {
  return fakePrisma.user.findMany()
}
