class Hono {
  get(_path: string, _handler: () => void): void {}
}
export const fakeHonoApp = new Hono()
export function fakeHonoHandler(): void {}
fakeHonoApp.get('/fake-hono', fakeHonoHandler)
