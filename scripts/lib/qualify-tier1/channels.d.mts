/** How one consumer-visible string channel of a context artifact is treated. */
export type ChannelRole = 'path' | 'symbol' | 'snippet' | 'ignored'

export interface ChannelClassification {
  readonly channel: string
  readonly role: ChannelRole
  /** `strict` is selected evidence; `generous` adds pointers. Null when ignored. */
  readonly tier?: 'strict' | 'generous' | null
  /** Why an ignored channel is not evidence about the target. */
  readonly reason?: string
  /**
   * Optional shape test on the containing object, for polymorphic channels such
   * as `workflow_centers[]`, whose entries are graph nodes for some task kinds
   * and communities for others.
   */
  readonly guard?: (parent: unknown) => boolean
}

/** Every string channel a context artifact can present, classified exactly once. */
export declare const EVIDENCE_CHANNELS: readonly ChannelClassification[]

export declare function channelFor(channel: string): ChannelClassification | null

/** Collapse array indices so `.a[3].b` and `.a[7].b` are one channel. */
export declare function genericChannel(schemaPath: string): string

export interface StringLeaf {
  readonly schemaPath: string
  readonly channel: string
  readonly value: string
  readonly parent: Record<string, unknown> | null
}

export declare function stringLeaves(node: unknown, schemaPath?: string, parent?: unknown): Generator<StringLeaf>
