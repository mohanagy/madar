const fakeTrpc = {
  router(value: unknown): unknown { return value },
  procedure: { query(value: unknown): unknown { return value } },
}
export const fakeRouter = fakeTrpc.router({
  fake: fakeTrpc.procedure.query(() => 'fake'),
})
