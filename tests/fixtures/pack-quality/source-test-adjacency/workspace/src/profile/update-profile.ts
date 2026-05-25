export function updateProfile(input: { displayName: string }) {
  if (!input.displayName.trim()) {
    throw new Error('displayName is required')
  }

  return input
}
