import { createInviteContract } from '../../shared/src/contracts/invite.js'

export function createInvite(email: string) {
  return createInviteContract(email)
}
