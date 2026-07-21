import { publicProcedure, router } from './trpc-base.js'

export const appRouter = router({
  health: publicProcedure.query(() => 'ok'),
  update: publicProcedure.mutation(() => 'updated'),
})
