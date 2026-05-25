import { describe, expect, it } from 'vitest'

import { parseSyncArgs } from '../../src/cli/parser.js'

describe('parseSyncArgs', () => {
  it('passes the dry run flag into the sync command', () => {
    expect(parseSyncArgs(['--dry-run'])).toEqual({ dryRun: true })
  })
})
