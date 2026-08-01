import type {
  LocateAccess, NormalizedRetrieveRequest, ObligationKind,
  QueryIntent, QueryObligation, QuestionPlanResult,
} from './types.js'

const sets = <T extends string[]>(...values: T): {
  [K in keyof T]: ReadonlySet<string>
} => values.map((value) => new Set(value.split(' '))) as {
  [K in keyof T]: ReadonlySet<string>
}
const [FLOW, LOCATE, EXPLAIN, COMMON] = sets(
  'flow workflow pipeline lifecycle generate run execute create build produce process work',
  'locate find define declare implement contain handle own write read save set update persist publish consume store use live',
  'explain describe work behave operate handle process validate resolve compute calculate score select update apply evaluate mean control do use choose return reject allow call invoke',
  'a an the this that these those it its they them their we our you your i me my he she what which who where when why how does do did is are was were be been being can could would should will may might must get of for with without by in into on at as and or but if then than from through via to after before during while all every any some each please show trace explain describe end complete initial final full entire code repository file module class function method service handler definition declaration implementation behavior happen',
)
const ACTIONS = new Set([...FLOW, ...LOCATE, ...EXPLAIN, 'complete', 'get', 'happen', 'plan'])
const BEHAVIOR = new Set(
  'apply allow calculate call choose compute consume control evaluate invoke persist publish read reject resolve return save score select store update validate write'.split(' '),
)
const IRREGULAR = new Map('built=build generation=generate got=get getting=get persistence=persist planned=plan planning=plan ran=run running=run setting=set written=write wrote=write'.split(' ').map((pair) => pair.split('=') as [string, string]))

function canonical(value: string): string {
  const irregular = IRREGULAR.get(value)
  if (irregular) return irregular
  const ing = value.endsWith('ing') ? value.slice(0, -3) : ''
  const past = value.endsWith('ed') ? value.slice(0, -2) : ''
  const candidates = [value,
    /i(?:es|ed)$/u.test(value) ? `${value.slice(0, -3)}y` : '',
    ing, ing ? `${ing}e` : '', past, past ? `${past}e` : '',
    value.endsWith('es') ? value.slice(0, -2) : '',
    value.endsWith('s') ? value.slice(0, -1) : '']
  const action = candidates.find((candidate) => ACTIONS.has(candidate))
  if (action) return action
  if (value.length <= 4) return value
  if (value.endsWith('ies')) return `${value.slice(0, -3)}y`
  return /(?<!s|u|i)s$/u.test(value) ? value.slice(0, -1) : value
}

