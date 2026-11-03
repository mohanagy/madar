import { resolve } from 'node:path'
import { readVerifiedSourceSnapshot } from './source-continuation.js'

type ObjectValue = Record<string, unknown>
const object = (v: unknown): v is ObjectValue => v !== null && typeof v === 'object' && !Array.isArray(v)
interface FileProgress { fingerprint: string; seen: Set<number>; weak: number }

/** A scoped discovery circuit breaker, not a source-access or answerability policy. */
export class DiscoveryProgress {
  private readonly files = new Map<string, FileProgress>()
  private points = 0
  private disabled = false

  shouldStop(prompt: string, root: string): boolean {
    if (this.disabled) return false
    const names = [...new Set(prompt.match(/[A-Za-z0-9_@./[\]-]+\.[cm]?[jt]sx?\b/g) ?? [])]
    if (!names.length || names.length > 8) return false
    return names.every(file => {
      try {
        const prior = this.files.get(resolve(root, file))
        if (!prior || prior.weak < 2) return false
        const source = readVerifiedSourceSnapshot(file, root)
        return prior.fingerprint === this.fingerprint(source)
      } catch { return false } // Existing source policy/freshness handling retains control.
    })
  }

  private fingerprint(source: ReturnType<typeof readVerifiedSourceSnapshot>): string {
    return JSON.stringify([source.realRoot, source.canonical, source.hash, source.policyFingerprint])
  }

  observe(response: { result?: unknown; error?: unknown }, root: string, discovery: boolean): void {
    if (this.disabled || response.error || !object(response.result) || response.result.isError === true
      || !Array.isArray(response.result.content)) return
    const snapshots = new Map<string, ReturnType<typeof readVerifiedSourceSnapshot>>()
    const delivered = new Map<string, { fingerprint: string; positions: Set<number> }>()
    for (const item of response.result.content) {
      if (!object(item) || item.type !== 'text' || typeof item.text !== 'string') continue
      let payload: unknown
      try { payload = JSON.parse(item.text) } catch { continue }
      if (!object(payload) || !object(payload.pack) || !Array.isArray(payload.pack.matched_nodes)) continue
      for (const node of payload.pack.matched_nodes.slice(0, 64)) {
        if (!object(node) || typeof node.source_file !== 'string' || typeof node.snippet !== 'string'
          || node.snippet_unverified === true || node.snippet_source === 'derived' || !object(node.snippet_line_range)) continue
        const start = Number(node.snippet_line_range.start_line), end = Number(node.snippet_line_range.end_line)
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start > 8192) continue
        try {
          const logical = resolve(root, node.source_file)
          if (!snapshots.has(logical) && snapshots.size >= 8) continue
          const source = snapshots.get(logical) ?? readVerifiedSourceSnapshot(node.source_file, root)
          snapshots.set(logical, source)
          if (end > source.lines.length) continue
          const positions = new Set<number>()
          const gaps = node.snippet_omitted_ranges ?? []
          if (!Array.isArray(gaps) || gaps.length > 4096) continue
          let line = start, gapIndex = 0, valid = true
          for (const text of node.snippet.split('\n')) {
            const gap = gaps[gapIndex]
            if (object(gap) && gap.start_line === line) {
              const finish = Number(gap.end_line)
              if (!Number.isSafeInteger(finish) || finish < line || finish > end
                || text !== `[omitted lines ${line}-${finish}]`) { valid = false; break }
              line = finish + 1; gapIndex++
            } else {
              if (line > end || source.lines[line - 1] !== text) { valid = false; break }
              positions.add(line++)
            }
          }
          if (!valid || line !== end + 1 || gapIndex !== gaps.length || !positions.size) continue
          const key = resolve(root, node.source_file), fingerprint = this.fingerprint(source)
          const row = delivered.get(key) ?? { fingerprint, positions: new Set<number>() }
          if (row.fingerprint !== fingerprint) continue
          for (const position of positions) row.positions.add(position)
          delivered.set(key, row)
        } catch { /* Unavailable or changed source must never authorize a stop. */ }
      }
    }
    for (const [key, row] of delivered) {
      let prior = this.files.get(key)
      if (!prior || prior.fingerprint !== row.fingerprint) {
        if (prior) this.points -= prior.seen.size
        prior = { fingerprint: row.fingerprint, seen: new Set(), weak: 0 }
        this.files.set(key, prior)
      }
      const novel = [...row.positions].filter(line => !prior.seen.has(line))
      if (discovery) prior.weak = row.positions.size >= 16 && novel.length * 3 <= row.positions.size ? prior.weak + 1 : 0
      for (const line of novel) prior.seen.add(line)
      this.points += novel.length
      if (this.files.size > 32 || this.points > 16384) {
        this.files.clear(); this.points = 0; this.disabled = true
        return // Forgetting history cannot safely justify blocking discovery.
      }
    }
  }
}
