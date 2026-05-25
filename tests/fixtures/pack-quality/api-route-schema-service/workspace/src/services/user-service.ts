export function createUser(input: { email: string; displayName: string }) {
  return { id: input.email, displayName: input.displayName }
}
