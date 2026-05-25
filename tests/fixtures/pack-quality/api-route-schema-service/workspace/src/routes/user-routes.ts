import { validateCreateUser } from '../schemas/create-user.schema.js'
import { createUser } from '../services/user-service.js'

export function createUserRoute(input: { email: string; displayName: string }) {
  validateCreateUser(input)
  return createUser(input)
}
