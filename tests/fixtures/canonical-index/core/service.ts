import { BaseRunner, type RequestInput, type ResponseOutput, type Runner } from '@core/contracts'

export function helper(input: RequestInput): ResponseOutput {
  return { value: input.value.toUpperCase() }
}

export class Service extends BaseRunner implements Runner {
  async run(input: Array<RequestInput | ResponseOutput>): Promise<ResponseOutput[]> {
    input.map((item) => helper(item))
    return input.map((item) => helper(item))
  }
}
