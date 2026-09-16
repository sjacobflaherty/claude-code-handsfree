import { readFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { PLUGIN_DIR, SRC } from '../src/config.mjs'
import { buildClaudeArgs, buildCue, buildLaunchPlan, buildSayArgs } from '../src/launch.mjs'
import { cleanupRoots, makeRoot, runRefusable } from './fixture-root.mjs'

afterAll(cleanupRoots)

const EN = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'))
// A second language the repository does not ship, so --locale has something other than en to pick.
const XX = { ...EN, strings: { ...EN.strings, launchCue: 'Xx press enter.' } }

function planFor(argv, { env = {}, isTTY = true, ...rootSpec } = {}) {
  const root = makeRoot({ localeFiles: { xx: XX }, ...rootSpec })
  const { value, refusal } = runRefusable((fail) =>
    buildLaunchPlan({ argv, env, root, sessionId: 'fixed-session-id', isTTY, fail }),
  )
  return { ...value, refusal }
}

function flagValue(args, flag) {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}

describe('buildLaunchPlan', () => {
  it('passes the plugin folder, the server path, and the tool allow rule to claude', () => {
    const { action, args } = planFor([])
    expect(action).toBe('launch')
    expect(flagValue(args, '--plugin-dir')).toBe(PLUGIN_DIR)
    expect(flagValue(args, '--allowedTools')).toBe('mcp__voice__*')
    expect(JSON.parse(flagValue(args, '--mcp-config'))).toEqual({
      mcpServers: { voice: { command: 'node', args: [`${SRC}/voice-channel.mjs`] } },
    })
    expect(flagValue(args, '--dangerously-load-development-channels')).toBe('server:voice')
  })

  it('takes the model and effort from the settings file', () => {
    const { args } = planFor([], { settings: { model: 'fable', effort: 'low' } })
    expect(flagValue(args, '--model')).toBe('fable')
    expect(flagValue(args, '--effort')).toBe('low')
  })

  it('passes neither flag when both are empty, which is what ships', () => {
    const { args } = planFor([])
    expect(args).not.toContain('--model')
    expect(args).not.toContain('--effort')
  })

  it('passes only the flag that has a value', () => {
    const { args } = planFor([], { settings: { model: 'fable' } })
    expect(flagValue(args, '--model')).toBe('fable')
    expect(args).not.toContain('--effort')
  })

  it('lets --model and --effort beat the settings file', () => {
    const { args } = planFor(['--model', 'fable', '--effort', 'max'], { settings: { model: 'opus', effort: 'high' } })
    expect(flagValue(args, '--model')).toBe('fable')
    expect(flagValue(args, '--effort')).toBe('max')
  })

  it('hands every flag it does not own to claude, in order and untouched', () => {
    const { args } = planFor(['--continue', '--model', 'fable', '--add-dir', '/tmp/somewhere', '-p', 'do the thing'])
    expect(args.slice(-5)).toEqual(['--continue', '--add-dir', '/tmp/somewhere', '-p', 'do the thing'])
  })

  it('starts a new session by id, and resumes that same id when asked', () => {
    const { args } = planFor([])
    expect(args.slice(-2)).toEqual(['--session-id', 'fixed-session-id'])
    expect(
      buildClaudeArgs({ sessionId: 'fixed-session-id', model: 'opus', effort: 'high', resume: true }).slice(-2),
    ).toEqual(['--resume', 'fixed-session-id'])
  })

  it('names the model on a resume and passes no --effort when the switch named none', () => {
    const args = buildClaudeArgs({ sessionId: 'fixed-session-id', model: 'fable', effort: '', resume: true })
    expect(flagValue(args, '--model')).toBe('fable')
    expect(args).not.toContain('--effort')
  })
})

describe('the environment claude inherits', () => {
  it('drops the child-session marker so a voice session keeps its transcript', () => {
    const { env } = planFor([], { env: { CLAUDE_CODE_CHILD_SESSION: '1', PATH: '/usr/bin' } })
    expect('CLAUDE_CODE_CHILD_SESSION' in env).toBe(false)
    expect(env.PATH).toBe('/usr/bin')
  })

  it('leaves the child-session marker alone when keepTranscript is false', () => {
    const { env } = planFor([], {
      env: { CLAUDE_CODE_CHILD_SESSION: '1', PATH: '/usr/bin' },
      settings: { keepTranscript: false },
    })
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBe('1')
  })

  it('passes the session id down so the server can name it in the hook flag', () => {
    expect(planFor([]).env.CLAUDE_VOICE_SESSION_ID).toBe('fixed-session-id')
  })

  it('turns the voice flags into the overrides the config loader reads', () => {
    const { env } = planFor([
      '--locale',
      'xx',
      '--input',
      'Headset',
      '--output',
      'Speakers',
      '--set',
      'silenceFallbackMs=2000',
    ])
    expect(JSON.parse(env.CLAUDE_VOICE_OVERRIDES)).toEqual({
      locale: 'xx',
      sessionInput: 'Headset',
      sessionOutput: 'Speakers',
      silenceFallbackMs: 2000,
    })
  })

  it('sets no overrides when no voice flag was given', () => {
    expect(planFor(['--continue']).env.CLAUDE_VOICE_OVERRIDES).toBe(undefined)
  })

  it('names the profile for the config loader, which then applies it', () => {
    const { env, args, refusal } = planFor(['--profile', 'desk'], {
      profiles: { desk: { settings: { model: 'fable' } } },
    })
    expect(refusal).toBe(undefined)
    expect(env.CLAUDE_VOICE_PROFILE).toBe('desk')
    expect(flagValue(args, '--model')).toBe('fable')
  })
})

describe('a flag the launcher cannot use', () => {
  it('refuses a voice flag with nothing after it, naming the flag', () => {
    expect(planFor(['--model']).refusal).toBe('--model needs a value')
  })

  it('refuses --set without KEY=VALUE', () => {
    expect(planFor(['--set', 'silenceFallbackMs']).refusal).toBe('--set needs KEY=VALUE')
  })

  it('passes a config refusal on with the key it names', () => {
    expect(planFor(['--set', 'rate=500']).refusal).toContain('"rate" 500')
  })
})

describe('--set', () => {
  it('reads a value that parses as JSON as JSON, and anything else as a string', () => {
    const { env } = planFor([
      '--set',
      'silenceFallbackMs=2000',
      '--set',
      'bargeIn=false',
      '--set',
      'fallbackInput=Wireless Headset',
    ])
    expect(JSON.parse(env.CLAUDE_VOICE_OVERRIDES)).toEqual({
      silenceFallbackMs: 2000,
      bargeIn: false,
      fallbackInput: 'Wireless Headset',
    })
  })
})

describe('the --flag=value form', () => {
  it('reads a voice flag written with an equals sign', () => {
    const { args, env } = planFor(['--model=fable', '--set=rate=200'])
    expect(flagValue(args, '--model')).toBe('fable')
    expect(JSON.parse(env.CLAUDE_VOICE_OVERRIDES)).toEqual({ model: 'fable', rate: 200 })
  })

  it('leaves a claude flag written with an equals sign alone', () => {
    expect(planFor(['--permission-mode=plan']).args.slice(-1)).toEqual(['--permission-mode=plan'])
  })
})

describe('the launch cue', () => {
  it('carries the first-launch sentence from the session locale and speaks it', () => {
    expect(planFor([]).cue).toEqual({ text: 'Press Enter to start the session.', speak: true })
    expect(planFor(['--locale', 'xx']).cue).toEqual({ text: 'Xx press enter.', speak: true })
  })

  it('keeps the text but does not speak it when speakLaunchCue is false', () => {
    expect(planFor([], { settings: { speakLaunchCue: false } }).cue).toEqual({
      text: 'Press Enter to start the session.',
      speak: false,
    })
  })

  it('does not speak when stdin is not a terminal or when CLAUDE_VOICE_SILENT is set', () => {
    expect(planFor([], { isTTY: false }).cue.speak).toBe(false)
    expect(planFor([], { env: { CLAUDE_VOICE_SILENT: '1' } }).cue.speak).toBe(false)
  })

  it('does not speak an empty sentence', () => {
    const { cue } = planFor([], { phrases: { overrides: { en: { strings: { launchCue: '' } } } } })
    expect(cue).toEqual({ text: '', speak: false })
  })

  it('speaks the model-switch sentence on a relaunch even when the first-launch cue is off', () => {
    const { config } = planFor([], { settings: { speakLaunchCue: false } })
    expect(buildCue({ config, env: {}, isTTY: true, relaunch: true })).toEqual({
      text: 'The model switch is waiting. Press Enter to continue.',
      speak: true,
    })
    expect(buildCue({ config, env: { CLAUDE_VOICE_SILENT: '1' }, isTTY: true, relaunch: true }).speak).toBe(false)
    expect(buildCue({ config, env: {}, isTTY: false, relaunch: true }).speak).toBe(false)
  })

  it('says the cue at the session rate, in the session voice when one is named', () => {
    expect(buildSayArgs({ rate: 190, voice: '' }, 'Press Enter.')).toEqual(['-r', '190', '--', 'Press Enter.'])
    expect(buildSayArgs({ rate: 230, voice: 'Mónica' }, 'Pulsa Intro.')).toEqual([
      '-r',
      '230',
      '-v',
      'Mónica',
      '--',
      'Pulsa Intro.',
    ])
  })
})

describe('the other actions', () => {
  it('reports help without touching the config', () => {
    expect(planFor(['--help']).action).toBe('help')
    expect(planFor(['-h']).action).toBe('help')
  })

  it('hands the arguments after --check and --remove to those scripts', () => {
    expect(planFor(['--check'])).toMatchObject({ action: 'check', rest: [] })
    expect(planFor(['--remove', '--dry-run', '--yes'])).toMatchObject({
      action: 'remove',
      rest: ['--dry-run', '--yes'],
    })
  })
})
