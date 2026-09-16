import { homedir } from 'node:os'
import { basename, join } from 'node:path'

// Everything an install has ever put outside this folder: the rc block, and files older versions wrote into ~/.claude.

export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
// Paths under CLAUDE_DIR that older versions wrote, each with what it was; check notes them and remove deletes them.
export const LEFTOVER_PATHS = [
  ['hooks/speak-reply.py', 'the copied Stop hook'],
  ['skills/handsfree', 'the skill symlink from an earlier install'],
  ['speak-on', 'the speak-on flag'],
  ['voice-channel-active', 'the old active flag'],
  ['voice-next-model', 'the old model-switch marker'],
]

// The rc file the shell function goes in: ~/.bashrc under bash, else ~/.zshrc.
export function defaultRcFile(env = process.env) {
  return join(homedir(), basename(env.SHELL || 'zsh') === 'bash' ? '.bashrc' : '.zshrc')
}

// "#" starts a comment in zsh, bash, and fish.
export const RC_BLOCK_KEY = 'claude-code-handsfree'
export const RC_BLOCK_BEGIN = `# >>> ${RC_BLOCK_KEY} >>>`
export const RC_BLOCK_END = `# <<< ${RC_BLOCK_KEY} <<<`

// A begin marker with no end marker is not a block, because cutting to the end of the file would take the rest of the rc with it.
export function findRcBlocks(text) {
  const lines = text.split('\n')
  const blocks = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== RC_BLOCK_BEGIN) continue
    const end = lines.findIndex((l, j) => j > i && l.trim() === RC_BLOCK_END)
    if (end < 0) break
    blocks.push({ start: i, end, body: lines.slice(i + 1, end).join('\n'), block: lines.slice(i, end + 1).join('\n') })
    i = end
  }
  return blocks
}

export function findRcBlock(text) {
  return findRcBlocks(text)[0] ?? null
}

export function addRcBlock(text, body) {
  const block = `${RC_BLOCK_BEGIN}\n${body}\n${RC_BLOCK_END}`
  const first = findRcBlock(text)
  if (!first) {
    const before = text.replace(/\n+$/, '')
    return before ? `${before}\n\n${block}\n` : `${block}\n`
  }
  const lines = text.split('\n')
  const rest = removeRcBlock(lines.slice(first.end + 1).join('\n'))
  return [...lines.slice(0, first.start), block, ...rest.split('\n')].join('\n')
}

export function removeRcBlock(text) {
  const lines = text.split('\n')
  for (const found of findRcBlocks(text).reverse()) {
    let start = found.start
    if (start > 0 && lines[start - 1].trim() === '') start--
    lines.splice(start, found.end + 1 - start)
  }
  return lines.join('\n')
}
