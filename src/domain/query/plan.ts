import type {
  LocateAccess, NormalizedRetrieveRequest, ObligationKind,
  QueryIntent, QueryObligation, QuestionPlanResult,
} from './types.js'

const OWNER = 'file|module|class|function|method|service|handler|worker|component|controller|repository'
const sets = <T extends string[]>(...values: T): {
  [K in keyof T]: ReadonlySet<string>
} => values.map((value) => new Set(value.split(' '))) as {
  [K in keyof T]: ReadonlySet<string>
}
const [FLOW, LOCATE, EXPLAIN, COMMON] = sets(
  'flow workflow pipeline lifecycle generate run execute create build produce process work',
  'locate find define declare implement contain handle own write read save set update persist publish consume store use live',
  'explain describe work behave operate handle process validate resolve compute calculate score select update apply evaluate mean control do use choose return reject allow call invoke',
  `a an the this that these those it its they them their we our you your i me my he she what which who where when why how does do did is are was were be been being can could would should will may might must get of for with without by in into on at as and or but if then than from through via to after before during while all every any some each please show trace explain describe end complete initial final full entire code ${OWNER.replaceAll('|', ' ')} definition declaration implementation behavior happen`,
)
const ACTIONS = new Set([...FLOW, ...LOCATE, ...EXPLAIN, 'complete', 'get', 'happen', 'plan'])
const BEHAVIOR = new Set(
  'apply allow calculate choose compute consume control evaluate persist publish read reject resolve return save score select store update validate write'.split(' '),
)
const IRREGULAR = new Map('built=build generation=generate got=get getting=get persistence=persist planned=plan planning=plan ran=run running=run setting=set written=write wrote=write'.split(' ').map((pair) => pair.split('=') as [string, string]))

function canonical(value: string): string {
  const mapped = IRREGULAR.get(value)
  if (mapped) return mapped
  const ing = value.endsWith('ing') ? value.slice(0, -3) : ''
  const past = value.endsWith('ed') ? value.slice(0, -2) : ''
  const forms = [value,
    /i(?:es|ed)$/u.test(value) ? `${value.slice(0, -3)}y` : '',
    ing, ing ? `${ing}e` : '', past, past ? `${past}e` : '',
    value.endsWith('es') ? value.slice(0, -2) : '',
    value.endsWith('s') ? value.slice(0, -1) : '']
  const action = forms.find((candidate) => ACTIONS.has(candidate))
  if (action) return action
  if (value.length <= 4) return value
  if (value.endsWith('ies')) return `${value.slice(0, -3)}y`
  return /(?<!s|u|i)s$/u.test(value) ? value.slice(0, -1) : value
}

