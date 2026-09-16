#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  dim,
  exitOnCrash,
  green,
  IS_VERBOSE,
  printFailRow,
  printHelpIfAsked,
  printOkRow,
  printSection,
  red,
} from './cli.mjs'
import { loadConfig, MIN_NODE_MAJOR, PLUGIN_DIR, SRC, VOICE_ROOT } from './config.mjs'
import { allowedSides, deviceVerdict, hasNameFragment, parseAudiodevOutput } from './devices.mjs'
import { hearCommand, hearVersion } from './hear.mjs'
import { CLAUDE_DIR, defaultRcFile, findRcBlock, LEFTOVER_PATHS, RC_BLOCK_KEY } from './rc-block.mjs'
import { findRunningServers, isClaudeCommand, readActiveFlag, readProcessCommand } from './sessions.mjs'

printHelpIfAsked(`
Check the install: config, tools, audio devices, voices, the plugin, running sessions, and what is outside this folder.
Read-only. Exit 1 on any FAIL.

Examples:
  npm run check                 the FAIL and ok rows
  npm run check -- --verbose    every device, voice, and setting as well
  claude-code-handsfree --check the same from the shell command

Flags:
  --verbose, -v    print the note rows too
  --help, -h       this text
`)
exitOnCrash('npm run check --')

let problems = 0
const recordProblem = (msg) => {
  problems++
  printFailRow(msg)
}
// Notes are for a reader who wants the whole picture; the default output is the rows that need action.
const note = (msg) => {
  if (IS_VERBOSE) console.log(dim(`  note  ${msg}`))
}

printSection('Config')
const config = loadConfig({
  root: VOICE_ROOT,
  env: process.env,
  fail: (m) => {
    recordProblem(m)
    console.log(`\n${problems} problem(s).`)
    process.exit(1)
  },
})
printOkRow(
  `settings: ${config.sources.settings}${config.sources.settingsExample ? ' (the example; copy it to settings.jsonc to edit)' : ''}`,
)
printOkRow(
  `phrases: ${config.sources.phrases}${config.sources.phrasesExample ? ' (the example; copy it to phrases.jsonc to edit)' : ''}`,
)
if (config.sources.profile) printOkRow(`profile ${config.sources.profile}`)
if (config.sources.overrides.length) printOkRow(`flags override: ${config.sources.overrides.join(', ')}`)
note(
  `locale ${config.locale}, hear locale ${config.hearLocale}, voice ${config.voice || '(system default)'}, rate ${config.rate}`,
)
note(
  `allowed inputs ${config.allowedInputs.length ? JSON.stringify(config.allowedInputs) : 'none (no device configured, run npm run setup)'}, allowed outputs ${JSON.stringify(config.allowedOutputs)}`,
)
note(
  `after a device change: ${
    config.resumeOnDeviceChange
      ? config.fallbackInput
        ? `resume only on ${config.fallbackInput} / ${config.fallbackOutput || config.fallbackInput}`
        : 'resume on any allowed pair'
      : 'stay stopped'
  }`,
)
note(
  `turn ending: ${config.silenceFallbackMs ? `auto after ${config.silenceFallbackMs} ms of no change` : 'say the send phrase only'}${config.sendOnFinal && config.hearOnDeviceOnly ? ', or when Apple marks the utterance final' : ''}`,
)
const OWN_DEFAULT = "Claude Code's default"
note(`model ${config.model || OWN_DEFAULT}, effort ${config.effort || OWN_DEFAULT}`)
note(
  `log ${config.log.file ? config.log.file + (config.log.includeSentText ? ' (with sent text)' : ' (lengths only)') : 'off'}`,
)

printSection('Tools')
const nodeMajor = Number(process.versions.node.split('.')[0])
nodeMajor >= MIN_NODE_MAJOR
  ? printOkRow(`node ${process.versions.node}`)
  : recordProblem(`node ${process.versions.node}; ${MIN_NODE_MAJOR} or later is required`)
const hearCmd = hearCommand(VOICE_ROOT)
const hearVer = hearVersion(hearCmd)
hearVer
  ? printOkRow(`${hearVer} (${hearCmd === 'hear' ? 'from PATH' : 'bin/hear, the signed build setup placed'})`)
  : recordProblem('hear not found in bin/ or on PATH; npm run setup downloads the signed build into bin/')
