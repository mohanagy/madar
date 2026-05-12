import { IdeasService } from '../modules/ideas/core/application/ideas.service'

export async function migrateIdea(ideasService: IdeasService, userId: string, problem: string): Promise<string> {
  const idea = await ideasService.createIdea(userId, problem)
  return idea.id
}

export async function main(): Promise<void> {
  await migrateIdea(new IdeasService(), 'system', 'old pipeline idea')
}
