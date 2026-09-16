#!/usr/bin/env node

// Prints the spoken commands a session answers to, as the server resolves them: the locale
// file, then phrases.jsonc, the profile, and the launch flags. `/handsfree commands` runs it
// so the skill answers "what can I say" from the config instead of from memory.

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { exitWithError, printHelpIfAsked } from './cli.mjs'
import { EFFORT_WORDS, loadConfig, MODEL_WORDS, VOICE_ROOT } from './config.mjs'
import { ARG_PLACEHOLDERS } from './phrases.mjs'

// What each call does, in one line, so the list reads without the code.
const CALL_MEANS = {
  send: 'sends what you said so far as a message and ends your turn',
  interrupt: 'stops the reply that is being read aloud',
  stop: 'stops listening for the rest of the session; type start voice or /handsfree to listen again',
  pause: 'keeps the microphone open but ignores speech until the resume phrase',
  resume: 'listens again after a pause',
  clipboard: 'attaches the clipboard text to the next message',
  replay: 'reads a recent reply again; a number word after it picks which one, 1 is the latest',
  switchModel: 'asks to switch the model, and optionally the effort, for the rest of the session',
  help: 'reads the first phrase of every command aloud',
}

export function formatCommands(config) {
  const lines = []
  const prefix = config.commandPrefix.trim()
  lines.push(`Spoken commands (locale ${config.locale}, prefix ${prefix ? `"${prefix}"` : 'none'})`)
  lines.push('Matching ignores case, punctuation, and accents, and looks at the end of what you have said so far.')
  for (const [key, entry] of Object.entries(config.commands)) {
    const fixed = Object.entries(entry.args)
      .filter(([name, value]) => value !== ARG_PLACEHOLDERS[name])
      .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    const args = fixed.length ? ` (${fixed.join(', ')})` : ''
    lines.push(`  ${key}: say ${entry.say.map((p) => `"${p}"`).join(' or ')}`)
    lines.push(`    ${entry.call}${args}: ${CALL_MEANS[entry.call]}`)
  }
  lines.push('Answers to a permission prompt (never take the prefix):')
  for (const group of ['yes', 'no']) lines.push(`  ${group}: ${config.answers[group].join(', ')}`)
  // config.numbers is word to reply; the list reads better the other way round.
  const byReply = {}
  for (const [word, n] of Object.entries(config.numbers)) {
    byReply[n] ??= []
    byReply[n].push(word)
  }
  lines.push('Number words after the replay phrase:')
  for (const [n, words] of Object.entries(byReply)) lines.push(`  ${n}: ${words.join(', ')}`)
  lines.push(`Model words after the switch phrase: ${[...new Set(Object.values(MODEL_WORDS))].join(', ')}`)
  lines.push(`Effort words: ${[...new Set(Object.values(EFFORT_WORDS))].join(', ')}`)
  const sources = [`locales/${config.locale}.json`]
  if (!config.sources.phrasesExample) sources.push(config.sources.phrases)
  if (config.sources.profile) sources.push(`profile ${config.sources.profile}`)
  if (config.sources.overrides.length) sources.push(`flags ${config.sources.overrides.join(', ')}`)
  lines.push(`Sources, later wins: ${sources.join(', ')}`)
  return lines.join('\n')
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  printHelpIfAsked(`
Print the spoken commands a session answers to, resolved the way the server resolves them.

Examples:
  npm run commands                          the shipped phrases plus phrases.jsonc and the profile
  CLAUDE_VOICE_ROOT=/other npm run commands  the same for another install folder

Flags:
  --help, -h     this text
`)
  const config = loadConfig({
    root: VOICE_ROOT,
    env: process.env,
    fail: (msg) => exitWithError(`claude-code-handsfree: config: ${msg}`),
  })
  console.log(formatCommands(config))
}
