import { readFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import {
  deviceAllowed,
  deviceVerdict,
  isClaudeCommand,
  loadConfig,
  parseJsonc,
  parseServerProcesses,
  setAllowedDevices,
} from '../src/config.mjs'
import { cleanupRoots, makeRoot, runRefusable } from './fixture-root.mjs'

afterAll(cleanupRoots)

function loadFrom({ env = {}, ...rootSpec } = {}) {
  const root = makeRoot(rootSpec)
  const { value, refusal } = runRefusable((fail) => loadConfig({ root, env, fail }))
  return { config: value, refusal, root }
}

function refusalFor(spec) {
  const { config, refusal } = loadFrom(spec)
  expect(config, 'expected a refusal, got a config').toBe(undefined)
  return refusal
}

function overridesEnv(object) {
  return { CLAUDE_VOICE_OVERRIDES: JSON.stringify(object) }
}

const EN = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'))
// A second language the repository does not ship, derived from en so the loader's shape checks pass.
const XX = {
  ...EN,
  hearLocale: 'xx-XX',
  commands: { ...EN.commands, send: { ...EN.commands.send, say: ['xx send'] } },
  strings: { ...EN.strings, paused: 'Xx paused' },
  numbers: { ...EN.numbers, 2: [...EN.numbers['2'], 'dos'] },
}

describe('layering', () => {
  // The expected values are literals, because reading them from DEFAULTS would test the module against itself.
  it('falls back to the documented defaults for anything the files leave out', () => {
    const { config, refusal } = loadFrom()
    expect(refusal).toBe(undefined)
    expect(config.silenceFallbackMs).toBe(6000)
    expect(config.model).toBe('')
    expect(config.effort).toBe('')
    expect(config.rate).toBe(190)
    expect(config.deviceCheckIntervalMs).toBe(2000)
    expect(config.allowedInputs).toEqual([])
    expect(config.allowedOutputs).toBe('same')
    expect(config.advanced.replayHistory).toBe(10)
    expect(config.advanced.bargeInMaxEcho).toBe(0.6)
    expect(config.log.file).toBe('~/Library/Logs/claude-code-handsfree.log')
  })

  it('lets the settings file beat the defaults', () => {
    const { config } = loadFrom({ settings: { silenceFallbackMs: 1000, model: 'fable' } })
    expect(config.silenceFallbackMs).toBe(1000)
    expect(config.model).toBe('fable')
  })

  it('merges advanced and log key by key instead of replacing the block', () => {
    const { config } = loadFrom({ settings: { advanced: { replayHistory: 3 }, log: { includeSentText: false } } })
    expect(config.advanced.replayHistory).toBe(3)
    expect(config.advanced.bargeInMinWords).toBe(2)
    expect(config.log.includeSentText).toBe(false)
    expect(config.log.file).toBe('~/Library/Logs/claude-code-handsfree.log')
  })

  it('lets a profile beat the settings and phrases files', () => {
    const { config } = loadFrom({
      settings: { profile: 'desk', model: 'opus', rate: 190 },
      phrases: { commandPrefix: '' },
      profiles: { desk: { settings: { model: 'fable' }, phrases: { commandPrefix: 'hey voice' } } },
    })
    expect(config.model).toBe('fable')
    expect(config.rate).toBe(190)
    expect(config.commandPrefix).toBe('hey voice')
  })

  it('lets the launch flags beat the profile', () => {
    const { config } = loadFrom({
      settings: { profile: 'desk', model: 'opus' },
      profiles: { desk: { settings: { model: 'fable', rate: 150 } } },
      env: overridesEnv({ model: 'haiku' }),
    })
    expect(config.model).toBe('haiku')
    expect(config.rate).toBe(150)
  })

  it('reports which files and flags applied', () => {
    const { config, root } = loadFrom({
      settings: { profile: 'desk' },
      profiles: { desk: { settings: { model: 'fable' } } },
      env: overridesEnv({ rate: 200 }),
    })
    expect(config.sources.settings).toBe(`${root}/settings.jsonc`)
    expect(config.sources.settingsExample).toBe(false)
    expect(config.sources.profile).toBe(`${root}/profiles/desk`)
    expect(config.sources.overrides).toEqual(['rate'])
  })
})

describe('the locale and its overrides', () => {
  it('reads the commands, numbers, and strings of the locale the phrases file names', () => {
    const { config } = loadFrom({ phrases: { locale: 'xx' }, localeFiles: { xx: XX } })
    expect(config.locale).toBe('xx')
    expect(config.commands.send.say).toEqual(['xx send'])
    expect(config.strings.paused).toBe('Xx paused')
    expect(config.numbers.dos).toBe(2)
    expect(config.hearLocale).toBe('xx-XX')
  })

  it('replaces one command entry and leaves the rest of the table alone', () => {
    const { config } = loadFrom({
      phrases: { overrides: { en: { commands: { send: { say: ['ship it'], call: 'send' } } } } },
    })
    expect(config.commands.send.say).toEqual(['ship it'])
    expect(config.commands.stop.say).toEqual(['stop session', 'stop listening', 'end session'])
  })

  it('adds an entry under a key the locale file does not have, after the shipped ones', () => {
    const { config } = loadFrom({
      phrases: { overrides: { en: { commands: { quiet: { say: ['go quiet'], call: 'pause' } } } } },
    })
    expect(config.commands.quiet).toEqual({ say: ['go quiet'], call: 'pause', args: {} })
    expect(Object.keys(config.commands).at(-1)).toBe('quiet')
    expect(config.commands.pause.say).toEqual(['pause session'])
  })

  it('fills the arguments an entry leaves out with the placeholders of its call', () => {
    const { config } = loadFrom({
      phrases: { overrides: { en: { commands: { again: { say: ['say that again'], call: 'replay' } } } } },
    })
    expect(config.commands.again.args).toEqual({ n: '<number>' })
    expect(config.commands.model.args).toEqual({ model: '<model>', effort: '<effort>' })
  })

  it('keeps the arguments an entry fixes', () => {
    const { config } = loadFrom({
      phrases: {
        overrides: {
          en: {
            commands: {
              'use fable': { say: ['use fable'], call: 'switchModel', args: { model: 'fable', effort: 'low' } },
            },
          },
        },
      },
    })
    expect(config.commands['use fable'].args).toEqual({ model: 'fable', effort: 'low' })
  })

  it('replaces one answer list and leaves the other alone', () => {
    const { config } = loadFrom({ phrases: { overrides: { en: { answers: { yes: ['go on'] } } } } })
    expect(config.answers.yes).toEqual(['go on'])
    expect(config.answers.no).toEqual(['no', 'nope', 'deny', 'reject'])
  })

  it('merges strings key by key', () => {
    const { config } = loadFrom({ phrases: { overrides: { en: { strings: { acknowledgement: 'Heard' } } } } })
    expect(config.strings.acknowledgement).toBe('Heard')
    expect(config.acknowledgementPhrase).toBe('Heard')
    expect(config.strings.paused).toBe('Paused')
  })

  it("keeps another locale's overrides out of this session", () => {
    const { config } = loadFrom({
      phrases: { locale: 'en', overrides: { xx: { commands: { send: { say: ['xx send now'], call: 'send' } } } } },
      localeFiles: { xx: XX },
    })
    expect(config.commands.send.say).toEqual(['send message'])
  })

  it('lets a profile override beat the phrases file for the same locale', () => {
    const { config } = loadFrom({
      settings: { profile: 'desk' },
      phrases: { overrides: { en: { strings: { acknowledgement: 'Heard' } } } },
      profiles: { desk: { phrases: { overrides: { en: { strings: { acknowledgement: 'Noted' } } } } } },
    })
    expect(config.strings.acknowledgement).toBe('Noted')
  })

  it('lets --voice and --set hearLocale beat every file', () => {
    const { config } = loadFrom({
      phrases: { overrides: { en: { voice: 'Alex', hearLocale: 'en-GB' } } },
      env: overridesEnv({ voice: 'Ava', hearLocale: 'en-AU' }),
    })
    expect(config.voice).toBe('Ava')
    expect(config.hearLocale).toBe('en-AU')
  })
})

describe('the command prefix', () => {
  it('puts the prefix in front of every phrase in the table but leaves the answers alone', () => {
    const { config } = loadFrom({ phrases: { commandPrefix: 'hey voice' } })
    expect(config.commands.send.say).toEqual(['hey voice send message'])
    expect(config.commands.help.say).toEqual(['hey voice voice help'])
    expect(config.answers.yes).toEqual(['yes', 'yeah', 'yep', 'approve', 'allow'])
    expect(config.answers.no).toEqual(['no', 'nope', 'deny', 'reject'])
  })

  it('puts the prefix in front of an entry the user added too', () => {
    const { config } = loadFrom({
      phrases: {
        commandPrefix: 'hey voice',
        overrides: { en: { commands: { quiet: { say: ['go quiet'], call: 'pause' } } } },
      },
    })
    expect(config.commands.quiet.say).toEqual(['hey voice go quiet'])
  })

  it('leaves the phrases alone when no prefix is set', () => {
    const { config } = loadFrom()
    expect(config.commands.send.say).toEqual(['send message'])
  })
})

describe('a refusal names the offending key', () => {
  const cases = [
    ['a value of the wrong type', { settings: { silenceFallbackMs: 'soon' } }, '"silenceFallbackMs" must be a number'],
    ['a speech rate outside 90 to 400', { settings: { rate: 500 } }, '"rate" 500 is outside 90 to 400'],
    [
      'a device list that is not a list',
      { settings: { allowedInputs: 'USB Microphone' } },
      '"allowedInputs" must be an array of device name fragments',
    ],
    [
      'a device list holding something that is not a name',
      { settings: { allowedInputs: ['  '] } },
      '"allowedInputs" must be an array of device name fragments',
    ],
    [
      'an output list that is neither "same" nor names',
      { settings: { allowedOutputs: 5 } },
      '"allowedOutputs" must be a non-empty array of device name fragments or "same"',
    ],
    [
      'a negative advanced timing',
      { settings: { advanced: { replaySettleMs: -1 } } },
      '"advanced.replaySettleMs" must be a number of at least 0',
    ],
    [
      'an advanced key that does not exist',
      { settings: { advanced: { replayHistry: 5 } } },
      '"advanced.replayHistry" is not a known setting',
    ],
    [
      'a log value of the wrong type',
      { settings: { log: { includeSentText: 'yes' } } },
      '"log.includeSentText" must be true or false',
    ],
    ['a log key that does not exist', { settings: { log: { rotate: 1 } } }, '"log.rotate" is not a known setting'],
    [
      'a locale that is not a language code',
      { phrases: { locale: 'english' } },
      '"locale" must look like "en" or "en-GB"',
    ],
    ['a locale with no file', { phrases: { locale: 'fr' } }, 'locales/fr.json: cannot read or parse'],
    [
      'a spoken string that is not text',
      { phrases: { overrides: { en: { strings: { acknowledgement: 5 } } } } },
      'strings.acknowledgement must be a string',
    ],
    [
      'the old name of a string that was renamed',
      { phrases: { overrides: { en: { strings: { ack: 'Got it' } } } } },
      '"strings.ack" is now "strings.acknowledgement"',
    ],
    ['a voice name that is not text', { phrases: { overrides: { en: { voice: 5 } } } }, '"voice" must be a string'],
    [
      'a spoken string the server never says',
      { phrases: { overrides: { en: { strings: { acck: 'Got it' } } } } },
      '"strings.acck" is not a known spoken string',
    ],
    [
      'a command entry that is not an object',
      { phrases: { overrides: { en: { commands: { pause: ['pause session'] } } } } },
      '"commands.pause" must be an object with "say" and "call"',
    ],
    [
      'a command entry with no phrases',
      { phrases: { overrides: { en: { commands: { pause: { call: 'pause' } } } } } },
      '"commands.pause.say" must be a non-empty array of spoken phrases',
    ],
    [
      'a command entry whose phrase list is empty',
      { phrases: { overrides: { en: { commands: { send: { say: [], call: 'send' } } } } } },
      '"commands.send.say" must be a non-empty array of spoken phrases',
    ],
    [
      'a call the server does not have',
      { phrases: { overrides: { en: { commands: { quiet: { say: ['go quiet'], call: 'hush' } } } } } },
      '"commands.quiet.call" must be one of send, interrupt, stop, pause, resume, clipboard, replay, switchModel, help',
    ],
    [
      'an argument the call does not take',
      { phrases: { overrides: { en: { commands: { quiet: { say: ['go quiet'], call: 'pause', args: { n: 2 } } } } } } },
      '"commands.quiet.args.n" is not an argument of pause (takes no arguments)',
    ],
    [
      'an argument of the wrong type',
      {
        phrases: {
          overrides: { en: { commands: { again: { say: ['again'], call: 'replay', args: { n: 'two' } } } } },
        },
      },
      '"commands.again.args.n" must be a number or "<number>"',
    ],
    [
      'a model argument that is not text',
      {
        phrases: {
          overrides: {
            en: { commands: { quick: { say: ['go quick'], call: 'switchModel', args: { model: 5 } } } },
          },
        },
      },
      '"commands.quick.args.model" must be a string or "<model>"',
    ],
    [
      'an args block that is not an object',
      { phrases: { overrides: { en: { commands: { daily: { say: ['daily'], call: 'send', args: 'hello' } } } } } },
      '"commands.daily.args" must be an object',
    ],
    [
      'a key a command entry has no use for',
      { phrases: { overrides: { en: { commands: { daily: { say: ['daily'], call: 'send', when: 'now' } } } } } },
      '"commands.daily.when" is not a known key (known: say, call, args)',
    ],
    [
      'an empty answer list',
      { phrases: { overrides: { en: { answers: { yes: [] } } } } },
      '"answers.yes" must be a non-empty array of strings',
    ],
    [
      'an answer that is neither yes nor no',
      { phrases: { overrides: { en: { answers: { maybe: ['perhaps'] } } } } },
      '"answers.maybe" is not a known answer (known: yes, no)',
    ],
    [
      'the old word to number shape for numbers',
      { phrases: { overrides: { en: { numbers: { couple: 2 } } } } },
      '"numbers.couple" is a word key; numbers is keyed by the reply, as "numbers": { "1": ["couple"] }',
    ],
    [
      'a number key that is not a count',
      { phrases: { overrides: { en: { numbers: { 0: ['none'] } } } } },
      '"numbers.0" must be a positive whole number',
    ],
    [
      'a number with no words',
      { phrases: { overrides: { en: { numbers: { 2: [] } } } } },
      '"numbers.2" must be a non-empty array of words',
    ],
    [
      'a language key that does not exist',
      { phrases: { overrides: { en: { vice: 'Alex' } } } },
      '"overrides.en.vice" is not a language key',
    ],
    [
      'a command table replaced by something that is not an object',
      { phrases: { overrides: { en: { commands: 'send message' } } } },
      '"commands" must be an object',
    ],
    [
      'an overrides block that is not keyed by locale',
      { phrases: { overrides: 'en' } },
      '"overrides" must be an object keyed by locale',
    ],
    [
      'an overrides entry that is not an object',
      { phrases: { overrides: { en: 'voice' } } },
      '"overrides.en" must be an object',
    ],
    ['a profile with no folder', { settings: { profile: 'desk' } }, 'profile "desk" not found at'],
    [
      'a profile name with a slash in it',
      { settings: { profile: '../elsewhere' } },
      'profile name "../elsewhere" may only contain letters, digits, _ and -',
    ],
    [
      'a profile folder with neither file in it',
      { settings: { profile: 'desk' }, profiles: { desk: {} } },
      'profile "desk" has no settings.jsonc or phrases.jsonc',
    ],
    [
      'overrides that are not JSON',
      { env: { CLAUDE_VOICE_OVERRIDES: '{nope' } },
      'CLAUDE_VOICE_OVERRIDES is not valid JSON',
    ],
    [
      'overrides that are JSON but not an object',
      { env: { CLAUDE_VOICE_OVERRIDES: '["model"]' } },
      'CLAUDE_VOICE_OVERRIDES must be a JSON object',
    ],
    ['a settings file that is not valid JSONC', { settings: '{ "rate": }' }, 'settings.jsonc'],
    ['a settings file whose top level is not an object', { settings: '[190]' }, 'top level must be an object'],
  ]
  it.each(cases)('refuses %s', (_name, spec, expected) => {
    expect(refusalFor(spec)).toContain(expected)
  })
})

describe('a key in the wrong file', () => {
  it('sends a phrases-file key in settings to the phrases file', () => {
    expect(refusalFor({ settings: { locale: 'es' } })).toContain('"locale" belongs in the phrases file, not settings')
  })

  it('sends a language key in settings to overrides in the phrases file', () => {
    const message = refusalFor({ settings: { voice: 'Alex' } })
    expect(message).toContain('"voice" is language material')
    expect(message).toContain('phrases file')
  })

  it('sends a settings key in the phrases file to settings', () => {
    expect(refusalFor({ phrases: { rate: 200 } })).toContain('"rate" belongs in settings, not the phrases file')
  })

  it('sends a top-level language key in the phrases file under its locale', () => {
    expect(refusalFor({ phrases: { voice: 'Alex' } })).toContain('overrides.en.voice')
  })

  it('names the file the key was found in, not just the key', () => {
    const { refusal, root } = loadFrom({ settings: { locale: 'es' } })
    expect(refusal).toContain(`${root}/settings.jsonc`)
  })
})

describe('a fresh install with no device chosen', () => {
  it('loads with an empty allowedInputs', () => {
    const { config, refusal } = loadFrom({ settings: { allowedInputs: [] } })
    expect(refusal).toBe(undefined)
    expect(config.allowedInputs).toEqual([])
  })

  it('ships an empty allowedInputs in settings.example.jsonc', () => {
    const example = parseJsonc(readFileSync(new URL('../settings.example.jsonc', import.meta.url), 'utf8'))
    expect(example.allowedInputs).toEqual([])
  })
})

describe('setAllowedDevices', () => {
  const example = () => readFileSync(new URL('../settings.example.jsonc', import.meta.url), 'utf8')

  it('writes the chosen microphone into the shipped example file', () => {
    const { text, changed } = setAllowedDevices(example(), { inputs: ['Wireless Headset'], outputs: null })
    expect(changed).toBe(true)
    const config = parseJsonc(text)
    expect(config.allowedInputs).toEqual(['Wireless Headset'])
    expect(config.allowedOutputs).toBe('same')
  })

  it('writes a separate output list for a microphone that cannot play audio', () => {
    const { text } = setAllowedDevices(example(), { inputs: ['USB Microphone'], outputs: ['External Speakers'] })
    const config = parseJsonc(text)
    expect(config.allowedInputs).toEqual(['USB Microphone'])
    expect(config.allowedOutputs).toEqual(['External Speakers'])
  })

  it('changes the settings and not the comments that show example values', () => {
    const { text } = setAllowedDevices(example(), { inputs: ['Wireless Headset'], outputs: null })
    const comments = text.split('\n').filter((l) => l.trim().startsWith('//'))
    expect(comments.join('\n')).not.toContain('Wireless Headset')
    expect(comments.length).toBe(
      example()
        .split('\n')
        .filter((l) => l.trim().startsWith('//')).length,
    )
  })

  it('writes a hand-edited file that keeps the whole object on one line', () => {
    const { text, changed } = setAllowedDevices('{ "rate": 190, "allowedInputs": [], "allowedOutputs": "same" }\n', {
      inputs: ['Wireless Headset'],
      outputs: null,
    })
    expect(changed).toBe(true)
    expect(parseJsonc(text).allowedInputs).toEqual(['Wireless Headset'])
  })

  it('reports that it wrote nothing when the file has no allowedInputs to replace', () => {
    const original = '{\n  "rate": 190,\n}\n'
    const { text, changed } = setAllowedDevices(original, { inputs: ['Wireless Headset'], outputs: null })
    expect(changed).toBe(false)
    expect(text).toBe(original)
  })
})

describe('deviceVerdict', () => {
  const headset = { input: 'Wireless Headset', output: 'Wireless Headset' }

  it('allows a matching input when the output is the same device', () => {
    expect(deviceVerdict({ allowedInputs: ['headset'], allowedOutputs: 'same' }, headset)).toEqual({ allowed: true })
  })

  it('matches a name fragment whatever its case', () => {
    expect(deviceVerdict({ allowedInputs: ['WIRELESS'], allowedOutputs: 'same' }, headset).allowed).toBe(true)
  })

  it('refuses an input that is on no list and names it', () => {
    const v = deviceVerdict(
      { allowedInputs: ['Wireless Headset'], allowedOutputs: 'same' },
      { input: 'Built-in Microphone', output: 'Built-in Microphone' },
    )
    expect(v).toEqual({ allowed: false, reason: 'device', side: 'input', which: 'Built-in Microphone' })
  })

  it('refuses an output that is not the input when allowedOutputs is "same"', () => {
    const v = deviceVerdict(
      { allowedInputs: ['headset'], allowedOutputs: 'same' },
      { input: 'Wireless Headset', output: 'External Speakers' },
    )
    expect(v).toEqual({ allowed: false, reason: 'device', side: 'output', which: 'External Speakers' })
  })

  it('allows a listed output that is not the input device', () => {
    const v = deviceVerdict(
      { allowedInputs: ['USB Microphone'], allowedOutputs: ['External Speakers'] },
      { input: 'USB Microphone', output: 'External Speakers' },
    )
    expect(v).toEqual({ allowed: true })
  })

  it('blames the output when both devices share a name and only the output list rejects it', () => {
    const v = deviceVerdict(
      { allowedInputs: ['USB Microphone'], allowedOutputs: ['External Speakers'] },
      { input: 'USB Microphone', output: 'USB Microphone' },
    )
    expect(v).toEqual({ allowed: false, reason: 'device', side: 'output', which: 'USB Microphone' })
  })

  it('names "none" when a device is missing altogether', () => {
    expect(deviceVerdict({ allowedInputs: ['headset'], allowedOutputs: 'same' }, { input: '', output: '' }).which).toBe(
      'none',
    )
  })

  it('refuses every device when allowedInputs is empty, without blaming a device', () => {
    const v = deviceVerdict({ allowedInputs: [], allowedOutputs: 'same' }, headset)
    expect(v).toEqual({ allowed: false, reason: 'unconfigured' })
  })
})

describe('deviceAllowed', () => {
  const lists = { allowedInputs: ['Wireless Headset'], allowedOutputs: ['External Speakers'] }

  it('judges a device on the side its direction allows', () => {
    expect(deviceAllowed(lists, { name: 'Wireless Headset', dir: 'in' })).toEqual({ asInput: true, asOutput: false })
    expect(deviceAllowed(lists, { name: 'External Speakers', dir: 'out' })).toEqual({ asInput: false, asOutput: true })
  })

  it('judges both sides of a device that does both', () => {
    expect(deviceAllowed(lists, { name: 'Wireless Headset', dir: 'both' })).toEqual({ asInput: true, asOutput: false })
  })

  it('judges an output against the input list when allowedOutputs is "same"', () => {
    const same = { allowedInputs: ['Wireless Headset'], allowedOutputs: 'same' }
    expect(deviceAllowed(same, { name: 'Wireless Headset', dir: 'both' })).toEqual({ asInput: true, asOutput: true })
    expect(deviceAllowed(same, { name: 'External Speakers', dir: 'out' })).toEqual({ asInput: false, asOutput: false })
  })

  it('allows nothing while allowedInputs is empty', () => {
    const empty = { allowedInputs: [], allowedOutputs: 'same' }
    expect(deviceAllowed(empty, { name: 'Wireless Headset', dir: 'both' })).toEqual({ asInput: false, asOutput: false })
  })
})

describe('finding the voice servers ps reports', () => {
  const SERVER = '  4102  4090 node /repo/src/voice-channel.mjs'
  // The line claude itself runs under, which names the server's path inside its --mcp-config argument.
  const CLAUDE = `  4090  4080 claude --mcp-config {"mcpServers":{"voice":{"command":"node","args":["/repo/src/voice-channel.mjs"]}}} --model opus`
  const LAUNCHER = '  4080  4070 node /repo/src/launch.mjs --model opus'

  it('takes the server and leaves the claude and launcher processes that name its path', () => {
    expect(parseServerProcesses([LAUNCHER, CLAUDE, SERVER].join('\n'), 999)).toEqual([
      { pid: 4102, ppid: 4090, command: 'node /repo/src/voice-channel.mjs' },
    ])
  })

  it('leaves out the process doing the asking', () => {
    expect(parseServerProcesses(SERVER, 4102)).toEqual([])
  })

  it('reads a parent command as claude only when the command it runs is claude', () => {
    expect(isClaudeCommand('claude --model opus')).toBe(true)
    expect(isClaudeCommand('/usr/local/bin/claude --model opus')).toBe(true)
    expect(isClaudeCommand('node /repo/claude-voice-channel/node_modules/vitest/vitest.mjs')).toBe(false)
    expect(isClaudeCommand('')).toBe(false)
  })
})
