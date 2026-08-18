// Prisma database client + model access helpers.

import { PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient()

export async function findUserById(): Promise<unknown> {
  return null
}

export async function createOrder(): Promise<unknown> {
  return null
}
