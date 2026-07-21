const fakeExpressApp = { get(_path: string, _handler: () => void): void {} }
export function fakeExpressHandler(): void {}
fakeExpressApp.get('/fake', fakeExpressHandler)
