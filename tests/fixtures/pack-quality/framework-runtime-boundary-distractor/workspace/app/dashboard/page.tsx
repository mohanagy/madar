import { persistDashboardOwnerFilter } from './actions.js'
import { DashboardClient } from '../../components/dashboard-client.js'

export default async function DashboardPage() {
  return (
    <form action={persistDashboardOwnerFilter}>
      <DashboardClient activeProjects={4} />
      <input defaultValue="owner-1" name="ownerId" />
      <input defaultValue="project-1" name="projectId" />
      <button type="submit">Save</button>
    </form>
  )
}
