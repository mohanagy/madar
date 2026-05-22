import { readFileSync, writeFileSync } from 'node:fs'

function requireValue(flag, value) {
  if (!value) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

let promptFile = ''
let outputFile = ''
let question = ''
let mode = ''

for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index]
  if (!argument) {
    continue
  }

  if (argument === '--prompt') {
    promptFile = requireValue('--prompt', process.argv[index + 1])
    index += 1
    continue
  }

  if (argument === '--output') {
    outputFile = requireValue('--output', process.argv[index + 1])
    index += 1
    continue
  }

  if (argument === '--question') {
    question = requireValue('--question', process.argv[index + 1])
    index += 1
    continue
  }

  if (argument === '--mode') {
    mode = requireValue('--mode', process.argv[index + 1])
    index += 1
    continue
  }
}

const prompt = promptFile ? readFileSync(promptFile, 'utf8') : ''
const normalizedQuestion = question.trim() || 'sadeem eval question'
const normalizedMode = mode.trim() || 'sadeem'
const answer = `CI runner answer for ${normalizedQuestion} (${normalizedMode})\n`

if (outputFile) {
  writeFileSync(outputFile, answer, 'utf8')
}

const estimatedInputTokens = Math.max(1, Math.ceil(prompt.length / 4))
const outputTokens = 48

process.stdout.write(
  `${JSON.stringify({
    result: answer,
    usage: {
      input_tokens: estimatedInputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  })}\n`,
)
