'use client'

type DashboardClientProps = {
  activeProjects: number
}

export function DashboardClient({ activeProjects }: DashboardClientProps) {
  return (
    <section>
      <span>{activeProjects}</span>
    </section>
  )
}
