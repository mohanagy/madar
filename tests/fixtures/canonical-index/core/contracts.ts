export interface RequestInput {
  value: string
}

export interface ResponseOutput {
  value: string
}

export interface Runner {
  run(input: Array<RequestInput | ResponseOutput>): Promise<ResponseOutput[]>
}

export type Result = ResponseOutput

export class BaseRunner {
  protected normalize(input: RequestInput): ResponseOutput {
    return { value: input.value.trim() }
  }
}
