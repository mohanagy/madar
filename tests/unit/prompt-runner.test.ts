import { describe, expect, it } from 'vitest'

import {
  parseClaudeStructuredPromptRunnerOutput,
  parseGeminiStructuredPromptRunnerOutput,
  parsePlainTextPromptRunnerOutput,
  parsePromptRunnerJsonRecord,
  parsePromptRunnerOutput,
} from '../../src/infrastructure/prompt-runner.js'

describe('parsePromptRunnerJsonRecord', () => {
  it('accepts a whitespace-padded JSON object', () => {
    expect(parsePromptRunnerJsonRecord('  { "result": "answer" }\n')).toEqual({
      result: 'answer',
    })
  })

  it.each([
    '',
    'plain text',
    '{ malformed }',
    '["not", "an", "object"]',
    'null',
    '42',
  ])('rejects non-record structured output: %s', (stdout) => {
    expect(parsePromptRunnerJsonRecord(stdout)).toBeNull()
  })
})

describe('parseClaudeStructuredPromptRunnerOutput', () => {
  it('parses an answer with cache-aware structured usage', () => {
    expect(
      parseClaudeStructuredPromptRunnerOutput(JSON.stringify({
        result: 'baseline answer\n',
        usage: {
          input_tokens: 1200,
          output_tokens: 90,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 20,
        },
      })),
    ).toEqual({
      answerText: 'baseline answer\n',
      usage: {
        provider: 'claude',
        source: 'structured_stdout',
        input_tokens: 1200,
        output_tokens: 90,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 20,
        input_total_tokens: 1320,
        total_tokens: 1410,
      },
    })
  })

  it('accepts completion text and defaults omitted cache counters to zero', () => {
    expect(
      parseClaudeStructuredPromptRunnerOutput(JSON.stringify({
        completion: 'completed',
        usage: {
          input_tokens: 10,
          output_tokens: 3,
        },
      })),
    ).toEqual({
      answerText: 'completed',
      usage: {
        provider: 'claude',
        source: 'structured_stdout',
        input_tokens: 10,
        output_tokens: 3,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_total_tokens: 10,
        total_tokens: 13,
      },
    })
  })

  it('keeps an answer when usage is absent or invalid', () => {
    expect(parseClaudeStructuredPromptRunnerOutput('{"result":"answer"}')).toEqual({
      answerText: 'answer',
      usage: null,
    })
    expect(
      parseClaudeStructuredPromptRunnerOutput(
        '{"result":"answer","usage":{"input_tokens":-1,"output_tokens":4}}',
      ),
    ).toEqual({
      answerText: 'answer',
      usage: null,
    })
  })

  it('returns usage without answer text and rejects records with neither', () => {
    expect(
      parseClaudeStructuredPromptRunnerOutput(
        '{"usage":{"input_tokens":2,"output_tokens":1}}',
      ),
    ).toEqual({
      answerText: null,
      usage: {
        provider: 'claude',
        source: 'structured_stdout',
        input_tokens: 2,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_total_tokens: 2,
        total_tokens: 3,
      },
    })
    expect(parseClaudeStructuredPromptRunnerOutput('{"message":"no result"}')).toBeNull()
    expect(parseClaudeStructuredPromptRunnerOutput('not json')).toBeNull()
  })
})

describe('parseGeminiStructuredPromptRunnerOutput', () => {
  it('concatenates first-candidate text parts and parses usage', () => {
    expect(
      parseGeminiStructuredPromptRunnerOutput(JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: 'madar answer' }, { ignored: true }, { text: '\n' }],
            },
          },
          {
            content: {
              parts: [{ text: 'ignored candidate' }],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 400,
          candidatesTokenCount: 70,
          totalTokenCount: 470,
        },
      })),
    ).toEqual({
      answerText: 'madar answer\n',
      usage: {
        provider: 'gemini',
        source: 'structured_stdout',
        input_tokens: 400,
        output_tokens: 70,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_total_tokens: 400,
        total_tokens: 470,
      },
    })
  })

  it('keeps independently valid answer and usage sections', () => {
    expect(
      parseGeminiStructuredPromptRunnerOutput(
        '{"candidates":[{"content":{"parts":[{"text":"answer"}]}}]}',
      ),
    ).toEqual({
      answerText: 'answer',
      usage: null,
    })
    expect(
      parseGeminiStructuredPromptRunnerOutput(
        '{"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2,"totalTokenCount":6}}',
      ),
    ).toEqual({
      answerText: null,
      usage: {
        provider: 'gemini',
        source: 'structured_stdout',
        input_tokens: 4,
        output_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_total_tokens: 4,
        total_tokens: 6,
      },
    })
  })

  it('rejects malformed candidate and usage shapes without throwing', () => {
    expect(
      parseGeminiStructuredPromptRunnerOutput(
        '{"candidates":[{"content":{"parts":"wrong"}}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":-2,"totalTokenCount":2}}',
      ),
    ).toBeNull()
    expect(parseGeminiStructuredPromptRunnerOutput('{"candidates":[]}')).toBeNull()
    expect(parseGeminiStructuredPromptRunnerOutput('not json')).toBeNull()
  })
})

describe('parsePromptRunnerOutput', () => {
  it('selects structured Claude and Gemini parsers before plain text fallback', () => {
    expect(parsePromptRunnerOutput('{"completion":"claude"}')).toEqual({
      answerText: 'claude',
      usage: null,
    })
    expect(
      parsePromptRunnerOutput(
        '{"candidates":[{"content":{"parts":[{"text":"gemini"}]}}]}',
      ),
    ).toEqual({
      answerText: 'gemini',
      usage: null,
    })
  })

  it('preserves raw stdout when no structured parser recognizes it', () => {
    const json = '{"message":"runner emitted unrecognized JSON"}'
    expect(parsePromptRunnerOutput(json)).toEqual({
      answerText: json,
      usage: null,
    })
    expect(parsePlainTextPromptRunnerOutput(' plain text\n')).toEqual({
      answerText: ' plain text\n',
      usage: null,
    })
  })
})
