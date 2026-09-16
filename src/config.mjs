import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ARG_PLACEHOLDERS } from './phrases.mjs'

export const SRC = dirname(fileURLToPath(import.meta.url))
export const ROOT = dirname(SRC)
export const PLUGIN_DIR = join(ROOT, 'plugin')
export const APP_NAME = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name
export const MIN_NODE_MAJOR = 20
// The folder holding settings.jsonc, phrases.jsonc, locales/, bin/ and state/, which the tests point elsewhere.
export const VOICE_ROOT = process.env.CLAUDE_VOICE_ROOT || ROOT

export const DEFAULTS = {
  profile: '',
  allowedInputs: [],
  allowedOutputs: 'same',
  resumeOnDeviceChange: true,
  fallbackInput: '',
  fallbackOutput: '',
  deviceCheckIntervalMs: 2000,
  sendOnFinal: true,
  silenceFallbackMs: 6000,
  rate: 190,
  hearOnDeviceOnly: false,
  bargeIn: true,
  bargeInSameDeviceOnly: true,
  model: '',
  effort: '',
  speakLaunchCue: true,
  keepTranscript: true,
  log: {
    file: '~/Library/Logs/claude-code-handsfree.log',
    includeSentText: true,
    rotateBytes: 5 * 1024 * 1024,
  },
  advanced: {
    replayHistory: 10,
    replaySettleMs: 1500,
    bargeInMaxEcho: 0.6,
    bargeInMinWords: 2,
    permissionTimeoutMs: 120000,
    permissionPreviewChars: 300,
    modelSettleMs: 1500,
    modelConfirmMs: 20000,
    audiodevFailureLimit: 3,
    hearFailureLimit: 3,
    hearFailureWindowMs: 5000,
    fallbackSettleChecks: 2,
  },
}
export const LANGUAGE_DEFAULTS = {
  locale: 'en',
  commandPrefix: '',
  overrides: {},
}
const PHRASES_FILE_KEYS = new Set(Object.keys(LANGUAGE_DEFAULTS))
export const LANGUAGE_KEYS = ['hearLocale', 'voice', 'numbers', 'commands', 'answers', 'strings']
const LANGUAGE_MAPS = ['numbers', 'commands', 'answers', 'strings']
const LANGUAGE_FLAG_KEYS = ['voice', 'hearLocale']

// Every call a command entry may name, with the arguments that call takes and the type of each.
export const COMMAND_CALLS = {
  send: { text: 'string' },
  interrupt: {},
  stop: {},
  pause: {},
  resume: {},
  clipboard: {},
  replay: { n: 'number' },
  switchModel: { model: 'string', effort: 'string' },
  help: {},
}
const COMMAND_KEYS = ['say', 'call', 'args']
export const ANSWER_GROUPS = ['yes', 'no']
export const LOCALE_STRINGS = [
  'acknowledgement',
  'paused',
  'resumed',
  'stopped',
  'nothingToReplay',
  'permissionPrompt',
  'andMore',
  'deviceCheckFailing',
  'refusedDevice',
  'noDeviceConfigured',
  'anotherSession',
  'switchedDevice',
  'hearRejectedDevice',
  'audiodevMissing',
  'languageInstruction',
  'switchingModel',
  'unknownModel',
  'confirmModel',
  'askEffort',
  'modelCancelled',
  'launchCue',
  'launchCueSwitch',
  'help',
]
const RENAMED_STRINGS = { ack: 'acknowledgement' }
export const MODEL_WORDS = { opus: 'opus', sonnet: 'sonnet', haiku: 'haiku', fable: 'fable', fables: 'fable' }
// below is what the recognizer writes for low after a model name.
export const EFFORT_WORDS = { low: 'low', below: 'low', medium: 'medium', high: 'high', max: 'max', maximum: 'max' }

export function parseJsonc(text, label = 'jsonc') {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    const next = text[i + 1]
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') j++
        j++
      }
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
    } else {
      out += c
      i++
    }
  }
  out = out.replace(/,(\s*[}\]])/g, '$1')
  try {
    return JSON.parse(out)
  } catch (e) {
    throw new Error(`${label}: ${e.message}`)
  }
}

