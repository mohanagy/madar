import { Hono } from 'hono'

export const honoApp = new Hono()
export function honoHandler(): void {}
honoApp.get('/hono', honoHandler)
