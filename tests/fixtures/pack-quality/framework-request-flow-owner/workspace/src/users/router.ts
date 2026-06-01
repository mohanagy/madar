import { Hono } from 'hono'

import { UserService } from './service.js'

const userService = new UserService()

async function enforceOwnedUserRequestFlow(input: { accountId: string; userId: string }) {
  return userService.loadProfile(input)
}

export function registerUserRoutes() {
  const router = new Hono()

  router.get('/:userId', async (context) => {
    const accountId = context.req.header('x-account-id') ?? 'public'
    const userId = context.req.param('userId')

    return context.json(await enforceOwnedUserRequestFlow({ accountId, userId }))
  })

  return router
}