function readJsonc(path) {
  return parseJsonc(readFileSync(path, 'utf8'), path)
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

export function configPath(root, base) {
  for (const ext of ['jsonc', 'json']) {
    const p = join(root, `${base}.${ext}`)
    if (existsSync(p)) return { path: p, example: false }
  }
  return { path: join(root, `${base}.example.jsonc`), example: true }
}

// fail(message) must not return.
export function loadConfig({ root, env = process.env, fail }) {
  const settingsFile = configPath(root, 'settings')
  const phrasesFile = configPath(root, 'phrases')
  const readObject = (path) => {
    let raw
    try {
      raw = readJsonc(path)
    } catch (e) {
      fail(String(e.message))
    }
    if (!isPlainObject(raw)) fail(`${path}: top level must be an object`)
    return raw
  }
  const settingsRaw = readObject(settingsFile.path)
  const phrasesRaw = readObject(phrasesFile.path)
  const checkSettingsKeys = (raw, path) => {
    for (const key of PHRASES_FILE_KEYS)
      if (key in raw) fail(`${path}: "${key}" belongs in the phrases file, not settings`)
    for (const key of LANGUAGE_KEYS)
      if (key in raw)
        fail(`${path}: "${key}" is language material; put it under overrides.<locale> in the phrases file`)
  }
  const checkPhrasesKeys = (raw, path) => {
    for (const key of Object.keys(raw)) {
      if (LANGUAGE_KEYS.includes(key))
        fail(`${path}: "${key}" goes under overrides.<locale>, for example overrides.en.${key}`)
      if (!PHRASES_FILE_KEYS.has(key)) fail(`${path}: "${key}" belongs in settings, not the phrases file`)
    }
    if ('overrides' in raw) {
      if (!isPlainObject(raw.overrides)) fail(`${path}: "overrides" must be an object keyed by locale`)
      for (const [loc, block] of Object.entries(raw.overrides)) {
        if (!isPlainObject(block)) fail(`${path}: "overrides.${loc}" must be an object`)
        for (const key of Object.keys(block)) {
          if (!LANGUAGE_KEYS.includes(key))
            fail(`${path}: "overrides.${loc}.${key}" is not a language key (known: ${LANGUAGE_KEYS.join(', ')})`)
        }
      }
    }
  }
  checkSettingsKeys(settingsRaw, settingsFile.path)
  checkPhrasesKeys(phrasesRaw, phrasesFile.path)

  let cfg = { ...DEFAULTS, ...LANGUAGE_DEFAULTS, ...settingsRaw, ...phrasesRaw }
  if (isPlainObject(settingsRaw.advanced)) cfg.advanced = { ...DEFAULTS.advanced, ...settingsRaw.advanced }
  if (isPlainObject(settingsRaw.log)) cfg.log = { ...DEFAULTS.log, ...settingsRaw.log }
  const languageLayers = []
  if (isPlainObject(phrasesRaw.overrides))
    languageLayers.push({ label: phrasesFile.path, byLocale: phrasesRaw.overrides })

  const profileName = env.CLAUDE_VOICE_PROFILE || cfg.profile || ''
  let profilePath = ''
  if (profileName) {
    if (!/^[\w-]+$/.test(profileName)) fail(`profile name "${profileName}" may only contain letters, digits, _ and -`)
    profilePath = join(root, 'profiles', profileName)
    if (!existsSync(profilePath)) fail(`profile "${profileName}" not found at ${profilePath}`)
    const profSettings = configPath(profilePath, 'settings')
    const profPhrases = configPath(profilePath, 'phrases')
    if (profSettings.example && profPhrases.example)
      fail(`profile "${profileName}" has no settings.jsonc or phrases.jsonc in ${profilePath}`)
    let prof = {}
    if (!profSettings.example) {
      const s = readObject(profSettings.path)
      checkSettingsKeys(s, profSettings.path)
      prof = { ...prof, ...s }
    }
    if (!profPhrases.example) {
      const p = readObject(profPhrases.path)
      checkPhrasesKeys(p, profPhrases.path)
      if (isPlainObject(p.overrides)) languageLayers.push({ label: profPhrases.path, byLocale: p.overrides })
      delete p.overrides
      prof = { ...prof, ...p }
    }
    for (const k of ['advanced', 'log']) {
      if (isPlainObject(prof[k]) && isPlainObject(cfg[k])) prof = { ...prof, [k]: { ...cfg[k], ...prof[k] } }
    }
    cfg = { ...cfg, ...prof }
  }

  let overrides = {}
  const flagLanguage = {}
  if (env.CLAUDE_VOICE_OVERRIDES) {
    try {
      overrides = JSON.parse(env.CLAUDE_VOICE_OVERRIDES)
    } catch (e) {
      fail(`CLAUDE_VOICE_OVERRIDES is not valid JSON (${e.message})`)
    }
    if (!isPlainObject(overrides)) fail('CLAUDE_VOICE_OVERRIDES must be a JSON object')
    for (const k of ['advanced', 'log']) {
      if (isPlainObject(overrides[k]) && isPlainObject(cfg[k]))
        overrides = { ...overrides, [k]: { ...cfg[k], ...overrides[k] } }
    }
    for (const k of LANGUAGE_FLAG_KEYS)
      if (k in overrides) {
        flagLanguage[k] = overrides[k]
        delete overrides[k]
      }
    cfg = { ...cfg, ...overrides }
  }
  delete cfg.overrides

  for (const key of Object.keys(DEFAULTS)) {
    if (key === 'allowedInputs' || key === 'allowedOutputs') continue
    if (typeof cfg[key] !== typeof DEFAULTS[key]) fail(`"${key}" must be a ${typeof DEFAULTS[key]}`)
  }
  for (const key of ['locale', 'commandPrefix']) {
    if (typeof cfg[key] !== 'string') fail(`"${key}" must be a string`)
  }
  for (const [key, def] of Object.entries(DEFAULTS.advanced)) {
    const v = cfg.advanced[key]
    if (typeof v !== 'number' || Number.isNaN(v) || v < 0)
      fail(`"advanced.${key}" must be a number of at least 0 (default ${def})`)
  }
  for (const key of Object.keys(cfg.advanced)) {
    if (!(key in DEFAULTS.advanced)) fail(`"advanced.${key}" is not a known setting`)
  }
  if (typeof cfg.log.file !== 'string') fail('"log.file" must be a string (empty disables the log file)')
  if (typeof cfg.log.includeSentText !== 'boolean') fail('"log.includeSentText" must be true or false')
  if (typeof cfg.log.rotateBytes !== 'number' || cfg.log.rotateBytes < 0)
    fail('"log.rotateBytes" must be a number of at least 0')
  for (const key of Object.keys(cfg.log)) {
    if (!(key in DEFAULTS.log)) fail(`"log.${key}" is not a known setting`)
  }
  const nameList = (key, { allowSame = false, allowEmpty = false } = {}) => {
    const v = cfg[key]
    if (allowSame && v === 'same') return
    if (!Array.isArray(v) || (!allowEmpty && !v.length) || !v.every((s) => typeof s === 'string' && s.trim())) {
      fail(
        `"${key}" must be ${allowEmpty ? 'an' : 'a non-empty'} array of device name fragments${allowSame ? ' or "same"' : ''}`,
      )
    }
  }
  nameList('allowedInputs', { allowEmpty: true })
  nameList('allowedOutputs', { allowSame: true })
  if (!/^[a-z]{2}(-[A-Za-z]{2})?$/.test(cfg.locale)) fail(`"locale" must look like "en" or "en-GB"`)
  if (cfg.rate < 90 || cfg.rate > 400) fail(`"rate" ${cfg.rate} is outside 90 to 400 words per minute`)

  const localePath = join(root, 'locales', `${cfg.locale}.json`)
  let lang
  try {
    lang = JSON.parse(readFileSync(localePath, 'utf8'))
  } catch (e) {
    fail(`locales/${cfg.locale}.json: cannot read or parse (${e.message})`)
  }
  for (const k of LANGUAGE_MAPS) if (!isPlainObject(lang[k])) fail(`locales/${cfg.locale}.json: "${k}" is missing`)
  const applyLanguage = (block, label) => {
    for (const [key, value] of Object.entries(block)) {
      if (LANGUAGE_MAPS.includes(key)) {
        if (!isPlainObject(value)) fail(`${label}: "${key}" must be an object`)
        lang[key] = { ...lang[key], ...value }
      } else {
        if (typeof value !== 'string') fail(`${label}: "${key}" must be a string`)
        lang[key] = value
      }
    }
  }
  for (const layer of languageLayers) {
    const block = layer.byLocale[cfg.locale]
    if (isPlainObject(block)) applyLanguage(block, `${layer.label} overrides.${cfg.locale}`)
  }
  applyLanguage(flagLanguage, 'flags')

  for (const key of LOCALE_STRINGS) {
    if (typeof lang.strings[key] !== 'string')
      fail(`strings.${key} must be a string (locales/${cfg.locale}.json or overrides.${cfg.locale}.strings)`)
  }
  for (const key of Object.keys(lang.strings)) {
    if (RENAMED_STRINGS[key]) fail(`"strings.${key}" is now "strings.${RENAMED_STRINGS[key]}"`)
    if (!LOCALE_STRINGS.includes(key))
      fail(`"strings.${key}" is not a known spoken string (known: ${LOCALE_STRINGS.join(', ')})`)
  }
  const langSource = `locales/${cfg.locale}.json or overrides.${cfg.locale}`
  for (const group of Object.keys(lang.answers)) {
    if (!ANSWER_GROUPS.includes(group))
      fail(`"answers.${group}" is not a known answer (known: ${ANSWER_GROUPS.join(', ')})`)
  }
  for (const group of ANSWER_GROUPS) {
    const list = lang.answers[group]
    if (!Array.isArray(list) || !list.length || !list.every((p) => typeof p === 'string' && p.trim()))
      fail(`"answers.${group}" must be a non-empty array of strings (${langSource}.answers)`)
  }
  for (const [key, entry] of Object.entries(lang.commands)) {
    const at = `commands.${key}`
    if (!isPlainObject(entry)) fail(`"${at}" must be an object with "say" and "call" (${langSource}.commands)`)
    for (const name of Object.keys(entry)) {
      if (!COMMAND_KEYS.includes(name)) fail(`"${at}.${name}" is not a known key (known: ${COMMAND_KEYS.join(', ')})`)
    }
    if (!Array.isArray(entry.say) || !entry.say.length || !entry.say.every((p) => typeof p === 'string' && p.trim()))
      fail(`"${at}.say" must be a non-empty array of spoken phrases (${langSource}.commands)`)
    if (typeof entry.call !== 'string' || !(entry.call in COMMAND_CALLS))
      fail(`"${at}.call" must be one of ${Object.keys(COMMAND_CALLS).join(', ')}`)
    const spec = COMMAND_CALLS[entry.call]
    if ('args' in entry && !isPlainObject(entry.args)) fail(`"${at}.args" must be an object`)
    for (const [name, value] of Object.entries(entry.args ?? {})) {
      if (!(name in spec))
        fail(
          `"${at}.args.${name}" is not an argument of ${entry.call} (takes ${Object.keys(spec).join(', ') || 'no arguments'})`,
        )
      if (value === ARG_PLACEHOLDERS[name]) continue
      if (typeof value !== spec[name])
        fail(`"${at}.args.${name}" must be a ${spec[name]} or "${ARG_PLACEHOLDERS[name]}"`)
    }
  }
  // numbers is keyed by the reply the word picks, so one entry holds every word heard for that reply.
  // The matcher wants the other direction, so the lists are flattened into word to number here.
  const numberWords = {}
  for (const [key, words] of Object.entries(lang.numbers)) {
    const at = `numbers.${key}`
    if (!/^\d+$/.test(key))
      fail(
        `"${at}" is a word key; numbers is keyed by the reply, as "numbers": { "1": ["${key}"] } (${langSource}.numbers)`,
      )
    if (Number(key) < 1) fail(`"${at}" must be a positive whole number (${langSource}.numbers)`)
    if (!Array.isArray(words) || !words.length || !words.every((w) => typeof w === 'string' && w.trim()))
      fail(`"${at}" must be a non-empty array of words (${langSource}.numbers)`)
    for (const word of words) numberWords[word] = Number(key)
  }
  // Rewriting the phrases means the matcher needs no prefix case and stripTrailingPhrase removes the prefix with the phrase.
  const prefix = cfg.commandPrefix.trim()
  cfg.commands = Object.fromEntries(
    Object.entries(lang.commands).map(([key, entry]) => {
      const placeholders = Object.fromEntries(
        Object.keys(COMMAND_CALLS[entry.call]).map((n) => [n, ARG_PLACEHOLDERS[n]]),
      )
      return [
        key,
        {
          say: prefix ? entry.say.map((p) => `${prefix} ${p}`) : entry.say,
          call: entry.call,
          args: { ...placeholders, ...entry.args },
        },
      ]
    }),
  )
  cfg.answers = lang.answers
  cfg.numbers = numberWords
  cfg.strings = lang.strings
  cfg.acknowledgementPhrase = lang.strings.acknowledgement
  cfg.hearLocale = typeof lang.hearLocale === 'string' && lang.hearLocale ? lang.hearLocale : 'en-US'
  cfg.voice = typeof lang.voice === 'string' ? lang.voice : ''

  cfg.sources = {
    settings: settingsFile.path,
    settingsExample: settingsFile.example,
    phrases: phrasesFile.path,
    phrasesExample: phrasesFile.example,
    profile: profilePath,
    overrides: Object.keys(overrides),
  }
  return cfg
}
