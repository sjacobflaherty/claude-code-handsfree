import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { formatCommands } from '../src/commands.mjs'
import { COMMAND_CALLS, loadConfig } from '../src/config.mjs'
import { cleanupRoots, makeRoot, refuseOnFail } from './fixture-root.mjs'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(REPO, 'src', 'commands.mjs')

afterAll(cleanupRoots)

const load = (root, env = {}) => loadConfig({ root, env, fail: refuseOnFail([]) })

describe('formatCommands', () => {
  it('lists every shipped command with its phrases and every call with a meaning', () => {
    const text = formatCommands(load(makeRoot()))
    expect(text).toContain('Spoken commands (locale en, prefix none)')
    expect(text).toContain('send: say "send message"')
    expect(text).toContain('interrupt: say "interrupt message" or "stop message"')
    expect(text).toContain('help: say "voice help"')
    for (const call of Object.keys(COMMAND_CALLS)) expect(text).toMatch(new RegExp(`^    ${call}: \\S`, 'm'))
    expect(text).toContain('yes: yes, yeah, yep, approve, allow')
    expect(text).toContain('2: two, to, too')
    expect(text).toContain('Model words after the switch phrase: opus, sonnet, haiku, fable')
  })

  it('shows the user phrases, the prefix, and the profile once they override the shipped ones', () => {
    const root = makeRoot({
      settings: { profile: 'desk' },
      phrases: {
        commandPrefix: 'hey voice',
        overrides: { en: { commands: { send: { say: ['ship it'], call: 'send' } } } },
      },
      profiles: {
        desk: { phrases: { overrides: { en: { commands: { quiet: { say: ['go quiet'], call: 'pause' } } } } } },
      },
    })
    const text = formatCommands(load(root))
    expect(text).toContain('prefix "hey voice"')
    expect(text).toContain('send: say "hey voice ship it"')
    expect(text).not.toContain('send message')
    expect(text).toContain('quiet: say "hey voice go quiet"')
    expect(text).toContain(
      `Sources, later wins: locales/en.json, ${join(root, 'phrases.jsonc')}, profile ${join(root, 'profiles', 'desk')}`,
    )
  })

  it('prints a fixed argument next to the call and hides placeholders', () => {
    const root = makeRoot({
      phrases: {
        overrides: { en: { commands: { last: { say: ['say that again'], call: 'replay', args: { n: 1 } } } } },
      },
    })
    const text = formatCommands(load(root))
    expect(text).toContain('last: say "say that again"')
    expect(text).toContain('    replay (n=1):')
    expect(text).toMatch(/^ {4}replay: reads/m)
  })
})

describe('node src/commands.mjs', () => {
  it('prints the list for CLAUDE_VOICE_ROOT and exits 0', () => {
    const run = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_VOICE_ROOT: makeRoot() },
    })
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('send: say "send message"')
  })

  it('names the bad key and exits 1 on a config error', () => {
    const run = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_VOICE_ROOT: makeRoot({
          phrases: { overrides: { en: { commands: { x: { say: ['x'], call: 'nope' } } } } },
        }),
      },
    })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('commands.x.call')
  })
})
