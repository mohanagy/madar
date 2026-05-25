export function validateCreateUser(input: { email: string; displayName: string }) {
  if (!input.displayName) {
    throw new Error('displayName is required')
  }
}
