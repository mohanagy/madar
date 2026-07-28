function createBrowserRouter(value: unknown): unknown { return value }
export function fakeRouteLoader(): null { return null }
export const fakeBrowserRouter = createBrowserRouter([
  { path: '/fake-account', loader: fakeRouteLoader },
])
