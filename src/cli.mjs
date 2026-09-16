// What every command here shares, after the Command Line Interface Guidelines (clig.dev): --help that leads
// with examples, brief output on success, colour only on a terminal, an error that is one sentence and the
// command that fixes it, and one closing line that names the next command.
import { stdout } from 'node:process'

export const ARGV = process.argv.slice(2)
export const hasFlag = (...names) => names.some((n) => ARGV.includes(n))
export function flagValue(name, fallback) {
  const i = ARGV.indexOf(name)
  return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : fallback
}
export const IS_VERBOSE = hasFlag('--verbose', '-v')

const HAS_COLOR = Boolean(stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb'
const paint = (code) => (s) => (HAS_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s)
export const green = paint('32')
export const red = paint('31')
export const yellow = paint('33')
export const dim = paint('2')
export const bold = paint('1')

export const printLine = (s = '') => console.log(s)
export const printSection = (title) => console.log(`\n${title}`)
// A row is a six-wide tag and a message: ok, FAIL, WARN, note, and the setup verbs.
export const printRow = (tag, msg, color = (s) => s) => console.log(`  ${color(tag.padEnd(6))}${msg}`)
export const printOkRow = (msg) => printRow('ok', msg, green)
export const printFailRow = (msg) => printRow('FAIL', msg, red)
export const printWarnRow = (msg) => printRow('WARN', msg, yellow)

// Prints the text and exits when --help or -h is present; every command calls it before doing anything else.
export function printHelpIfAsked(text) {
  if (!hasFlag('--help', '-h')) return
  console.log(text.trim())
  process.exit(0)
}

// One sentence on stderr, then the exit code; message must already name the fix.
export function exitWithError(message, code = 1) {
  console.error(message)
  process.exit(code)
}

// An unexpected error is one line for a person; the trace is there behind --verbose.
export function exitOnCrash(command) {
  const onError = (e) => {
    console.log(`\n${red('error')}  ${e?.message || e}`)
    if (IS_VERBOSE) console.log(e?.stack || '')
    else console.log(`  Rerun with --verbose for the trace: ${command} --verbose`)
    process.exit(1)
  }
  process.on('uncaughtException', onError)
  process.on('unhandledRejection', onError)
}
