export async function writeRawFailureReport(
  ideaId: string,
  reason: string,
): Promise<{ saved: boolean }> {
  return { saved: ideaId.length > 0 && reason.length > 0 }
}
