export interface ResetEmailJob {
  email: string
  token: string
  sendPasswordResetEmail: (email: string, resetLink: string) => { delivered: boolean; channel: 'email' }
}

export function enqueueResetEmailJob(job: ResetEmailJob) {
  return processResetEmailJob(job)
}

export function processResetEmailJob(job: ResetEmailJob) {
  const resetLink = `https://example.test/reset?token=${job.token}`
  return job.sendPasswordResetEmail(job.email, resetLink)
}
