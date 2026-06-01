type UserRecord = {
  id: string
  accountId: string
  displayName: string
}

const prisma = {
  user: {
    async findFirst({ where }: { where: { id: string; accountId: string } }): Promise<UserRecord | null> {
      return {
        id: where.id,
        accountId: where.accountId,
        displayName: 'Ada Lovelace',
      }
    },
  },
}

export class UserRepository {
  async findOwnedUser(input: { accountId: string; userId: string }) {
    return prisma.user.findFirst({
      where: {
        id: input.userId,
        accountId: input.accountId,
      },
    })
  }
}
