#!/usr/bin/env node

import { copyFileSync, existsSync, lstatSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { exitOnCrash, flagValue, hasFlag, printHelpIfAsked, printLine, printSection } from './cli.mjs'
import { APP_NAME, ROOT, VOICE_ROOT } from './config.mjs'
import { CLAUDE_DIR, defaultRcFile, findRcBlocks, LEFTOVER_PATHS, RC_BLOCK_KEY, removeRcBlock } from './rc-block.mjs'
import { findRunningServers, isClaudeCommand, readActiveFlag, readProcessCommand } from './sessions.mjs'

printHelpIfAsked(`
Undo what setup wrote outside this folder: the shell command in your rc file and any leftovers in ~/.claude.

Examples:
  claude-code-handsfree --remove              ask before each deletion
  claude-code-handsfree --remove --dry-run    show what would be deleted, delete nothing
  claude-code-handsfree --remove --yes        delete without asking
  npm run remove -- --yes                     the same once the shell command is gone

Flags:
  --yes, -y      answer yes to every question
  --dry-run      delete nothing
  --rc FILE      the rc file to clean (default ~/.zshrc, or ~/.bashrc under bash)
  --help, -h     this text
`)
exitOnCrash('claude-code-handsfree --remove')
const IS_YES = hasFlag('--yes', '-y')
const IS_DRY_RUN = hasFlag('--dry-run')
const RC = flagValue('--rc', defaultRcFile()).replace(/^~/, homedir())

// Piped answers are read up front because readline drops lines that arrive before their question when stdin is not a terminal.
const piped = stdin.isTTY ? null : readFileSync(0, 'utf8').split('\n')
const rl = stdin.isTTY
  ? createInterface({ input: stdin, output: stdout })
  : {
      question: async (q) => {
        stdout.write(q)
        const a = piped.shift() ?? ''
        printLine(a)
        return a
      },
      close() {},
    }
async function confirm(question, fallback = true) {
  if (IS_YES) return fallback
  const a = (await rl.question(`${question} (y/n) [${fallback ? 'y' : 'n'}]: `)).trim()
  return a ? /^y/i.test(a) : fallback
}
function removeFile(path) {
  if (IS_DRY_RUN) {
    printLine(`  dry-run: would delete ${path}`)
    return
  }
  unlinkSync(path)
  printLine(`  deleted ${path}`)
}
function writeText(path, content) {
  if (IS_DRY_RUN) {
    printLine(`  dry-run: would write ${path}`)
    return
  }
  writeFileSync(path, content)
  printLine(`  wrote ${path}`)
}
function backupFile(path) {
  if (IS_DRY_RUN || !existsSync(path)) return
  const dst = `${path}.bak-${Date.now()}`
  copyFileSync(path, dst)
  printLine(`  backup ${dst}`)
}
printLine(`${APP_NAME} remove${IS_DRY_RUN ? ' (dry run, nothing is written)' : ''}`)
let touched = 0

printSection('== Running sessions')
const active = readActiveFlag(VOICE_ROOT)
if (active?.alive)
  printLine(
    `  a voice session is listening (server pid ${active.pid}). It keeps working until it exits; it is not touched here.`,
  )
else if (active)
  printLine(`  none (a stale state/active.json names pid ${active.pid}; the folder can be deleted as a whole)`)
else printLine('  none')
for (const server of findRunningServers()) {
  if (isClaudeCommand(readProcessCommand(server.ppid))) continue
  printLine(`  server pid ${server.pid} has no claude session; end it with: kill ${server.pid}`)
}

printSection(`== The ${RC_BLOCK_KEY} block in ${RC}`)
let rcText = ''
try {
  rcText = readFileSync(RC, 'utf8')
} catch {}
const rcBlocks = findRcBlocks(rcText)
if (!rcBlocks.length) printLine(`  no "${RC_BLOCK_KEY}" block in ${RC}; nothing to remove`)
else {
  printLine(rcBlocks.length > 1 ? `  These ${rcBlocks.length} blocks go:\n` : '  This block goes:\n')
  printLine(
    rcBlocks
      .map((b) =>
        b.block
          .split('\n')
          .map((l) => `    ${l}`)
          .join('\n'),
      )
      .join('\n\n'),
  )
  printLine()
  if (await confirm(rcBlocks.length > 1 ? '  Remove them?' : '  Remove it?')) {
    backupFile(RC)
    writeText(RC, removeRcBlock(rcText))
    touched++
    const body = rcBlocks[0].body
    const fn =
      (body.match(/(\w[\w-]*)\s*\(\)/) || body.match(/function\s+(\w[\w-]*)/) || [])[1] || 'claude-code-handsfree'
    printLine(`  Open a new terminal, or run: unset -f ${fn}`)
  }
}

printSection(`== Leftovers in ${CLAUDE_DIR} from older versions`)
const settingsPath = join(CLAUDE_DIR, 'settings.json')
let settings = null
try {
  settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
} catch {}
if (settings) {
  const allow = settings.permissions?.allow ?? []
  const stops = settings.hooks?.Stop ?? []
  const hasAllow = allow.includes('mcp__voice__*')
  const hasStop = stops.some((g) => JSON.stringify(g).includes('speak-reply.py'))
  if (!hasAllow && !hasStop) printLine(`  settings.json: nothing of ours`)
  else {
    if (hasAllow)
      printLine(`  settings.json: permissions.allow has "mcp__voice__*" (launch.mjs passes --allowedTools now)`)
    if (hasStop)
      printLine(`  settings.json: a Stop hook runs speak-reply.py (hooks/hooks.json registers it per session now)`)
    if (await confirm(`  Remove ${hasAllow && hasStop ? 'both' : 'it'} from settings.json (a backup is kept)?`)) {
      if (hasAllow) settings.permissions.allow = allow.filter((r) => r !== 'mcp__voice__*')
      if (hasStop) {
        settings.hooks.Stop = stops
          .map((g) => ({
            ...g,
            hooks: (g.hooks ?? []).filter((h) => !String(h.command ?? '').includes('speak-reply.py')),
          }))
          .filter((g) => g.hooks.length)
        if (!settings.hooks.Stop.length) delete settings.hooks.Stop
      }
      backupFile(settingsPath)
      writeText(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
      touched++
    }
  }
} else printLine(`  settings.json: absent or unreadable, skipped`)

// The skill symlink is handled below, because it is deleted only when it points into this folder.
for (const [leftover, what] of LEFTOVER_PATHS) {
  if (leftover === 'skills/handsfree') continue
  const path = join(CLAUDE_DIR, leftover)
  if (!existsSync(path)) continue
  if (await confirm(`  Delete ${path} (${what})?`)) {
    removeFile(path)
    touched++
  }
}
const skillLink = join(CLAUDE_DIR, 'skills', 'handsfree')
try {
  const st = lstatSync(skillLink)
  const target = st.isSymbolicLink() ? resolve(dirname(skillLink), readlinkSync(skillLink)) : ''
  // A symlink from an earlier install points at skills/handsfree in this clone, not at plugin/skills/handsfree.
  if (target.startsWith(ROOT + sep)) {
    if (await confirm(`  Delete the symlink ${skillLink} (the plugin ships the skill per session now)?`)) {
      removeFile(skillLink)
      touched++
    }
  } else printLine(`  ${skillLink} exists but is not a symlink into this folder; left alone`)
} catch {}

rl.close()
printLine(
  touched
    ? `\nRemoved ${touched} thing(s). Nothing of ${APP_NAME} is left outside this folder.`
    : '\nNothing to remove.',
)
printLine(`Next: delete the folder, which holds everything else, hear included: rm -rf ${JSON.stringify(ROOT)}`)