const claude = spawnSync('claude', ['--version'], { encoding: 'utf8' })
if (claude.status !== 0) recordProblem('claude is not on PATH')
else {
  // The binary being there is not a login; an expired token fails every call with a 401 while --version still passes.
  const auth = spawnSync('claude', ['auth', 'status'], { encoding: 'utf8' })
  let status = null
  try {
    status = JSON.parse(auth.stdout)
  } catch {}
  if (status?.loggedIn)
    printOkRow(`claude ${claude.stdout.trim()}, signed in${status.email ? ` as ${status.email}` : ''}`)
  else recordProblem(`claude ${claude.stdout.trim()} is not signed in; run claude, then /login`)
}
const audiodev = join(VOICE_ROOT, 'bin', 'audiodev')
existsSync(audiodev) ? printOkRow('bin/audiodev built') : recordProblem('bin/audiodev missing; run npm run build')
const disclaim = join(VOICE_ROOT, 'bin', 'disclaim')
existsSync(disclaim)
  ? printOkRow(
      'bin/disclaim built (hear runs as its own process for macOS permissions, so Cursor and VS Code terminals work)',
    )
  : recordProblem('bin/disclaim missing; run npm run build')

printSection('Audio devices')
let devices = []
const defaults = { input: '', output: '' }
if (existsSync(audiodev)) {
  const reported = parseAudiodevOutput(spawnSync(audiodev, [], { encoding: 'utf8' }).stdout || '')
  defaults.input = reported.input
  defaults.output = reported.output
  devices = reported.devices
  for (const d of devices) {
    const tags = []
    if (d.name === defaults.input) tags.push('default input')
    if (d.name === defaults.output) tags.push('default output')
    const { asInput, asOutput } = allowedSides(config, d)
    if (asInput) tags.push('allowed input')
    if (asOutput) tags.push('allowed output')
    // The UID is what a session passes to hear -n, so it is shown for every device that can record.
    const uid = d.dir === 'out' ? '' : `  uid ${d.uid || 'none'}`
    note(`${d.name}  [${d.dir}]${uid}${tags.length ? `  ${tags.join(', ')}` : ''}`)
  }
  const overrides = process.env.CLAUDE_VOICE_OVERRIDES ? JSON.parse(process.env.CLAUDE_VOICE_OVERRIDES) : {}
  let input = defaults.input
  let output = defaults.output
  if (overrides.sessionInput) {
    const x = devices.find((d) => d.dir !== 'out' && hasNameFragment(d.name, [overrides.sessionInput]))
    if (x) input = x.name
    else recordProblem(`--input "${overrides.sessionInput}" matches no microphone`)
  }
  if (overrides.sessionOutput) {
    const x = devices.find((d) => d.dir !== 'in' && hasNameFragment(d.name, [overrides.sessionOutput]))
    if (x) output = x.name
    else recordProblem(`--output "${overrides.sessionOutput}" matches no output`)
  }
  const verdict = deviceVerdict(config, { input, output })
  if (verdict.allowed) printOkRow(`a session would listen on "${input}" and speak through "${output}"`)
  else if (verdict.reason === 'unconfigured')
    recordProblem(
      'no device configured: allowedInputs is empty, so a session would refuse to listen. Run npm run setup to pick a microphone',
    )
  else if (!input) recordProblem('no input device')
  else if (verdict.side === 'input') recordProblem(`a session would refuse: input "${input}" is not in allowedInputs`)
  else
    recordProblem(
      `a session would refuse: output "${output || 'none'}" is not allowed (allowedOutputs is ${JSON.stringify(config.allowedOutputs)})`,
    )
}

printSection('Voices')
const say = spawnSync('/usr/bin/say', ['-v', '?'], { encoding: 'utf8' })
if (say.status === 0) {
  const lang = config.hearLocale.split('-')[0].toLowerCase()
  const voices = say.stdout
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      const m = /^(.+?)\s{2,}([a-z]{2,3})[_-]([A-Za-z0-9]+)\s+#\s*(.*)$/.exec(l)
      return m ? { name: m[1].trim(), lang: m[2].toLowerCase(), region: m[3] } : null
    })
    .filter(Boolean)
  const forLocale = voices.filter((v) => v.lang === lang)
  note(`${forLocale.length} voice(s) for ${lang}: ${forLocale.map((v) => v.name).join(', ') || 'none'}`)
  // macOS keeps the system voice out of `say -v '?'` and out of every preference `defaults` reads,
  // so a configured voice can be named here and the system one cannot.
  if (config.voice) {
    voices.some((v) => v.name.toLowerCase() === config.voice.toLowerCase())
      ? printOkRow(`a session would speak in "${config.voice}"`)
      : recordProblem(
          `a session would speak in "${config.voice}", which say -v '?' does not list; say falls back to a built-in voice. Set overrides.${config.locale}.voice to "" in phrases.jsonc to keep the system voice`,
        )
  } else {
    printOkRow(
      'a session would speak in the system voice (System Settings > Accessibility > Spoken Content > System Voice)',
    )
    note(`say -v '?' lists no Siri voice, so an empty voice is the only way to speak in one`)
    if (!forLocale.length) note(`no ${lang} voice installed, which matters only if you name one`)
  }
} else {
  recordProblem('say -v ? failed')
}

