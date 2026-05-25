import { createInvite } from '../../../domain/src/invite-service.js'

export function inviteUser(email: string) {
  return createInvite(email)
}
