import { Hono } from 'hono'

import { registerUserRoutes } from '../users/router.js'

export function createApp() {
  const app = new Hono()
  app.route('/users', registerUserRoutes())
  return app
}