export function lexicalTokens(value: string): string[] {
  const normalized = value.normalize('NFKC')
    .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, '$1 $2')
    .replace(/[’']s\b/giu, '')
    .toLowerCase()
  return (normalized.match(/[\p{L}\p{N}]+/gu) ?? []).map(canonical)
}

const [FW, LW, EW] =
  [FLOW, LOCATE, EXPLAIN].map((set) => [...set].join('|'))
const AUX = 'is|are|was|were|does|do|did|can|could|would|should|will'
const CLAUSE = 'when|after|before|on|during|if|from|through|via'
const FN = 'flow|workflow|pipeline|lifecycle'
const FV = 'generate|run|execute|create|build|produce|process'
const OWNER = 'file|module|class|function|method|service|handler'

const isNoise = (token: string, intent: QueryIntent): boolean =>
  COMMON.has(token) || (intent === 'workflow' ? FLOW.has(token)
    : intent === 'locate' ? LOCATE.has(token) : EXPLAIN.has(token))
const useful = (
  value: string, intent: QueryIntent, common = false,
): string[] => [...new Set(lexicalTokens(value).filter((token) =>
  !(common ? COMMON.has(token) : isNoise(token, intent))))]

function pick(
  phrase: string, intent: QueryIntent, patterns: readonly RegExp[], common = false,
): string {
  for (const pattern of patterns) {
    const subject = useful(pattern.exec(phrase)?.[1] ?? '', intent, common).join(' ')
    if (subject) return subject
  }
  return ''
}

type SubjectMatch = readonly [subject: string, ignored: readonly string[]]

function flowSubject(phrase: string): SubjectMatch {
  const event = pick(phrase, 'workflow', [
    /\bwhat happen when (?:(?:a|an|the) )?(?:user|client|caller) (?:request|submit) (.+)$/,
  ])
  if (event) return [event, []]
  const walked = pick(phrase, 'workflow', [
    /\bwalk (?:me )?through (.+?)(?= from\b| via\b| to\b|$)/,
  ])
  if (walked) return [walked, []]
  const traced = pick(phrase, 'workflow', [
    /\btrace (?:the )?(.+)(?= from .+ (?:to|through|via)\b)/,
  ], true)
  if (traced) return [traced, []]
  const passive = pick(phrase, 'workflow', [
    RegExp(`\\bhow (?:is|are|was|were) (.+?) (?:${FW})\\b`),
    RegExp(`\\bhow (?:does|do|did) (.+?) get (?:${FW})\\b`),
  ])
  if (passive) return [passive, []]
  const active = RegExp(
    `\\bhow (?:(?:${AUX}) )?(.+?) (${FW}) (.+?)(?= (?:${CLAUSE})\\b| end to end\\b|$)`,
  ).exec(phrase)
  if (active) {
    const object = useful(active[3]!, 'workflow').join(' ')
    if (object) return [object, useful(active[1]!, 'workflow', true)]
  }
  const subject = pick(phrase, 'workflow', [
    /\btrace (?:the )?(.+?)(?= through\b| via\b| to\b|$)/,
    RegExp(`\\b(?:${FN}) (?:of|for) (.+?)(?= from\\b|$)`),
    RegExp(`(.+?) (?:${FN})\\b`),
    RegExp(`\\bhow (?:(?:${AUX}) )?(.+?) (?:${FW})\\b`),
  ])
  return [subject || useful(phrase, 'workflow').join(' '), []]
}

type FlowBounds = {
  entry?: string | undefined
  stage?: string | undefined
  terminal?: string | undefined
}
function flowBounds(phrase: string): FlowBounds {
  if (!/\b(?:from|through|via)\b/u.test(phrase)) return {}
  const read = (pattern: RegExp): string | undefined => {
    const value = useful(pattern.exec(phrase)?.[1] ?? '', 'workflow', true).join(' ')
    return value || undefined
  }
  const walked = /^walk (?:me )?through\b/u.test(phrase)
  return {
    entry: read(/\bfrom (.+?)(?= (?:through(?: to)?|via|to)\b| how\b|$)/u),
    stage: read(/\bvia (.+?)(?= to\b| how\b|$)/u)
      ?? read(/\bfrom .+?\bthrough (?!to\b)(.+?)(?= to\b| how\b|$)/u)
      ?? (walked ? undefined
        : read(/\bthrough (?!to\b)(.+?)(?= to\b| how\b|$)/u)),
    terminal: read(/\b(?:through to|to) (.+?)(?= how\b|$)/u),
  }
}

function simpleSubject(phrase: string, intent: 'locate' | 'explain'): string {
  const locate = intent === 'locate'
  const patterns = locate ? [
    RegExp(`\\bwhere (?:(?:${AUX}) )?(.+?)(?= (?:${LW})\\b| (?:${CLAUSE})\\b|$)`),
    RegExp(`\\b(?:which (?:${OWNER}) |what )(?:${LW}) (.+?)(?= (?:${CLAUSE})\\b|$)`),
    /\b(?:locate|find)(?: the)? (.+?)(?= (?:definition|declaration|implementation)\b|$)/,
    /\b(?:definition|declaration|implementation) (?:of|for) (.+)$/,
  ] : [
    RegExp(`\\bwhich (?:${OWNER}) \\S+ (.+)$`),
    RegExp(`\\bwhat (?:${FW}|${EW}) (.+)$`),
    RegExp(`\\bhow (?:${AUX}) (.+?) (?:create|build|produce)\\b`),
    RegExp(`\\b(?:how|why|what) (?:(?:${AUX}) )?(.+?) (?:${EW})\\b`),
    /\b(?:explain|describe)(?: how)?(?: the)? (.+)$/,
  ]
  return pick(phrase, intent, patterns, locate)
    || useful(phrase, intent).join(' ')
}

export function planQuestion(request: NormalizedRetrieveRequest): QuestionPlanResult {
  const phrase = lexicalTokens(request.question).join(' '),
    qualified = /(?:^|[^\p{L}\p{N}_$])([\p{L}_$][\p{L}\p{N}_$]*\.[\p{L}_$][\p{L}\p{N}_$]*)/u
      .exec(request.question.normalize('NFKC'))?.[1],
    identifier = /\bwhere\s+(?:is|are|was|were)\s+[`'"]?([\p{L}_$][\p{L}\p{N}_$.-]*)[`'"]?\s+(?:defined|declared|implemented)\b/iu
      .exec(request.question.normalize('NFKC'))?.[1]
  const intent: QueryIntent | undefined =
    /\b(?:end to end|what happen when)\b|\bfrom\b.+\b(?:through|via)\b.+\bto\b|\btrace\b.+\bfrom\b.+\bto\b/.test(phrase)
      || !qualified && RegExp(`\\bhow (?:(?:${AUX}) (?!${FV}\\b)|(?!(?:${AUX}|${FV})\\b))\\S+(?: \\S+)*? (?:${FV})\\b`).test(phrase)
      ? 'workflow'
      : /\b(?:where|locate|find|definition|declaration|implementation)\b/.test(phrase)
        || RegExp(`\\bwhich (?:${OWNER}) (?:${LW})\\b`).test(phrase)
        || RegExp(`\\bwhat (?:${LW})\\b`).test(phrase) ? 'locate'
        : /^trace\b|\b(?:flow|workflow|pipeline|lifecycle)\b/.test(phrase) ? 'workflow'
          : /\b(?:explain|describe|how|why|behavior)\b|\bwhat (?:does|do|is|are)\b/
            .test(phrase)
            || RegExp(`\\b(?:what (?:${FW}|${EW})|which (?:${OWNER}))\\b`)
              .test(phrase) ? 'explain' : undefined
  if (!intent) {
    return {
      status: 'unsupported', reason: 'unsupported_intent',
      terms: [...new Set(phrase.split(' ').filter((token) => !COMMON.has(token)))].sort(),
    }
  }
  const [subject, ignored] = intent === 'workflow'
    ? qualified ? [useful(qualified, 'workflow', true).join(' '), []]
      : flowSubject(phrase)
    : [qualified
      ? useful(qualified, intent, true).join(' ')
      : intent === 'locate' && identifier
      ? useful(identifier, 'locate', true).join(' ')
      : simpleSubject(phrase, intent), []]
  const bounds = intent === 'workflow' ? flowBounds(phrase) : {}
  const omitted = new Set(ignored)
  const terms = new Set(lexicalTokens(phrase).filter((token) =>
    !isNoise(token, intent) && !omitted.has(token)))
  lexicalTokens(subject).forEach((token) => terms.add(token))
  const sorted = [...terms].sort()
  if (!subject || sorted.length === 0) {
    return { status: 'unsupported', reason: 'missing_subject', terms: sorted }
  }
  const words = new Set(phrase.split(' '))
  const access: LocateAccess | undefined = intent !== 'locate' ? undefined
    : ['read', 'find'].some((word) => words.has(word)) ? 'read'
      : ['write', 'save', 'set', 'update', 'persist', 'store']
        .some((word) => words.has(word)) ? 'write' : undefined
  const kinds: readonly ObligationKind[] = intent === 'locate' ? ['subject']
    : intent === 'explain' ? ['subject', 'behavior']
      : ['subject', 'entry', 'stage', 'handoff', 'behavior', 'ordering', 'terminal']
  const residual = sorted.filter((token) => !lexicalTokens(subject).includes(token))
  const actions = phrase.split(' ').filter((token) => BEHAVIOR.has(token))
  const behavior = [...new Set(residual.length > 0 ? residual : actions)].join(' ')
  return {
    status: 'supported',
    plan: {
      intent, subject, terms: sorted,
      obligations: kinds.map((kind, index): QueryObligation => ({
        id: `o${index + 1}`, kind,
        target: kind === 'entry' ? bounds.entry ?? subject
          : kind === 'stage' ? bounds.stage ?? subject
            : kind === 'terminal' ? bounds.terminal ?? subject
              : kind === 'behavior' && intent === 'explain' && behavior
                ? behavior : subject,
        mandatory: true,
      })),
      ...(access ? { access } : {}),
    },
  }
}
