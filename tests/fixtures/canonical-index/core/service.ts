import { BaseRunner, type RequestInput, type ResponseOutput, type Runner } from '@core/contracts'

export function helper(input: RequestInput): ResponseOutput {
  return { value: input.value.toUpperCase() }
}

export class Service extends BaseRunner implements Runner {
  run(input: RequestInput): ResponseOutput {
    helper(input)
    return helper(input)
  }
}
