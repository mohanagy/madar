// tRPC router with query / mutation / subscription procedures.

import { initTRPC } from '@trpc/server'

declare const t: ReturnType<typeof initTRPC.create>

export const appRouter = t.router({
  getOrder: t.procedure.query(() => null),
  listOrders: t.procedure.query(() => null),
  createOrder: t.procedure.mutation(() => null),
  cancelOrder: t.procedure.mutation(() => null),
  onOrderUpdate: t.procedure.subscription(() => null),
})

export type AppRouter = typeof appRouter
