process.stdout.write('STREAMED_LINE_ONE\n')
await new Promise((resolve) => setTimeout(resolve, 160))
process.stdout.write('STREAMED_LINE_TWO\n')
