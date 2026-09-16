#!/usr/bin/env node

import { copyFileSync, existsSync, lstatSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { flag, help, onCrash, value } from './cli.mjs'
import { APP_NAME, findRunningServers, isClaudeCommand, ROOT, readActiveFlag, readProcessCommand } from './config.mjs'
import { findRcBlocks, RC_BLOCK_KEY, removeRcBlock } from './rc-block.mjs'

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
// The folder holding state/, which the tests point elsewhere.
const REMOVE_ROOT = process.env.CLAUDE_VOICE_ROOT || ROOT
help(`
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
onCrash('claude-code-handsfree --remove')
const YES = flag('--yes', '-y')
const DRY = flag('--dry-run')
const shellName = basename(process.env.SHELL || 'zsh')
const RC = value('--rc', join(homedir(), shellName === 'bash' ? '.bashrc' : '.zshrc')).replace(/^~/, homedir())

// Piped answers are read up front because readline drops lines that arrive before their question when stdin is not a terminal.
const piped = stdin.isTTY ? null : readFileSync(0, 'utf8').split('\n')
const rl = stdin.isTTY
  ? createInterface({ input: stdin, output: stdout })
  : {
      question: async (q) => {
        stdout.write(q)
        const a = piped.shift() ?? ''
        say(a)
        return a
      },
      close() {},
    }
const say = (s = '') => console.log(s)
const step = (s) => console.log(`\n== ${s}`)
async function confirm(question, fallback = true) {
  if (YES) return fallback
  const a = (await rl.question(`${question} (y/n) [${fallback ? 'y' : 'n'}]: `)).trim()
  return a ? /^y/i.test(a) : fallback
}
function remove(path) {
  if (DRY) {
    say(`  dry-run: would delete ${path}`)
    return
  }
  unlinkSync(path)
  say(`  deleted ${path}`)
}
function write(path, content) {
  if (DRY) {
    say(`  dry-run: would write ${path}`)
    return
  }
  writeFileSync(path, content)
  say(`  wrote ${path}`)
}
function backup(path) {
  if (DRY || !existsSync(path)) return
  const dst = `${path}.bak-${Date.now()}`
  copyFileSync(path, dst)
  say(`  backup ${dst}`)
}
say(`${APP_NAME} remove${DRY ? ' (dry run, nothing is written)' : ''}`)
let touched = 0

step('Running sessions')
const active = readActiveFlag(REMOVE_ROOT)
if (active?.alive)
  say(
    `  a voice session is listening (server pid ${active.pid}). It keeps working until it exits; it is not touched here.`,
  )
else if (active) say(`  none (a stale state/active.json names pid ${active.pid}; the folder can be deleted as a whole)`)
else say('  none')
for (const server of findRunningServers()) {
  if (isClaudeCommand(readProcessCommand(server.ppid))) continue
  say(`  server pid ${server.pid} has no claude session; end it with: kill ${server.pid}`)
}

step(`The ${RC_BLOCK_KEY} block in ${RC}`)
let rcText = ''
try {
  rcText = readFileSync(RC, 'utf8')
} catch {}
const rcBlocks = findRcBlocks(rcText)
if (!rcBlocks.length) say(`  no "${RC_BLOCK_KEY}" block in ${RC}; nothing to remove`)
else {
  say(rcBlocks.length > 1 ? `  These ${rcBlocks.length} blocks go:\n` : '  This block goes:\n')
  say(
    rcBlocks
      .map((b) =>
        b.block
          .split('\n')
          .map((l) => `    ${l}`)
          .join('\n'),
      )
      .join('\n\n'),
  )
  say()
  if (await confirm(rcBlocks.length > 1 ? '  Remove them?' : '  Remove it?')) {
    backup(RC)
    write(RC, removeRcBlock(rcText))
    touched++
    const body = rcBlocks[0].body
    const fn =
      (body.match(/(\w[\w-]*)\s*\(\)/) || body.match(/function\s+(\w[\w-]*)/) || [])[1] || 'claude-code-handsfree'
    say(`  Open a new terminal, or run: unset -f ${fn}`)
  }
}

step(`Leftovers in ${CLAUDE_DIR} from older versions`)
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
  if (!hasAllow && !hasStop) say(`  settings.json: nothing of ours`)
  else {
    if (hasAllow) say(`  settings.json: permissions.allow has "mcp__voice__*" (launch.mjs passes --allowedTools now)`)
    if (hasStop) say(`  settings.json: a Stop hook runs speak-reply.py (hooks/hooks.json registers it per session now)`)
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
      backup(settingsPath)
      write(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
      touched++
    }
  }
} else say(`  settings.json: absent or unreadable, skipped`)

const files = [
  [join(CLAUDE_DIR, 'hooks', 'speak-reply.py'), 'the copied Stop hook'],
  [join(CLAUDE_DIR, 'speak-on'), 'the speak-on flag'],
  [join(CLAUDE_DIR, 'voice-channel-active'), 'the old active flag'],
  [join(CLAUDE_DIR, 'voice-next-model'), 'the old model-switch marker'],
]
for (const [path, what] of files) {
  if (!existsSync(path)) continue
  if (await confirm(`  Delete ${path} (${what})?`)) {
    remove(path)
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
      remove(skillLink)
      touched++
    }
  } else say(`  ${skillLink} exists but is not a symlink into this folder; left alone`)
} catch {}

rl.close()
say(
  touched
    ? `\nRemoved ${touched} thing(s). Nothing of ${APP_NAME} is left outside this folder.`
    : '\nNothing to remove.',
)
say(`Next: delete the folder, which holds everything else, hear included: rm -rf ${JSON.stringify(ROOT)}`)
