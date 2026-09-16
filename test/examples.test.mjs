import { readFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import {
  ANSWER_GROUPS,
  COMMAND_CALLS,
  DEFAULTS,
  LANGUAGE_DEFAULTS,
  LANGUAGE_KEYS,
  LOCALE_STRINGS,
  parseJsonc,
} from '../src/config.mjs'
import { cleanupRoots, loadConfigFromRoot } from './fixture-root.mjs'

afterAll(cleanupRoots)

const FILES = {
  settings: 'settings.example.jsonc',
  phrases: 'phrases.example.jsonc',
  profileSettings: 'profiles/example/settings.jsonc',
  profilePhrases: 'profiles/example/phrases.jsonc',
}
const LOCALES = ['en']

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
const shipped = (locale) => JSON.parse(read(`locales/${locale}.json`))

// Every settings key by its own name, which is unique across the file's three levels.
const SETTINGS_DEFAULTS = new Map()
for (const [key, value] of Object.entries(DEFAULTS)) {
  if (value && typeof value === 'object' && !Array.isArray(value))
    for (const [inner, innerValue] of Object.entries(value)) SETTINGS_DEFAULTS.set(inner, innerValue)
  else SETTINGS_DEFAULTS.set(key, value)
}

// The value a phrases block names as its default: the loader's, the language file's, or an empty locale block.
function phrasesDefault(key, locale) {
  if (key === 'voice' || key === 'hearLocale') return shipped(locale)[key]
  if (LOCALES.includes(key)) return {}
  return LANGUAGE_DEFAULTS[key]
}

// The "// default: X   allowed: ..." line above an option, as the value X, or undefined when it names its keys in prose.
function defaultValue(line) {
  const text = /^\/\/ default: (.*?)\s{2,}allowed: /.exec(line.trim())?.[1]
  try {
    return { value: JSON.parse(text) }
  } catch {
    return undefined
  }
}

// The key an option line sets, live or commented.
const optionKey = (line) => /^(?:\/\/ )?"([^"]+)"\s*:/.exec(line.trim())?.[1]