export function lexicalTokens(value: string): string[] {
  const raw = value.normalize('NFKC')
    .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, '$1 $2')
    .replace(/[’']s\b/giu, '')
    .toLowerCase()
  return (raw.match(/[\p{L}\p{N}]+/gu) ?? []).map(canonical)
}

const [FW, LW, EW] =
  [FLOW, LOCATE, EXPLAIN].map((set) => [...set].join('|'))
const AUX = 'is|are|was|were|does|do|did|can|could|would|should|will'
const CLAUSE = 'when|after|before|on|during|if|from|through|via'
const FN = 'flow|workflow|pipeline|lifecycle'
const isNoise = (token: string, mode: QueryIntent): boolean =>
  COMMON.has(token) || (mode === 'workflow' ? FLOW.has(token)
    : mode === 'locate' ? LOCATE.has(token)
      : EXPLAIN.has(token) && !BEHAVIOR.has(token))
const content = (
  value: string, mode: QueryIntent, plain = false,
): string[] => [...new Set(lexicalTokens(value).filter((token) =>
  !(plain ? COMMON.has(token) : isNoise(token, mode))))]

function pick(
  text: string, mode: QueryIntent, rules: readonly RegExp[], plain = false,
): string {
  for (const rule of rules) {
    const topic = content(rule.exec(text)?.slice(1).join(' ') ?? '',
      mode, plain).join(' ')
    if (topic) return topic
  }
  return ''
}

type SubjectMatch = readonly [topic: string, ignored: readonly string[]]

type CoordinatedFlow = {
  subject: string; entry: string; stage?: string; handoff?: string
  terminal: string; terms: string[]
}
function coordinatedFlow(text: string): CoordinatedFlow | undefined {
  const entry = /\b(?:accept|receive|submit|handle) (.+?)(?= (?:schedule|enqueue|queue|dispatch|research|process|compose|assemble|render|write|save|store|persist)\b)/u
      .exec(text),
    end = /\b(?:write|save|store|persist) (.+)$/u.exec(text),
    composed = /\b(compose|assemble|render) (.+?)(?= (?:and )?(?:write|save|store|persist)\b|$)/u
      .exec(text)
  if (!entry || !end) return undefined
  const input = content(entry[1]!, 'workflow')
  let output = content(composed?.[2] ?? end[1]!, 'workflow')
  if (composed && /^(?:model|output|result)$/u.test(output.at(-1) ?? ''))
    output = content(end[1]!, 'workflow')
  const first = input[0], raw = output.at(-1),
    last = /^(?:model|output|result)$/u.test(raw ?? '') ? first : raw
  if (!first || !last) return undefined
  const handoff = /\b(?:schedule|enqueue|queue|dispatch|publish|emit)\b/u.test(text)
      ? 'schedule' : undefined,
    stages = [
      /\b(?:research|investigate|discover)\b/u.test(text) ? 'research' : '',
      /\b(?:compose|assemble|render|synthesize|merge)\b/u.test(text)
        ? 'assemble' : '',
    ].filter(Boolean)
  return {
    subject: first === last ? first : `${first} ${last}`,
    entry: `request ${first}`, ...(stages.length ? { stage: stages.join(' ') } : {}),
    ...(handoff ? { handoff } : {}), terminal: 'persistence',
    terms: [...new Set([first, last, ...stages, ...(handoff ? [handoff] : [])])],
  }
}

function flowSubject(text: string): SubjectMatch {
  const direct = pick(text, 'workflow', [
    /\bwhat happen when (?:(?:a|an|the) )?(?:user|client|caller) (?:request|submit) (.+)$/,
  ]) || pick(text, 'workflow', [
    /\bwalk (?:me )?through (.+?)(?= from\b| via\b| to\b|$)/,
  ]) || pick(text, 'workflow', [
    /\btrace (?:the )?(.+)(?= from .+ (?:to|through|via)\b)/,
    /\bwhat \w+ (?:the )?(.+?) that/,
  ], true) || pick(text, 'workflow', [
    RegExp(`\\bhow (?:is|are|was|were) (.+?) (?:${FW})\\b`),
    RegExp(`\\bhow (?:does|do|did) (.+?) get (?:${FW})\\b`),
  ])
  if (direct) return [direct, []]
  const active = RegExp(
    `\\bhow (?:(?:${AUX}) )?(.+?) (${FW}) (.+?)(?= (?:${CLAUSE})\\b| end to end\\b|$)`,
  ).exec(text)
  if (active) {
    const object = content(active[3]!, 'workflow').join(' ')
    if (object) return [object, content(active[1]!, 'workflow', true)]
  }
  const topic = pick(text, 'workflow', [
    /^follow (?:\S+ )*?(\S+) from .+ until (?:\S+ )*?(\S+) is/,
    /for (.+?) generate/,
    /\btrace (?:the )?(.+?)(?= through\b| via\b| to\b|$)/,
    RegExp(`\\b(?:${FN}) (?:of|for) (.+?)(?= from\\b|$)`),
    RegExp(`(.+?) (?:${FN})\\b`),
    RegExp(`\\bhow (?:(?:${AUX}) )?(.+?) (?:${FW})\\b`),
    /\w+ (?:an?|the) (\S+)/,
  ])
  return [topic || content(text, 'workflow').join(' '), []]
}

type FlowBounds = {
  entry?: string | undefined
  stage?: string | undefined
  handoff?: string | undefined
  terminal?: string | undefined
}
function flowBounds(text: string): FlowBounds {
  if (/^follow /.test(text)
    || !(/\b(?:from|via)\b/u.test(text) || /^(?:trace|walk)\b.*\bthrough\b/u
      .test(text))) return {}
  const read = (rule: RegExp): string | undefined => {
    const value = lexicalTokens(rule.exec(text)?.[1] ?? '')
      .filter((token) => !COMMON.has(token)).join(' ')
    return value || undefined
  }
  const walked = /^walk (?:me )?through\b/u.test(text)
  return {
    entry: read(/\bfrom (.+?)(?= (?:through(?: to)?|via|to)\b| how\b|$)/u),
    stage: read(/\bvia (.+?)(?= to\b| how\b|$)/u)
      ?? read(/\bfrom .+?\bthrough (?!to\b)(.+?)(?= to\b| how\b|$)/u)
      ?? (walked ? undefined
        : read(/\bthrough (?!to\b)(.+?)(?= to\b| how\b|$)/u)),
    terminal: read(/\b(?:through to|to) (.+?)(?= how\b|$)/u),
  }
}

function simpleSubject(text: string, mode: 'locate' | 'explain'): string {
  const locate = mode === 'locate'
  const rules = locate ? [
    RegExp(`\\bwhere (?:(?:${AUX}) )?(.+?)(?= (?:${LW})\\b| (?:${CLAUSE})\\b|$)`),
    RegExp(`\\b(?:(?:which|what) (?:${OWNER}) |what )(?:${LW}) (.+?)(?= (?:${CLAUSE})\\b|$)`),
    /\b(?:locate|find)(?: the)? (.+?)(?= (?:definition|declaration|implementation)\b|$)/,
    /\b(?:definition|declaration|implementation) (?:of|for) (.+)$/,
  ] : [
    RegExp(`\\bwhich (?:${OWNER}) \\S+ (.+)$`),
    RegExp(`\\bwhat (?:${FW}|${EW}) (.+)$`),
    RegExp(`\\bhow (?:${AUX}) (.+?) (?:create|build|produce)\\b`),
    RegExp(`\\b(?:how|why|what) (?:(?:${AUX}) )?(.+?) (?:${EW})\\b`),
    /\b(?:explain|describe)(?: how)?(?: the)? (.+)$/,
  ]
  return pick(text, mode, rules,
    locate || /\b(?:call|invoke)\b/u.test(text))
    || content(text, mode).join(' ')
}

export function planQuestion(request: NormalizedRetrieveRequest): QuestionPlanResult {
  const raw = request.question.normalize('NFKC'),
    text = lexicalTokens(request.question).join(' '),
    tokens = text.split(' '),
    names = [...raw.matchAll(/(?<![\p{L}\p{N}_$])([\p{L}_$][\p{L}\p{N}_$]*\.[\p{L}_$][\p{L}\p{N}_$]*)/gu)]
      .map((match) => match[1]!),
    ident = /\bwhere\s+(?:is|are|was|were)\s+[`'"]?([\p{L}_$][\p{L}\p{N}_$.-]*)[`'"]?\s+(?:defined|declared|implemented)\b/iu
      .exec(raw)?.[1],
    ownerQuery = RegExp(`\\b(?:which|what) (?:${OWNER}) (?:${LW})\\b`).test(text)
  const mode: QueryIntent | undefined =
    ownerQuery ? 'locate'
    : /\b(?:end to end|what happen when)\b|\bfrom\b.+\b(?:through|via)\b.+\bto\b|\btrace\b.+\bfrom\b.+\bto\b/.test(text)
      || /^follow /.test(text)
      || /^which .+\b(?:save|write)\b/.test(text)
      || /\bhow\b[\s\S]*\bgenerat(?:e|ed|es|ing)\b/iu.test(raw)
      || /\bhow\s+(?:(?:does|do|did|can|could|would|should|will)\s+)?(?!(?:does|do|did|can|could|would|should|will)\b)[\p{L}_$][\p{L}\p{N}_$]*\s+(?:generate|run|execute|create|build|produce|process)\b/iu.test(raw)
      ? 'workflow'
      : /\b(?:where|locate|find|definition|declaration|implementation)\b/.test(text)
        || RegExp(`\\bwhat (?:${LW})\\b`).test(text) ? 'locate'
        : /^trace\b|\b(?:flow|workflow|pipeline|lifecycle)\b/.test(text) ? 'workflow'
          : /\b(?:explain|describe|how|why|behavior)\b|\bwhat (?:does|do|is|are)\b/
            .test(text)
            || RegExp(`\\b(?:what (?:${FW}|${EW})|which (?:${OWNER}))\\b`)
              .test(text) ? 'explain' : undefined
  if (!mode) {
    return {
      status: 'unsupported', reason: 'unsupported_intent',
      terms: [...new Set(tokens.filter((token) => !COMMON.has(token)))].sort(),
    }
  }
  const coordinated = mode === 'workflow' ? coordinatedFlow(text) : undefined
  const [topic, ignored] = mode === 'workflow'
    ? coordinated ? [coordinated.subject, []] : flowSubject(text)
    : [names[0]
      ? content(names[0], mode, true).join(' ')
      : mode === 'locate' && ident
      ? content(ident, 'locate', true).join(' ')
      : simpleSubject(text, mode), []]
  const span: FlowBounds = coordinated
    ?? (mode === 'workflow' ? flowBounds(text) : {})
  if (mode === 'workflow' && names.length) {
    span.stage = names.flatMap(lexicalTokens).join(' ')
  }
  const skip = new Set(ignored)
  const terms = new Set((coordinated?.terms ?? tokens).filter((token) =>
    !isNoise(token, mode) && !skip.has(token)))
  lexicalTokens(topic).forEach((token) => terms.add(token))
  const sorted = [...terms].sort()
  if (!topic || sorted.length === 0) {
    return { status: 'unsupported', reason: 'missing_subject', terms: sorted }
  }
  const words = new Set(tokens)
  const access: LocateAccess | undefined = mode !== 'locate' ? undefined
    : ['read', 'find'].some((word) => words.has(word)) ? 'read'
      : ['write', 'save', 'set', 'update', 'persist', 'store']
        .some((word) => words.has(word)) ? 'write' : undefined
  const kinds: readonly ObligationKind[] = mode === 'locate' ? ['subject']
    : mode === 'explain' ? ['subject', 'behavior']
      : ['subject', 'entry', 'stage', 'handoff', 'behavior', 'ordering', 'terminal']
  const rest = RegExp(`^(?:what (?:${FW})|how (?:is|are|was|were) .+ (?:${FW}))\\b`)
    .test(text) ? []
      : sorted.filter((token) => !lexicalTokens(topic).includes(token))
  return {
    status: 'supported',
    plan: {
      intent: mode, subject: topic, terms: sorted,
      obligations: kinds.map((kind, index): QueryObligation => ({
        id: `o${index + 1}`, kind,
        target: kind === 'entry' ? span.entry ?? topic
          : kind === 'stage' ? span.stage ?? topic
            : kind === 'handoff' ? span.handoff ?? topic
            : kind === 'terminal' ? span.terminal ?? topic
              : kind === 'behavior' && mode === 'explain' && rest.length
                ? rest.join(' ') : topic,
        mandatory: true,
      })),
      ...(access ? { access } : {}),
    },
  }
}
