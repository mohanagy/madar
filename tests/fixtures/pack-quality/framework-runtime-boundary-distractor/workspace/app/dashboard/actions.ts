'use server'

const prisma = {
  dashboardFilter: {
    async upsert({ where, update, create }: {
      where: { ownerId: string }
      update: { projectId: string }
      create: { ownerId: string; projectId: string }
    }) {
      return { where, update, create }
    },
  },
}

export async function persistDashboardOwnerFilter(formData: FormData) {
  const ownerId = String(formData.get('ownerId') ?? 'anonymous')
  const projectId = String(formData.get('projectId') ?? 'inbox')

  return prisma.dashboardFilter.upsert({
    where: { ownerId },
    update: { projectId },
    create: { ownerId, projectId },
  })
}
