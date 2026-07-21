import fastify from 'fastify'
import { fastifyPlugin } from './fastify-plugin.js'

export const fastifyApp = fastify()
export function fastifyHandler(): void {}
fastifyApp.get('/fast', fastifyHandler)
fastifyApp.register(fastifyPlugin)
