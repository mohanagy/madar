import { describe, expect, it } from 'vitest'

import { getBuiltInSkillContent } from '../../src/infrastructure/install-skill-templates.js'
import {
  SKILL_INSTALL_PLATFORMS,
  type SkillInstallPlatform,
} from '../../src/infrastructure/install.js'

describe('built-in install templates', () => {
  it.each(SKILL_INSTALL_PLATFORMS)(
    'installs unconditional one-retrieve guidance for %s',
    (platform: SkillInstallPlatform) => {
      const content = getBuiltInSkillContent(platform)

      expect(content).toContain('call the Madar `retrieve` MCP tool exactly once')
      expect(content).toContain("user's question unchanged")
      expect(content).toContain('authenticated excerpts and stored relationships')
      expect(content).toContain('report the explicit boundary')
      expect(content).toContain('Enable project hooks and local MCP servers only in repositories you trust')
      expect(content).not.toContain('context_pack')
      expect(content).not.toContain('context-pack')
      expect(content).not.toContain('profile')
      expect(content).not.toContain('confidence')
    },
  )

  it('uses a PowerShell example only for the Windows skill', () => {
    expect(getBuiltInSkillContent('windows')).toContain('```powershell')
    expect(getBuiltInSkillContent('claude')).toContain('```bash')
  })
})
