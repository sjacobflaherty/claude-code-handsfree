// What every command here shares, after the Command Line Interface Guidelines (clig.dev): --help that leads
// with examples, brief output on success, colour only on a terminal, an error that is one sentence and the
// command that fixes it, and one closing line that names the next command.
import { stdout } from 'node:process'

export const args = process.argv.slice(2)
export const flag = (...names) => names.some((n) => args.includes(n))
export function value(name, fallback) {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
export const VERBOSE = flag('--verbose', '-v')

const COLOR = Boolean(stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb'
const paint = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s)
export const green = paint('32')
export const red = paint('31')
export const yellow = paint('33')
export const dim = paint('2')
export const bold = paint('1')

// A row is a six-wide tag and a message: ok, FAIL, WARN, note, and the setup verbs.
export const row = (tag, msg, color = (s) => s) => console.log(`  ${color(tag.padEnd(6))}${msg}`)
export const ok = (msg) => row('ok', msg, green)
export const fail = (msg) => row('FAIL', msg, red)
export const warn = (msg) => row('WARN', msg, yellow)

// Prints the text and exits when --help or -h is present; every command calls it before doing anything else.
export function help(text) {
  if (!flag('--help', '-h')) return
  console.log(text.trim())
  process.exit(0)
}

// An unexpected error is one line for a person; the trace is there behind --verbose.
export function onCrash(command) {
  const handler = (e) => {
    console.log(`\n${red('error')}  ${e?.message || e}`)
    if (VERBOSE) console.log(e?.stack || '')
    else console.log(`  Rerun with --verbose for the trace: ${command} --verbose`)
    process.exit(1)
  }
  process.on('uncaughtException', handler)
  process.on('unhandledRejection', handler)
}