// An option line carries a JSON key or an opening bracket, so only those lose their // .
// A description line starts with a label word, never with a quote or a bracket.
const OPTION_LINE = /^(\s*)\/\/ (["{[].*)$/

function uncomment(text) {
  return text
    .split('\n')
    .map((line) => line.replace(OPTION_LINE, '$1$2'))
    .join('\n')
}

function keyPaths(object, prefix = '') {
  const paths = []
  for (const [key, value] of Object.entries(object)) {
    const path = prefix ? `${prefix}.${key}` : key
    paths.push(path)
    if (value && typeof value === 'object' && !Array.isArray(value)) paths.push(...keyPaths(value, path))
  }
  return paths.sort()
}

const parsed = (name) => parseJsonc(uncomment(read(FILES[name])), FILES[name])

describe('the example files as shipped', () => {
  it('parses each one with every option still commented out', () => {
    expect(parseJsonc(read(FILES.settings), FILES.settings)).toEqual({
      allowedInputs: [],
      allowedOutputs: 'same',
      log: {},
      advanced: {},
    })
    expect(parseJsonc(read(FILES.phrases), FILES.phrases)).toEqual({
      locale: 'en',
      commandPrefix: '',
      overrides: {
        en: { voice: '', commands: {}, answers: {}, numbers: {}, strings: {} },
      },
    })
  })

  it('loads a root that has nothing but the two example files', () => {
    const { config: value, refusal } = loadConfigFromRoot({
      settings: read(FILES.settings),
      phrases: read(FILES.phrases),
    })
    expect(refusal).toBe(undefined)
    expect(value.rate).toBe(DEFAULTS.rate)
  })
})

describe('the example files with every option uncommented', () => {
  it('uncomments the option lines and leaves the descriptions alone', () => {
    const text = uncomment(read(FILES.settings))
    expect(text).toContain('\n  "rate": 190,')
    expect(text).toContain('// description: speech rate for say')
    expect(text).toContain('// setting:')
  })

  it('accepts the settings file alone', () => {
    const { config: value, refusal } = loadConfigFromRoot({
      settings: uncomment(read(FILES.settings)),
      phrases: read(FILES.phrases),
    })
    expect(refusal).toBe(undefined)
    expect(value.log.file).toBe(DEFAULTS.log.file)
    expect(value.advanced).toEqual(DEFAULTS.advanced)
  })

  it('accepts the phrases file alone', () => {
    const { config: value, refusal } = loadConfigFromRoot({
      settings: read(FILES.settings),
      phrases: uncomment(read(FILES.phrases)),
    })
    expect(refusal).toBe(undefined)
    expect(value.strings).toEqual(shipped('en').strings)
    expect(value.commands.send.say).toEqual(['send message'])
  })

  it('accepts both files with the example profile on top', () => {
    const { config: value, refusal } = loadConfigFromRoot({
      settings: uncomment(read(FILES.settings)),
      phrases: uncomment(read(FILES.phrases)),
      profiles: {
        example: {
          settings: uncomment(read(FILES.profileSettings)),
          phrases: uncomment(read(FILES.profilePhrases)),
        },
      },
      env: { CLAUDE_VOICE_PROFILE: 'example' },
    })
    expect(refusal).toBe(undefined)
    expect(value.allowedInputs).toEqual(['USB Microphone'])
    expect(value.model).toBe('fable')
    expect(value.silenceFallbackMs).toBe(0)
    expect(value.commands.send.say).toEqual(['hey voice send it', 'hey voice send message'])
  })
})

describe('the layout of every option block', () => {
  for (const [name, file] of Object.entries(FILES)) {
    it(`gives each option in ${file} a description, a default and allowed line, and a setting label`, () => {
      const lines = read(FILES[name]).split('\n')
      let blocks = 0
      lines.forEach((line, i) => {
        const trimmed = line.trim()
        const isOption = trimmed.startsWith('"') || trimmed.startsWith('// "')
        if (trimmed === '// setting:') {
          const next = lines[i + 1].trim()
          expect(next.startsWith('"') || next.startsWith('// "'), `${file}:${i + 2} is not an option line`).toBe(true)
        }
        if (!isOption) return
        blocks++
        const at = `${file}:${i + 1}`
        expect(lines[i - 1].trim(), `${at} is not under a setting: label`).toBe('// setting:')
        expect(lines[i - 2].trim(), `${at} has no default and allowed line`).toMatch(/^\/\/ default: .*\ballowed: /)
        expect(lines[i - 3].trim(), `${at} has no description line`).toMatch(/^\/\/ description: \S/)
      })
      expect(blocks).toBeGreaterThan(20)
    })

    it(`uses no comment style in ${file} beyond the header and those four labels`, () => {
      const lines = read(FILES[name]).split('\n')
      const body = lines.slice(lines.findIndex((l) => l.startsWith('{')))
      for (const line of body) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('//')) continue
        expect(trimmed, `${file}: unlabelled comment`).toMatch(/^\/\/ (description: |default: |setting:$|["{[])/)
      }
    })
  }
})

describe('the default each block names', () => {
  for (const name of ['settings', 'profileSettings']) {
    it(`matches DEFAULTS in ${FILES[name]}`, () => {
      const lines = read(FILES[name]).split('\n')
      let checked = 0
      lines.forEach((line, i) => {
        const key = optionKey(line)
        if (!key || lines[i - 1]?.trim() !== '// setting:') return
        const named = defaultValue(lines[i - 2])
        if (!named) return
        const at = `${FILES[name]}:${i - 1}`
        expect(SETTINGS_DEFAULTS.has(key), `${at} names ${key}, which is not a setting`).toBe(true)
        expect(named.value, `${at} is the default of ${key}`).toEqual(SETTINGS_DEFAULTS.get(key))
        checked++
      })
      expect(checked, 'one default line per setting').toBe(SETTINGS_DEFAULTS.size)
    })
  }

  for (const name of ['phrases', 'profilePhrases']) {
    it(`matches the loader and the language files in ${FILES[name]}`, () => {
      const lines = read(FILES[name]).split('\n')
      let locale = ''
      let checked = 0
      lines.forEach((line, i) => {
        const key = optionKey(line)
        if (!key) return
        if (LOCALES.includes(key)) locale = key
        if (lines[i - 1]?.trim() !== '// setting:') return
        const named = defaultValue(lines[i - 2])
        if (!named) return
        const at = `${FILES[name]}:${i - 1}`
        expect(named.value, `${at} is the default of ${key}`).toEqual(phrasesDefault(key, locale))
        checked++
      })
      // locale, commandPrefix, overrides, and the voice and recognizer locale of each locale block.
      expect(checked, 'one default line per option outside the four language maps').toBe(3 + LOCALES.length * 3)
    })
  }
})

describe('coverage of settings.example.jsonc', () => {
  it('holds every key in DEFAULTS, including every log and advanced key, and no other', () => {
    expect(keyPaths(parsed('settings'))).toEqual(keyPaths(DEFAULTS))
  })

  it('holds the same keys in the profile example', () => {
    expect(keyPaths(parsed('profileSettings'))).toEqual(keyPaths(DEFAULTS))
  })

  it('leaves only the keys a fresh install edits live, and the profile only what it changes', () => {
    expect(parseJsonc(read(FILES.settings))).toEqual({
      allowedInputs: [],
      allowedOutputs: 'same',
      log: {},
      advanced: {},
    })
    expect(parseJsonc(read(FILES.profileSettings))).toEqual({
      allowedInputs: ['USB Microphone'],
      allowedOutputs: ['External Headphones'],
      silenceFallbackMs: 0,
      model: 'fable',
      log: {},
      advanced: {},
    })
  })
})

describe('coverage of phrases.example.jsonc', () => {
  for (const name of ['phrases', 'profilePhrases']) {
    describe(FILES[name], () => {
      const file = () => parsed(name)

      it('holds every key the phrases file takes, and no other', () => {
        expect(Object.keys(file()).sort()).toEqual(Object.keys(LANGUAGE_DEFAULTS).sort())
        expect(Object.keys(file().overrides).sort()).toEqual([...LOCALES].sort())
      })

      for (const locale of LOCALES) {
        describe(`overrides.${locale}`, () => {
          const block = () => file().overrides[locale]

          it('holds every language key, and no other', () => {
            expect(Object.keys(block()).sort()).toEqual([...LANGUAGE_KEYS].sort())
          })

          it('repeats the voice and the recognizer locale the language file ships', () => {
            expect(block().voice).toBe(shipped(locale).voice)
            expect(block().hearLocale).toBe(shipped(locale).hearLocale)
          })

          it('repeats every shipped command entry, and adds only entries the loader knows a call for', () => {
            for (const [key, entry] of Object.entries(shipped(locale).commands)) {
              expect(block().commands, `commands.${key} is missing`).toHaveProperty([key])
              if (name === 'phrases') expect(block().commands[key]).toEqual(entry)
            }
            for (const [key, entry] of Object.entries(block().commands)) {
              expect(Object.keys(COMMAND_CALLS), `commands.${key}.call`).toContain(entry.call)
              expect(entry.say.length, `commands.${key}.say`).toBeGreaterThan(0)
            }
          })

          it('repeats both answer lists as shipped', () => {
            expect(Object.keys(block().answers).sort()).toEqual([...ANSWER_GROUPS].sort())
            expect(block().answers).toEqual(shipped(locale).answers)
          })

          it('repeats every shipped number with the word list shipped for it', () => {
            expect(Object.keys(block().numbers)).toEqual(Object.keys(shipped(locale).numbers))
            expect(block().numbers).toEqual(shipped(locale).numbers)
          })

          it('repeats every spoken string the loader names, with the shipped text', () => {
            expect(Object.keys(block().strings).sort()).toEqual([...LOCALE_STRINGS].sort())
            expect(block().strings).toEqual(shipped(locale).strings)
          })
        })
      }
    })
  }

  it('leaves live only locale, commandPrefix, and the voice setup writes, and the profile only what it changes', () => {
    const main = parseJsonc(read(FILES.phrases))
    expect(main.locale).toBe('en')
    expect(main.commandPrefix).toBe('')
    for (const locale of LOCALES) expect(main.overrides[locale].voice).toBe(shipped(locale).voice)
    const profile = parseJsonc(read(FILES.profilePhrases))
    expect(profile.commandPrefix).toBe('hey voice')
    expect(profile.locale).toBe(undefined)
    for (const locale of LOCALES) expect(profile.overrides[locale].voice).toBe(shipped(locale).voice)
    expect(profile.overrides.en.commands).toEqual({ send: { say: ['send it', 'send message'], call: 'send' } })
  })
})
