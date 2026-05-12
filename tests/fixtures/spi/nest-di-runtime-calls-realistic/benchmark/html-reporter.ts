export function renderIdeaReportHtml(result: { saved: boolean }): string {
  return result.saved ? '<html>saved</html>' : '<html>missing</html>'
}
