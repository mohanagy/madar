import type { FastifyPluginAsync } from 'fastify'

export const fastifyPlugin: FastifyPluginAsync = async (app) => {
  app.post('/plugin', async () => {})
}