printSection('Claude Code')
try {
  JSON.parse(readFileSync(join(PLUGIN_DIR, '.claude-plugin', 'plugin.json'), 'utf8'))
  const h = JSON.parse(readFileSync(join(PLUGIN_DIR, 'hooks', 'hooks.json'), 'utf8'))
  JSON.stringify(h?.hooks?.UserPromptSubmit ?? []).includes('stop-speech.py')
    ? printOkRow('plugin hook: a typed prompt cuts the voice (plugin/hooks/stop-speech.py)')
    : recordProblem('plugin/hooks/hooks.json does not register hooks/stop-speech.py on UserPromptSubmit')
  JSON.stringify(h?.hooks?.Stop ?? []).includes('speak-reply.py')
    ? printOkRow('plugin hook: a text reply is read aloud (plugin/hooks/speak-reply.py)')
    : recordProblem('plugin/hooks/hooks.json does not register hooks/speak-reply.py on Stop')
} catch (e) {
  recordProblem(`plugin files unreadable (${e.message}); launch.mjs passes ${PLUGIN_DIR} as --plugin-dir`)
}
existsSync(join(PLUGIN_DIR, 'skills', 'handsfree', 'SKILL.md'))
  ? printOkRow('plugin skill: /handsfree')
  : recordProblem('plugin/skills/handsfree/SKILL.md missing')
printOkRow('tool permission: launch.mjs passes --allowedTools mcp__voice__*')

printSection('Running sessions')
const active = readActiveFlag(VOICE_ROOT)
if (active?.alive)
  printOkRow(
    `a voice session is listening (server pid ${active.pid}); a second session refuses while it holds state/active.json`,
  )
else if (active) printOkRow(`stale state/active.json names pid ${active.pid}, which is gone, so it blocks nothing`)
else printOkRow('no voice session is listening')
for (const server of findRunningServers()) {
  const parent = readProcessCommand(server.ppid)
  if (isClaudeCommand(parent)) note(`server pid ${server.pid} belongs to claude pid ${server.ppid}`)
  else
    recordProblem(
      `server pid ${server.pid} has no claude session (parent pid ${server.ppid} is ${parent || 'gone'}); end it with: kill ${server.pid}`,
    )
}

printSection('Outside this folder')
const rc = defaultRcFile()
let rcText = ''
try {
  rcText = readFileSync(rc, 'utf8')
} catch {}
findRcBlock(rcText)
  ? printOkRow(`shell block "${RC_BLOCK_KEY}" in ${rc}`)
  : note(`no "${RC_BLOCK_KEY}" block in ${rc}; run npm run setup, or call node ${join(SRC, 'launch.mjs')} directly`)
const settingsPath = join(CLAUDE_DIR, 'settings.json')
let leftovers = 0
try {
  const s = JSON.parse(readFileSync(settingsPath, 'utf8'))
  if ((s?.permissions?.allow ?? []).includes('mcp__voice__*')) {
    leftovers++
    note(`leftover: "mcp__voice__*" in ${settingsPath} (launch.mjs passes --allowedTools now)`)
  }
  if (JSON.stringify(s?.hooks?.Stop ?? []).includes('speak-reply.py')) {
    leftovers++
    note(`leftover: speak-reply.py Stop hook in ${settingsPath} (the plugin registers it per session now)`)
  }
} catch {}
for (const [f] of LEFTOVER_PATHS) {
  try {
    lstatSync(join(CLAUDE_DIR, f))
    leftovers++
    note(`leftover: ${join(CLAUDE_DIR, f)}`)
  } catch {}
}
if (leftovers)
  note('clear them with: claude-code-handsfree --remove (answer n to the shell function question to keep the command)')
else printOkRow(`nothing in ${CLAUDE_DIR}`)

console.log(
  problems
    ? red(`\n${problems} problem(s). Fix them, then run: npm run check`)
    : green('\nAll good. Next: put the headset on and run: claude-code-handsfree'),
)
if (!IS_VERBOSE) console.log(dim('Every device, voice, and setting: npm run check -- --verbose'))
process.exit(problems ? 1 : 0)
