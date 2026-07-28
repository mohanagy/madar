function fastify(): { get(path: string, handler: () => void): void } {
  return { get(): void {} }
}
export const fakeFastifyApp = fastify()
export function fakeFastifyHandler(): void {}
fakeFastifyApp.get('/fake-fast', fakeFastifyHandler)
