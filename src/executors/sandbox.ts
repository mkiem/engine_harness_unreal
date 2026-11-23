/**
 * Runtime sandbox & PreToolUse policy enforcement for headless agent workers.
 * Enforces `preset.blockedCommands` and workspace-boundary checks at the tool-hook boundary
 * instead of relying solely on prompt instructions or environment hints.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

export interface PolicyCheck {
  allowed: boolean
  reason?: string
  matched?: string
}

/** Evaluates a shell command against a preset's blocked command patterns (prefix or substring token match). */
export function checkCommandPolicy(command: string, blockedCommands: readonly string[]): PolicyCheck {
  const normalized = command.trim().replace(/\s+/g, ' ')
  for (const rule of blockedCommands) {
    const trimmed = rule.trim()
    if (!trimmed) continue
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
    const regex = new RegExp(`(^|[;&|(\`]\\s*)${escaped}(\\s|$|[;&|)])`, 'i')
    if (regex.test(normalized)) {
      return { allowed: false, matched: trimmed, reason: `command blocked by harness preset policy: "${trimmed}"` }
    }
  }
  return { allowed: true }
}

/** Verifies that a target file path stays inside the allowed workspace roots. */
export function isWithinAllowedRoots(targetPath: string, allowedRoots: readonly string[]): boolean {
  const target = resolve(targetPath)
  return allowedRoots.some(root => {
    const rel = relative(resolve(root), target)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  })
}

/**
 * Writes a deterministic PreToolUse hook script + Claude Code local settings file into the ticket directory
 * so `blockedCommands` are enforced by the host runtime before any shell tool executes.
 */
export function writeSandboxHooks(ticketDir: string, blockedCommands: readonly string[]): { policyFile: string; hookScript: string; claudeSettings: string } {
  const policyFile = join(ticketDir, 'harness-policy.json')
  const hookScript = join(ticketDir, 'harness-pretool-hook.mjs')
  const claudeDir = join(ticketDir, '.claude')
  const claudeSettings = join(claudeDir, 'settings.local.json')

  writeFileSync(policyFile, `${JSON.stringify({ blockedCommands: [...blockedCommands], ticketDir: resolve(ticketDir) }, null, 2)}\n`)
  writeFileSync(hookScript, [
    "import { readFileSync } from 'node:fs'",
    `const blocked = ${JSON.stringify([...blockedCommands])}`,
    "const raw = readFileSync(0, 'utf8').trim()",
    "if (!raw) process.exit(0)",
    "let payload = {}",
    "try { payload = JSON.parse(raw) } catch { process.exit(0) }",
    "const cmd = String(payload?.tool_input?.command ?? payload?.input?.command ?? '')",
    "if (!cmd) process.exit(0)",
    "const norm = cmd.trim().replace(/\\s+/g, ' ')",
    "for (const rule of blocked) {",
    "  const t = String(rule).trim()",
    "  if (!t) continue",
    "  const rx = new RegExp('(^|[;&|(`]\\\\s*)' + t.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&').replace(/\\s+/g, '\\\\s+') + '(\\\\s|$|[;&|)])', 'i')",
    "  if (rx.test(norm)) {",
    "    process.stderr.write(`Blocked by engine-harness policy: ${t}\\n`)",
    "    process.exit(2)",
    "  }",
    "}",
    '',
  ].join('\n'))

  mkdirSync(claudeDir, { recursive: true })
  writeFileSync(claudeSettings, `${JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash|Shell|terminal',
          hooks: [{ type: 'command', command: `node "${hookScript.replace(/\\/g, '/')}"` }],
        },
      ],
    },
  }, null, 2)}\n`)

  return { policyFile, hookScript, claudeSettings }
}

