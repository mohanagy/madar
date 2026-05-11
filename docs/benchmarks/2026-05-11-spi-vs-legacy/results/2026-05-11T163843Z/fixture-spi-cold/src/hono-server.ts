// Hono app with named routes — v0.17 substrate target.

import { Hono } from 'hono'
import type { Context, Next } from 'hono'

export const honoApp = new Hono()

export function listProducts(c: Context) {
  return c.json([])
}

export function getProductById(c: Context) {
  return c.json({ id: c.req.param('id') })
}

export function createProduct(c: Context) {
  return c.json({ ok: true }, 201)
}

export async function logRequest(_c: Context, next: Next) {
  await next()
}

honoApp.use('/products/*', logRequest)
honoApp.get('/products', listProducts)
honoApp.get('/products/:id', getProductById)
honoApp.post('/products', createProduct)
