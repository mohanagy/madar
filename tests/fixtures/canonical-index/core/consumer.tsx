import { renamedDefault as invokeDefault, type AliasedInput } from './barrel-b.js'
import type { ResponseOutput } from '@core/contracts'

export function Consumer(input: AliasedInput): ResponseOutput {
  return { value: invokeDefault(input.value) }
}
