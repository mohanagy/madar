import { PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient()
export async function listPrismaUsers(): Promise<unknown> {
  return prisma.user.findMany()
}
export async function createPrismaUsers(): Promise<unknown> {
  return prisma.user.createMany({ data: [] })
}
