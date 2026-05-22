import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { findGitRoot } from '../shared/git.js'

export const HOOK_MARKER = '# sadeem-hook-start'
const HOOK_MARKER_END = '# sadeem-hook-end'
export const CHECKOUT_MARKER = '# sadeem-checkout-hook-start'
const CHECKOUT_MARKER_END = '# sadeem-checkout-hook-end'

const HOOK_SCRIPT = `${HOOK_MARKER}
# Installed by sadeem
CHANGED=$(git diff --name-only HEAD~1 HEAD 2>/dev/null || git diff --name-only HEAD 2>/dev/null)
if [ -n "$CHANGED" ]; then
  echo "[sadeem] Changes detected - rebuild the out bundle if needed."
fi
${HOOK_MARKER_END}
`

const CHECKOUT_SCRIPT = `${CHECKOUT_MARKER}
# Installed by sadeem
echo "[sadeem] Branch switched - rebuild the out bundle if needed."
${CHECKOUT_MARKER_END}
`

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function ensureExecutable(hookPath: string): void {
  if ((statSync(hookPath).mode & 0o111) === 0) {
    chmodSync(hookPath, 0o755)
  }
}

function installHook(hooksDir: string, name: string, script: string, marker: string): string {
  const hookPath = join(hooksDir, name)
  if (existsSync(hookPath)) {
    const content = readFileSync(hookPath, 'utf8')
    if (content.includes(marker)) {
      return `already installed at ${hookPath}`
    }
    const nextContent = `${content.replace(/\s*$/, '')}\n\n${script}`
    writeFileSync(hookPath, nextContent, 'utf8')
    ensureExecutable(hookPath)
    return `appended to existing ${name} hook at ${hookPath}`
  }

  writeFileSync(hookPath, `#!/bin/sh\n${script}`, 'utf8')
  chmodSync(hookPath, 0o755)
  return `installed at ${hookPath}`
}

function uninstallHook(hooksDir: string, name: string, marker: string, markerEnd: string): string {
  const hookPath = join(hooksDir, name)
  if (!existsSync(hookPath)) {
    return `no ${name} hook found - nothing to remove.`
  }

  const content = readFileSync(hookPath, 'utf8')
  if (!content.includes(marker)) {
    return `sadeem hook not found in ${name} - nothing to remove.`
  }

  const nextContent = content.replace(new RegExp(`${escapeRegExp(marker)}[\\s\\S]*?${escapeRegExp(markerEnd)}\\n?`, 'g'), '').trim()
  if (!nextContent || nextContent === '#!/bin/bash' || nextContent === '#!/bin/sh') {
    unlinkSync(hookPath)
    return `removed ${name} hook at ${hookPath}`
  }

  writeFileSync(hookPath, `${nextContent}\n`, 'utf8')
  ensureExecutable(hookPath)
  return `sadeem removed from ${name} at ${hookPath} (other hook content preserved)`
}

export function install(path = '.'): string {
  const root = findGitRoot(path)
  if (!root) {
    throw new Error(`No git repository found at or above ${resolve(path)}`)
  }

  const hooksDir = join(root, '.git', 'hooks')
  mkdirSync(hooksDir, { recursive: true })
  const postCommit = installHook(hooksDir, 'post-commit', HOOK_SCRIPT, HOOK_MARKER)
  const postCheckout = installHook(hooksDir, 'post-checkout', CHECKOUT_SCRIPT, CHECKOUT_MARKER)
  return `post-commit: ${postCommit}\npost-checkout: ${postCheckout}`
}

export function uninstall(path = '.'): string {
  const root = findGitRoot(path)
  if (!root) {
    throw new Error(`No git repository found at or above ${resolve(path)}`)
  }

  const hooksDir = join(root, '.git', 'hooks')
  const postCommit = uninstallHook(hooksDir, 'post-commit', HOOK_MARKER, HOOK_MARKER_END)
  const postCheckout = uninstallHook(hooksDir, 'post-checkout', CHECKOUT_MARKER, CHECKOUT_MARKER_END)
  return `post-commit: ${postCommit}\npost-checkout: ${postCheckout}`
}

export function status(path = '.'): string {
  const root = findGitRoot(path)
  if (!root) {
    return 'Not in a git repository.'
  }

  const hooksDir = join(root, '.git', 'hooks')
  const describeHook = (name: string, marker: string): string => {
    const hookPath = join(hooksDir, name)
    if (!existsSync(hookPath)) {
      return 'not installed'
    }
    return readFileSync(hookPath, 'utf8').includes(marker) ? 'installed' : 'not installed (hook exists but sadeem not found)'
  }

  return `post-commit: ${describeHook('post-commit', HOOK_MARKER)}\npost-checkout: ${describeHook('post-checkout', CHECKOUT_MARKER)}`
}
