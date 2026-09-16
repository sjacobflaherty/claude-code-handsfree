#!/usr/bin/env node

import { execFile, execFileSync, spawn } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  deviceAllowed,
  deviceVerdict,
  EFFORT_WORDS,
  loadConfig,
  MODEL_WORDS,
  nameMatches,
  pidAlive,
  ROOT,
} from './config.mjs'
import { hearCommand } from './hear.mjs'
import {
  ARG_PLACEHOLDERS,
  commandList,
  endsWithPhrase,
  fmt,
  matchCommand,
  normalize,
  stripTrailingPhrase,
} from './phrases.mjs'

const SERVER_ROOT = process.env.CLAUDE_VOICE_ROOT || ROOT
const AUDIODEV = join(SERVER_ROOT, 'bin', 'audiodev')
// Runs hear as its own responsible process. Under Cursor or VS Code, whose Info.plist has no speech
// usage string, macOS kills hear with SIGABRT instead of prompting; see src/disclaim.c.
const DISCLAIM = join(SERVER_ROOT, 'bin', 'disclaim')
const STATE_DIR = join(SERVER_ROOT, 'state')
const ACTIVE_FLAG = join(STATE_DIR, 'active.json')
const NEXT_MODEL_FILE = join(STATE_DIR, 'next-model')

const INJECT_FILE = process.env.CLAUDE_VOICE_INJECT || ''
const SILENT = process.env.CLAUDE_VOICE_SILENT === '1'
const INJECT_POLL_MS = 500
const HEAR_DEVICE_REFUSAL = 'not a valid audio input device'

// Claude Code discards this server's stderr, so every log line also goes to the file settings.log.file names.
let LOG_FILE = ''
// Partials are cumulative, so each one logs only its length and tail.
const tailOf = (t) => ({ len: t.length, tail: t.slice(-60) })
const log = (...args) => {
  console.error('[voice]', ...args)
  if (!LOG_FILE) return
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}
function openLog(cfg) {
  if (!cfg.log.file) return
  const path = cfg.log.file.replace(/^~(?=\/|$)/, homedir())
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch {}
  try {
    if (cfg.log.rotateBytes && statSync(path).size > cfg.log.rotateBytes) renameSync(path, `${path}.1`)
  } catch {}
  LOG_FILE = path
}
// A send from a timer or a phrase handler is not awaited, and an unhandled rejection would end the process.
const logFailure = (what) => (e) => log(what, String(e?.message ?? e))

const config = loadConfig({
  root: SERVER_ROOT,
  env: process.env,
  fail: (msg) => {
    log('config error:', msg)
    console.error(`[voice] config: ${msg}`)
    process.exit(1)
  },
})
const S = config.strings
const A = config.advanced
const COMMANDS = commandList(config.commands)
const MATCH_WORDS = { numbers: config.numbers, models: MODEL_WORDS, efforts: EFFORT_WORDS }
// voice help reads the first phrase of every entry whose call is not send, in table order.
const HELP_LIST = Object.values(config.commands)
  .filter((entry) => entry.call !== 'send')
  .map((entry) => entry.say[0])
  .join(', ')
// A model word the matcher does not know leaves the whole phrase unmatched, so these phrases are read again below.
const MODEL_PHRASES = COMMANDS.filter(
  (item) => item.call === 'switchModel' && item.args.model === ARG_PLACEHOLDERS.model,
).map((item) => normalize(item.phrase).split(' ').filter(Boolean))
// Only the model word and an optional effort word follow the phrase, so a longer tail is ordinary speech.
const MODEL_TAIL_MAX = 2
openLog(config)

let listening = false
let stopped = false
let paused = false
const spokenHistory = []
let replayTimer = null
let hear = null
const hearFailures = []
let finalizedText = ''
let partialText = ''
let silenceTimer = null
let sayProc = null
let speakingText = ''
let pendingPermission = null
let permissionTimer = null
let attachClipboard = false
let baselineDevices = null
let deviceTimer = null
const chosen = { input: String(config.sessionInput ?? ''), output: String(config.sessionOutput ?? '') }
let bargeInArmed = false
let fallbackCutTried = false
let resumeTimer = null
let resumeSeen = null
let resumeStable = 0
let resumeRefused = ''
let audiodevFailures = 0
let injectTimer = null
let injectLines = 0

// The ratio is near 1 when the microphone is hearing `say` itself and near 0 when the user is talking.
function echoRatio(partial, spoken) {
  const pw = normalize(partial).split(' ').filter(Boolean)
  if (pw.length < A.bargeInMinWords) return null
  const sw = normalize(spoken).split(' ').filter(Boolean)
  const spokenPairs = new Set()
  for (let i = 0; i + 1 < sw.length; i++) spokenPairs.add(`${sw[i]} ${sw[i + 1]}`)
  let shared = 0
  for (let i = 0; i + 1 < pw.length; i++) if (spokenPairs.has(`${pw[i]} ${pw[i + 1]}`)) shared++
  return shared / (pw.length - 1)
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8' }, (err, stdout) => resolve(err ? '' : stdout))
  })
}

async function currentDevices() {
  const out = await run(AUDIODEV, [])
  if (!out.includes('in=')) return null
  const lines = out.split('\n')
  const get = (k) => (lines.find((l) => l.startsWith(`${k}=`)) || '').slice(k.length + 1)
  const devices = lines
    .filter((l) => l.startsWith('dev='))
    .map((l) => {
      const [id, uid, dir, ...name] = l.slice(4).split('\t')
      return { id, uid, dir, name: name.join('\t') }
    })
  const d = { input: get('in'), output: get('out'), inputUid: '', devices }
  const pick = (want, dirs) => devices.find((x) => dirs.includes(x.dir) && nameMatches(x.name, [want]))
  if (chosen.input) {
    const x = pick(chosen.input, ['in', 'both'])
    if (x) {
      d.input = x.name
      d.inputUid = x.uid
    }
  }
  if (chosen.output) {
    const x = pick(chosen.output, ['out', 'both'])
    if (x) d.output = x.name
  }
  return d
}

function isFallbackPair(d) {
  if (!config.fallbackInput) return false
  if (!nameMatches(d.input, [config.fallbackInput])) return false
  const wantOut = config.fallbackOutput || config.fallbackInput
  return nameMatches(d.output, [wantOut])
}

// With no -v, say speaks in the system voice from System Settings > Accessibility > Spoken Content. That is the only
// way to reach a downloaded Siri voice: `say -v '?'` lists none, and an unlisted name makes say fall back to a
// built-in voice. -r, -a, and the -- sentinel do not change the voice; say writes identical bytes either way.
function sayArgs(text) {
  const args = ['-r', String(config.rate)]
  if (config.voice) args.push('-v', config.voice)
  // `say` plays on the macOS default output unless -a names another device.
  if (chosen.output && baselineDevices?.output) args.push('-a', baselineDevices.output)
  args.push('--', text)
  return args
}

function spawnSay(text, { track = false } = {}) {
  const args = sayArgs(text)
  if (SILENT) {
    log('silent say', { text, args })
    const words = text.trim().split(/\s+/).filter(Boolean).length
    const seconds = Math.min(20, Math.max(0.2, words / (config.rate / 60)))
    const proc = spawn('/bin/sleep', [seconds.toFixed(2)], { stdio: 'ignore' })
    if (track) sayProc = proc
    return proc
  }
  const proc = spawn('/usr/bin/say', args, { stdio: 'ignore' })
  if (track) sayProc = proc
  return proc
}

function speak(text) {
  return new Promise((resolve) => {
    stopSpeaking()
    const proc = spawnSay(text, { track: true })
    speakingText = text
    proc.on('exit', (_code, signal) => {
      // A later speak may have replaced this process, and its late exit must not untrack that one.
      if (sayProc === proc) {
        sayProc = null
        speakingText = ''
      }
      resolve(signal ? 'interrupted' : 'done')
    })
  })
}

function stopOwnSpeech() {
  if (sayProc) {
    try {
      sayProc.kill('SIGTERM')
    } catch {}
    sayProc = null
    speakingText = ''
  }
}

// Synchronous, so a speak() that follows cannot race it.
function stopSpeaking() {
  stopOwnSpeech()
  if (SILENT) return
  try {
    execFileSync('/usr/bin/pkill', ['-x', 'say'], { stdio: 'ignore' })
  } catch {}
}

const mcp = new Server(
  { name: 'voice', version: '0.1.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
      tools: {},
    },
    instructions: [
      'Voice messages from the user arrive as <channel source="voice" mode="voice">. They are spoken, so',
      'transcription errors are possible; infer the intent. ALWAYS answer a voice message by calling the',
      '`speak` tool with the full reply, and answer nothing else in text. After `speak` returns, end the',
      'turn with no text at all: no confirmation, no "spoken", no summary. If you write anything after `speak`, it is the single word Replied. If `speak` returns "interrupted by',
      'the user", the user is about to talk: end the turn at once, with no second `speak` call and no text; never',
      'say "okay, listening", "go ahead", or any other filler. Write for the ear: plain sentences,',
      'no markdown, no lists, no code, no URLs. Spell out anything that would be read aloud badly.',
      'When the user asks you to run a drill, interview, or quiz, ask one question at a time and wait.',
      'If a message contains a <clipboard> block, that is text the user copied; use it as the material.',
      'If a voice message is empty or nonsensical, call `speak` with a short request to repeat.',
      'If a message is a fragment (starts mid-sentence, or ends before the point is made), ask for the',
      'missing part instead of answering the most likely reading.',
      'A message can arrive late and refer to an earlier reply or to work you have already done. When',
      'a message does not fit what you just said or did, say what you think it refers to and ask before acting.',
      'Write technical tokens as a person says them. Acronyms spoken letter by letter go as spaced',
      'capitals: M C P, A P I; acronyms spoken as words go as words: jason, yaml. Code names go as plain',
      'words in normal case, and a hyphen or underscore in a name is said as the word dash or underscore:',
      'push message, voice dash channel dot M J S, s t t dash options dot M D, Claude dot M D, dot env, dot pie.',
      'Identifiers such as issue numbers and commit hashes go one character at a time with spaces:',
      '7 1 7 9 2, 6 B D B. Counts, money, percentages, and versions stay as numerals: 1,500, $40, 12%,',
      'version 2.1.69. Dates and times go as spoken: September twelfth, eight thirty in the morning.',
      'Paths, URLs, and flags are described, not read: the channels page on the Claude Code docs, the',
      'no cache flag.',
      'Heteronyms, one spelling with two sounds, are respelled the way they should sound, because the',
      'voice picks one reading: the adjective live is lyve (a lyve session), the past tense read is red',
      'and misread is miss-red, lead the metal is led, the noun record is rekkord, present the noun is',
      'prezzent, close the adjective is cloce, a minute of time stays minute but the adjective is my-newt,',
      'resume the document is rez-oo-may, and the noun content is kontent.',
      'Words the dictionary may not have, such as a prefix stuck on a verb, take a hyphen after the',
      'prefix so the voice reads the parts: re-spell, re-launch, un-pause, pre-flight. A heteronym inside such a word is respelled too: the present tense re-read is re-reed, the past is re-red.',
      config.strings.languageInstruction,
    ].join(' '),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'speak',
      description: 'Speak a reply aloud to the user. Blocks until playback ends or the user interrupts.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Plain spoken sentences.' } },
        required: ['text'],
      },
    },
    {
      name: 'voice_start',
      description:
        'Start or re-arm voice listening. Optionally pick the input or output device for this session by a fragment of its name; it must be on the allowed list. Empty means the macOS default.',
      inputSchema: {
        type: 'object',
        properties: {
          input: {
            type: 'string',
            description: 'Fragment of the microphone name, e.g. "Headset". Empty for the macOS default.',
          },
          output: { type: 'string', description: 'Fragment of the output device name. Empty for the macOS default.' },
        },
      },
    },
    {
      name: 'voice_stop',
      description: 'Stop voice listening. The Claude Code session stays open for typing; voice_start re-arms.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'voice_status',
      description: 'Report whether the voice channel is listening and which audio devices are active.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params
  if (name === 'speak') {
    const text = String(args?.text ?? '').trim()
    if (!text) return { content: [{ type: 'text', text: 'nothing to speak' }] }
    if (stopped) return { content: [{ type: 'text', text: 'voice session is stopped; reply in text instead' }] }
    // Claude Code sends no notification when the keyboard answers a prompt, so Claude speaking again is the only sign it closed.
    if (pendingPermission) clearPendingPermission('claude spoke')
    markSpoke()
    spokenHistory.unshift(text)
    if (spokenHistory.length > A.replayHistory) spokenHistory.length = A.replayHistory
    const result = await speak(text)
    markSpoke()
    return { content: [{ type: 'text', text: result === 'interrupted' ? 'interrupted by the user' : 'spoken' }] }
  }
  if (name === 'voice_start') {
    if (typeof args?.input === 'string') chosen.input = args.input.trim()
    if (typeof args?.output === 'string') chosen.output = args.output.trim()
    if (listening) stopSession('restart with new devices')
    const ok = await startListening()
    // A refused start is spoken as well as returned, because the user asked for it without looking at the screen.
    if (ok !== true) spawnSay(ok.spoken)
    return {
      content: [
        {
          type: 'text',
          text:
            ok === true
              ? `listening input=${baselineDevices.input} output=${baselineDevices.output}`
              : `refused: ${ok.text}`,
        },
      ],
    }
  }
  if (name === 'voice_stop') {
    // A stop asked for while the server waits for an allowed pair has to cancel that wait too.
    const waiting = resumeTimer !== null
    if (!listening && !waiting) return { content: [{ type: 'text', text: 'already stopped' }] }
    clearInterval(resumeTimer)
    resumeTimer = null
    if (listening) stopSession('stopped by tool')
    else log('stopped: the wait for an allowed device pair was cancelled by tool')
    return { content: [{ type: 'text', text: 'stopped' }] }
  }
  if (name === 'voice_status') {
    const d = (await currentDevices()) ?? { input: 'audiodev failed', output: 'audiodev failed', devices: [] }
    const list = (d.devices ?? [])
      .map((x) => {
        const { asInput, asOutput } = deviceAllowed(config, x)
        const tags = []
        if (x.dir !== 'out') tags.push(asInput ? 'input allowed' : 'input not allowed')
        if (x.dir !== 'in') tags.push(asOutput ? 'output allowed' : 'output not allowed')
        return `${x.name} (${x.dir}, ${tags.join(', ')})`
      })
      .join('; ')
    const outputRule = config.allowedOutputs === 'same' ? 'same-as-input' : 'list'
    return {
      content: [
        {
          type: 'text',
          text: `listening=${listening} paused=${paused} stopped=${stopped} input=${d.input} output=${d.output} locale=${config.locale} profile=${config.profile || 'none'} outputRule=${outputRule} devices=[${list}]`,
        },
      ],
    }
  }
  return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true }
})

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  if (!listening) return
  pendingPermission = { request_id: params.request_id, tool_name: params.tool_name }
  clearTimeout(permissionTimer)
  permissionTimer = setTimeout(() => {
    if (pendingPermission?.request_id === params.request_id) clearPendingPermission('timed out')
  }, A.permissionTimeoutMs)
  const cap = A.permissionPreviewChars
  const preview =
    params.input_preview.length > cap ? `${params.input_preview.slice(0, cap)} ${S.andMore}` : params.input_preview
  // A yes or no spoken while the prompt is still playing must reach sendVerdict, so the transcript is cleared before the prompt plays.
  const dropped = currentText()
  if (dropped) log('permission prompt discarded text', { text: dropped })
  resetTranscript()
  await speak(fmt(S.permissionPrompt, { tool: params.tool_name, description: params.description, preview }))
})

function clearPendingPermission(reason) {
  clearTimeout(permissionTimer)
  permissionTimer = null
  if (pendingPermission) log('permission closed', { request_id: pendingPermission.request_id, reason })
  pendingPermission = null
}

async function sendVerdict(behavior) {
  const p = pendingPermission
  clearPendingPermission('answered by voice')
  stopSpeaking()
  await mcp.notification({
    method: 'notifications/claude/channel/permission',
    params: { request_id: p.request_id, behavior },
  })
  log('permission', p.request_id, behavior)
}

async function pushMessage(text) {
  let content = text
  if (attachClipboard) {
    attachClipboard = false
    const clip = (await run('/usr/bin/pbpaste', [])).trim()
    if (clip) content += `\n\n<clipboard>\n${clip}\n</clipboard>`
  }
  content += REPLY_INSTRUCTION
  // The Stop hook skips a text reply within its grace window of ts, and the previous speak cannot be the reply to this message.
  writeActiveFlag(0)
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: { content, meta: { mode: 'voice', reply_with: 'speak_tool' } },
  })
  log('sent', config.log.includeSentText ? { text } : { len: text.length })
  if (config.acknowledgementPhrase) spawnSay(config.acknowledgementPhrase)
}

const REPLY_INSTRUCTION =
  '\n\n[Spoken by the user over the voice channel. They are not looking at the screen. ' +
  'Reply by calling the voice server tool `speak` (mcp__voice__speak) with your whole answer as plain ' +
  'spoken sentences: no markdown, no lists, no code. Do not answer in text. After `speak` returns, end ' +
  `the turn with no text at all (after speak: no text, or the one word Replied). ${S.languageInstruction}]`

// The hooks match sessionId before cwd because the hook payload's cwd follows a cd during the session.
const SESSION_ID = process.env.CLAUDE_VOICE_SESSION_ID || ''
const flagBody = (ts) => JSON.stringify({ ts, pid: process.pid, cwd: process.cwd(), sessionId: SESSION_ID })

// Only a listening server writes the flag, so a refused one cannot take the microphone from the server that holds it.
function writeActiveFlag(ts) {
  if (!listening) return
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(ACTIVE_FLAG, flagBody(ts))
  } catch {}
}

// The pid in the flag when another server is listening, and 0 when the flag is absent, stale, or this server's own.
function flagOwner() {
  let flag
  try {
    flag = JSON.parse(readFileSync(ACTIVE_FLAG, 'utf8'))
  } catch {
    return 0
  }
  const pid = Number(flag?.pid)
  if (pid === process.pid || !pidAlive(pid)) return 0
  return pid
}

// The flag file is the lock on the microphone, and an exclusive create settles two servers that read it at the same moment.
function claimMicrophone() {
  const owner = flagOwner()
  if (owner) return owner
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(ACTIVE_FLAG, flagBody(0), { flag: 'wx' })
  } catch (e) {
    if (e.code === 'EEXIST') return flagOwner()
  }
  return 0
}

function clearActiveFlag() {
  try {
    const flag = JSON.parse(readFileSync(ACTIVE_FLAG, 'utf8'))
    if (Number(flag?.pid) !== process.pid) return
    unlinkSync(ACTIVE_FLAG)
  } catch {}
}
function markSpoke() {
  writeActiveFlag(Date.now())
}

function resetTranscript() {
  finalizedText = ''
  partialText = ''
  fallbackCutTried = false
  clearTimeout(silenceTimer)
  silenceTimer = null
  restartHear()
}

function currentText() {
  return [finalizedText, partialText].filter(Boolean).join(' ').trim()
}

function startHear() {
  if (!listening || hear || INJECT_FILE) return
  const hearArgs = ['-p', '-l', config.hearLocale]
  if (config.hearOnDeviceOnly) hearArgs.unshift('-d')
  if (baselineDevices?.inputUid) hearArgs.push('-n', baselineDevices.inputUid)
  hear = spawn(DISCLAIM, [hearCommand(SERVER_ROOT), ...hearArgs], { stdio: ['ignore', 'pipe', 'pipe'] })
  const proc = hear
  log('hear start', { pid: proc.pid, held: tailOf(finalizedText) })
  let buf = ''
  let sawPartial = false
  let ended = false
  let rejectedDevice = false
  function acceptLine(line) {
    const t = line.trim()
    if (!t) return
    sawPartial = true
    hearFailures.length = 0
    partialText = t
    log('hear partial', { pid: proc.pid, ...tailOf(t) })
    onTranscriptChanged()
  }
  proc.stdout.on('data', (chunk) => {
    // A chunk can still arrive after restartHear killed this process, and acting on it would push a duplicate message.
    if (hear !== proc) return
    buf += chunk.toString()
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) acceptLine(line)
  })
  proc.stderr.on('data', (chunk) => {
    const msg = chunk.toString().trim()
    if (!msg) return
    // This is what hear prints before it exits when -n names a device it will not record from.
    if (msg.includes(HEAR_DEVICE_REFUSAL)) rejectedDevice = true
    log('hear:', msg)
  })
  // ENOENT emits error and then close, never exit, and without a listener Node throws.
  proc.on('error', (err) => {
    log('hear error', { pid: proc.pid, message: err.message })
    onEnded(null, null)
  })
  // close fires after stdout has drained, while exit can fire with a partial still in the pipe.
  proc.on('close', (code, signal) => onEnded(code, signal))
  function onEnded(code, signal) {
    if (ended) return
    ended = true
    if (hear !== proc) return
    hear = null
    if (buf.trim()) {
      acceptLine(buf)
      buf = ''
    }
    // Repeated exits with nothing transcribed mean hear cannot run at all, such as a revoked permission or a missing binary.
    if (!sawPartial) {
      const now = Date.now()
      hearFailures.push(now)
      while (hearFailures.length && now - hearFailures[0] > A.hearFailureWindowMs) hearFailures.shift()
      if (hearFailures.length >= A.hearFailureLimit) {
        const reason = rejectedDevice ? 'hear rejected device' : 'hear failing'
        log(reason, { exits: hearFailures.length, code, signal, input: baselineDevices?.input })
        hearFailures.length = 0
        stopSession(
          reason,
          rejectedDevice
            ? fmt(S.hearRejectedDevice, { input: baselineDevices?.input || 'none' })
            : 'The hear command keeps failing. Check that it is installed and that Terminal has microphone and speech recognition permission.',
        )
        return
      }
    }
    if (partialText) {
      finalizedText = [finalizedText, partialText].filter(Boolean).join(' ')
      partialText = ''
    }
    log('hear exit', {
      pid: proc.pid,
      code,
      signal,
      held: tailOf(finalizedText),
      paused,
      pendingPermission: !!pendingPermission,
    })
    if (paused) {
      finalizedText = ''
    } else if (
      config.sendOnFinal &&
      code === 0 &&
      finalizedText &&
      !pendingPermission &&
      !replayTimer &&
      !modelSettleTimer
    ) {
      const body = finalizedText
      clearTimeout(silenceTimer)
      silenceTimer = null
      finalizedText = ''
      pushMessage(body).catch(logFailure('send failed'))
    } else if (finalizedText) {
      log('hear exit held text, not sent')
    }
    if (listening && !stopped) setTimeout(startHear, 150)
  }
}

function restartHear() {
  if (hear) {
    const proc = hear
    hear = null
    proc.removeAllListeners('close')
    try {
      proc.kill('SIGTERM')
    } catch {}
    partialText = ''
    if (listening && !stopped) setTimeout(startHear, 150)
  } else if (listening && !stopped) {
    startHear()
  }
}

function onTranscriptChanged() {
  // A late partial after stopSession must not arm the silence timer.
  if (!listening) return
  const text = currentText()
  const answers = config.answers

  if (bargeInArmed) {
    if (sayProc && speakingText) {
      const ratio = echoRatio(partialText, speakingText)
      if (ratio !== null && ratio < A.bargeInMaxEcho) {
        log('barge-in', { ratio: Number(ratio.toFixed(2)), ...tailOf(partialText) })
        stopSpeaking()
      }
    } else if (!fallbackCutTried && normalize(partialText).split(' ').filter(Boolean).length >= A.bargeInMinWords) {
      // A `say` with no server-tracked process belongs to the Stop hook fallback, whose text is unknown here, so there is no echo guard and one pkill per utterance.
      fallbackCutTried = true
      try {
        execFileSync('/usr/bin/pkill', ['-x', 'say'], { stdio: 'ignore' })
        log('barge-in cut fallback say', tailOf(partialText))
      } catch {}
    }
  }

  // The last word decides, so "yes yes" and "sure, yes" answer and a yes after earlier held text still lands.
  if (pendingPermission) {
    if (endsWithPhrase(text, answers.yes)) {
      sendVerdict('allow').catch(logFailure('verdict failed'))
      resetTranscript()
      return
    }
    if (endsWithPhrase(text, answers.no)) {
      sendVerdict('deny').catch(logFailure('verdict failed'))
      resetTranscript()
      return
    }
  }
  if (pendingModel) {
    if (endsWithPhrase(text, answers.yes)) {
      const model = pendingModel
      clearPendingModel('confirmed')
      resetTranscript()
      switchModel(model).catch(logFailure('model switch failed'))
      return
    }
    if (endsWithPhrase(text, answers.no)) {
      clearPendingModel('declined')
      resetTranscript()
      speak(S.modelCancelled)
      return
    }
  }
  if (awaitingEffort) {
    const effort = trailingEffort(text)
    if (effort) {
      askToSwitch(`${awaitingEffort} ${effort}`, text)
      return
    }
    clearPendingModel('other speech')
  }

  const hit = matchCommand(text, COMMANDS, MATCH_WORDS)
  if (hit?.call === 'stop') {
    stopSession('stopped by voice')
    return
  }
  if (paused) {
    if (hit?.call === 'resume') {
      paused = false
      log('resumed by voice')
      resetTranscript()
      speak(S.resumed)
    }
    return
  }
  // A settle waits for a word that may never come, so every later transcript cancels the one that is waiting.
  clearTimeout(replayTimer)
  replayTimer = null
  clearTimeout(modelSettleTimer)
  modelSettleTimer = null
  if (hit && runCommand(hit, text)) return

  // The word may still be arriving, so the same settle window the matched phrase uses has to pass first.
  const unknown = unknownModelWord(text)
  if (unknown) {
    log('model word not known', { text, model: unknown })
    modelSettleTimer = setTimeout(() => {
      modelSettleTimer = null
      const late = unknownModelWord(currentText())
      if (!late) return
      log('unknown model', { text: currentText(), model: late })
      resetTranscript()
      speak(fmt(S.unknownModel, { model: late }))
    }, A.modelSettleMs)
    return
  }

  if (config.silenceFallbackMs > 0) {
    clearTimeout(silenceTimer)
    silenceTimer = setTimeout(() => {
      const body = currentText()
      if (body && !pendingPermission) {
        log('silence fallback fired')
        pushMessage(body).catch(logFailure('send failed'))
        resetTranscript()
      }
    }, config.silenceFallbackMs)
  }
}

// Runs the call a matched entry names. False means the transcript was left alone, so the words count as ordinary speech.
function runCommand({ call, args, phrase }, text) {
  if (call === 'pause') {
    paused = true
    log('paused by voice')
    clearTimeout(silenceTimer)
    silenceTimer = null
    resetTranscript()
    speak(S.paused)
    return true
  }
  if (call === 'help') {
    log('help phrase', { text })
    resetTranscript()
    speak(fmt(S.help, { list: HELP_LIST }))
    return true
  }
  if (call === 'replay') {
    // Partials arrive word by word, so the number after "replay voice" lands only after the phrase has already matched.
    replayTimer = setTimeout(() => {
      replayTimer = null
      const later = matchCommand(currentText(), COMMANDS, MATCH_WORDS)
      const n = (later?.call === 'replay' ? later.args.n : 0) || args.n
      const entry = spokenHistory[n - 1]
      log('replay phrase', { text: currentText(), n, found: !!entry })
      resetTranscript()
      speak(entry ?? fmt(S.nothingToReplay, { n }))
    }, A.replaySettleMs)
    return true
  }
  if (call === 'switchModel') {
    const model = args.model
    if (!model) return true // the model word has not arrived yet
    if (args.effort) {
      askToSwitch(`${model} ${args.effort}`, text)
      return true
    }
    // The effort word lands in a later partial than the model word, so the phrase waits for it before asking anything.
    log('model phrase without effort', { text, model })
    modelSettleTimer = setTimeout(() => {
      modelSettleTimer = null
      const late = trailingEffort(currentText())
      if (late) {
        askToSwitch(`${model} ${late}`, currentText())
        return
      }
      resetTranscript()
      awaitingEffort = model
      armModelTimeout()
      log('model phrase waiting for effort', { model })
      speak(fmt(S.askEffort, { model }))
    }, A.modelSettleMs)
    return true
  }
  if (call === 'interrupt') {
    log('interrupt phrase', { text })
    stopSpeaking()
    resetTranscript()
    return true
  }
  if (call === 'clipboard') {
    attachClipboard = true
    finalizedText = stripTrailingPhrase(text, phrase)
    partialText = ''
    restartHear()
    return true
  }
  if (call === 'send') {
    const body = args.text === ARG_PLACEHOLDERS.text ? stripTrailingPhrase(text, phrase) : args.text
    clearTimeout(silenceTimer)
    silenceTimer = null
    if (body || attachClipboard) pushMessage(body).catch(logFailure('send failed'))
    resetTranscript()
    return true
  }
  // A resume outside a pause, and a stop, which the caller has already run.
  return false
}

let pendingModel = ''
let awaitingEffort = ''
let modelTimer = null
let modelSettleTimer = null

// The word after a model phrase when that word names no model, and "" when it does or when no phrase is there.
function unknownModelWord(text) {
  const words = normalize(text).split(' ').filter(Boolean)
  for (const phrase of MODEL_PHRASES) {
    for (let tail = 1; tail <= MODEL_TAIL_MAX; tail++) {
      const end = words.length - tail
      const start = end - phrase.length
      if (start < 0) continue
      if (!phrase.every((w, i) => words[start + i] === w)) continue
      const said = words.slice(end)
      return said.some((w) => MODEL_WORDS[w]) ? '' : said[0]
    }
  }
  return ''
}

function trailingEffort(text) {
  const words = normalize(text).split(' ')
  return EFFORT_WORDS[words[words.length - 1]] || ''
}

function armModelTimeout() {
  clearTimeout(modelTimer)
  modelTimer = setTimeout(() => {
    if (pendingModel || awaitingEffort) {
      clearPendingModel('timed out')
      speak(S.modelCancelled)
    }
  }, A.modelConfirmMs)
}

function askToSwitch(target, text) {
  log('model phrase', { text, target })
  resetTranscript()
  awaitingEffort = ''
  pendingModel = target
  armModelTimeout()
  speak(fmt(S.confirmModel, { model: target }))
}

function clearPendingModel(reason) {
  clearTimeout(modelTimer)
  modelTimer = null
  const open = pendingModel || awaitingEffort
  if (open) log('model switch question closed', { model: open, reason })
  pendingModel = ''
  awaitingEffort = ''
}

async function switchModel(model) {
  await speak(fmt(S.switchingModel, { model }))
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(NEXT_MODEL_FILE, model)
  let parentCmd = ''
  try {
    parentCmd = execFileSync('ps', ['-o', 'command=', '-p', String(process.ppid)], { encoding: 'utf8' })
  } catch {}
  if (!/claude/.test(parentCmd)) {
    log('model switch: parent is not claude, marker written only', { parentCmd: parentCmd.trim() })
    return
  }
  stopSession('model switch')
  log('model switch: ending claude', { pid: process.ppid, model })
  try {
    process.kill(process.ppid, 'SIGTERM')
  } catch (e) {
    log('model switch: kill failed', String(e))
  }
}

// A refusal carries both the line voice_start returns and the sentence the server speaks, which differ where a pid is named.
const refuse = (text, spoken = text) => ({ text, spoken })

function refuseToOther(pid) {
  log('refusing to listen: another voice session is listening', { pid })
  return refuse(`another voice session is listening (pid ${pid})`, S.anotherSession)
}

function startInject() {
  const owner = claimMicrophone()
  if (owner) return refuseToOther(owner)
  stopped = false
  paused = false
  listening = true
  attachClipboard = false
  bargeInArmed = false
  baselineDevices = { input: INJECT_FILE, output: 'inject', inputUid: '' }
  writeActiveFlag(0)
  finalizedText = ''
  partialText = ''
  clearTimeout(silenceTimer)
  silenceTimer = null
  injectLines = readInjectLines().length
  clearInterval(injectTimer)
  injectTimer = setInterval(pollInject, INJECT_POLL_MS)
  log('inject listening on', INJECT_FILE)
  return true
}

function readInjectLines() {
  let text = ''
  try {
    text = readFileSync(INJECT_FILE, 'utf8')
  } catch {
    return []
  }
  const lines = text.split('\n')
  lines.pop()
  return lines
}

function pollInject() {
  if (!listening) return
  const lines = readInjectLines()
  while (injectLines < lines.length) {
    const line = lines[injectLines++].trim()
    if (line) injectUtterance(line)
    if (!listening) return
  }
}

function injectUtterance(line) {
  log('inject', { text: line })
  partialText = line
  onTranscriptChanged()
  const held = currentText()
  if (!held || !listening) return
  if (replayTimer || modelSettleTimer) return
  if (paused) {
    finalizedText = ''
    partialText = ''
    return
  }
  if (pendingPermission) {
    finalizedText = held
    partialText = ''
    return
  }
  resetTranscript()
  pushMessage(held).catch(logFailure('send failed'))
}

async function startListening() {
  const busy = flagOwner()
  if (busy) return refuseToOther(busy)
  if (INJECT_FILE) return startInject()
  for (const [helper, path] of [
    ['bin/audiodev', AUDIODEV],
    ['bin/disclaim', DISCLAIM],
  ]) {
    if (existsSync(path)) continue
    log(`refusing to listen: ${helper} is missing; run npm run build`)
    return refuse(`${helper} is missing, run npm run build in the voice channel folder`, S.audiodevMissing)
  }
  const d = await currentDevices()
  if (!d) {
    log('refusing to listen: audiodev failed')
    return refuse('bin/audiodev failed to report the audio devices')
  }
  const verdict = deviceVerdict(config, d)
  if (!verdict.allowed) {
    if (verdict.reason === 'unconfigured') {
      log('refusing to listen: allowedInputs is empty; run npm run setup to pick a microphone')
      return refuse(S.noDeviceConfigured)
    }
    log('refusing to listen: input =', d.input || 'none', 'output =', d.output || 'none', 'refused =', verdict.which)
    return refuse(fmt(S.refusedDevice, { input: d.input || 'none', output: d.output || 'none', which: verdict.which }))
  }
  const owner = claimMicrophone()
  if (owner) return refuseToOther(owner)
  clearInterval(resumeTimer)
  resumeTimer = null
  audiodevFailures = 0
  baselineDevices = { input: d.input, output: d.output, inputUid: d.inputUid }
  bargeInArmed = config.bargeIn && (!config.bargeInSameDeviceOnly || d.input === d.output)
  if (config.bargeIn && !bargeInArmed)
    log('barge-in off: output is not the input device', { input: d.input, output: d.output })
  if (bargeInArmed && d.input !== d.output)
    log('barge-in on across devices, echo guard only', { input: d.input, output: d.output })
  stopped = false
  paused = false
  listening = true
  attachClipboard = false
  writeActiveFlag(0)
  resetTranscript()
  clearInterval(deviceTimer)
  deviceTimer = setInterval(checkDevices, config.deviceCheckIntervalMs)
  log('listening on', d.input)
  return true
}

async function checkDevices() {
  if (!listening) return
  const d = await currentDevices()
  if (!d) {
    // A failed read is not a device change, but repeated failures stop the session so the guard is never blind.
    audiodevFailures += 1
    log('audiodev failed', { consecutive: audiodevFailures })
    if (audiodevFailures >= A.audiodevFailureLimit) stopSession('audiodev failing', S.deviceCheckFailing)
    return
  }
  audiodevFailures = 0
  if (d.input !== baselineDevices.input || d.output !== baselineDevices.output) {
    stopSession(`audio device changed to ${d.input || 'none'}`)
    if (config.resumeOnDeviceChange) armResumeWatch()
  }
}

function resumeRefusal(d) {
  const busy = flagOwner()
  if (busy) return `another voice session is listening (pid ${busy})`
  if (config.fallbackInput && !isFallbackPair(d)) return 'not the fallback pair'
  const verdict = deviceVerdict(config, d)
  if (verdict.allowed) return ''
  return verdict.reason === 'unconfigured'
    ? 'allowedInputs is empty'
    : `${verdict.side} ${verdict.which} is not allowed`
}

// macOS routes through the built-in devices for a moment during a Bluetooth handoff, so one read of the new pair is not enough.
function armResumeWatch() {
  clearInterval(resumeTimer)
  resumeSeen = null
  resumeStable = 0
  resumeRefused = ''
  resumeTimer = setInterval(async () => {
    if (listening) {
      clearInterval(resumeTimer)
      resumeTimer = null
      return
    }
    const d = await currentDevices()
    if (!d) return
    const same = resumeSeen && resumeSeen.input === d.input && resumeSeen.output === d.output
    resumeStable = same ? resumeStable + 1 : 1
    resumeSeen = { input: d.input, output: d.output }
    if (resumeStable < A.fallbackSettleChecks) return
    const refusal = resumeRefusal(d)
    if (refusal) {
      // The watch keeps polling, so each settled pair is logged once instead of every interval.
      const seen = `${d.input}|${d.output}|${refusal}`
      if (resumeRefused !== seen) {
        resumeRefused = seen
        log('not resuming', { input: d.input || 'none', output: d.output || 'none', reason: refusal })
      }
      return
    }
    clearInterval(resumeTimer)
    resumeTimer = null
    const ok = await startListening()
    log('resuming after device change', { input: d.input, output: d.output, ok: ok === true ? 'listening' : ok.text })
    if (ok === true) spawnSay(fmt(S.switchedDevice, { input: d.input }))
  }, config.deviceCheckIntervalMs)
}

function stopSession(reason, spokenReason = '') {
  if (!listening) return
  listening = false
  stopped = true
  clearInterval(deviceTimer)
  clearInterval(injectTimer)
  injectTimer = null
  clearTimeout(silenceTimer)
  silenceTimer = null
  clearTimeout(replayTimer)
  replayTimer = null
  clearTimeout(modelSettleTimer)
  modelSettleTimer = null
  clearPendingPermission('session stopped')
  finalizedText = ''
  partialText = ''
  if (hear) {
    const p = hear
    hear = null
    p.removeAllListeners('close')
    try {
      p.kill('SIGTERM')
    } catch {}
  }
  stopSpeaking()
  clearActiveFlag()
  log('stopped:', reason)
  spawnSay(`${S.stopped} ${spokenReason}`.trim())
}

function cleanup() {
  clearInterval(deviceTimer)
  clearInterval(injectTimer)
  clearInterval(resumeTimer)
  clearInterval(parentTimer)
  if (hear)
    try {
      hear.kill('SIGTERM')
    } catch {}
  hear = null
  stopSpeaking()
  clearActiveFlag()
}

// The server must not outlive the session that started it, so it watches the pid it was started from.
const PARENT_PID = process.ppid
let parentTimer = null
function watchParent() {
  clearInterval(parentTimer)
  parentTimer = setInterval(() => {
    if (pidAlive(PARENT_PID)) return
    log('parent gone, exiting', { parent: PARENT_PID })
    cleanup()
    process.exit(0)
  }, config.deviceCheckIntervalMs)
}
process.on('exit', cleanup)
process.on('SIGINT', () => {
  cleanup()
  process.exit(0)
})
process.on('SIGTERM', () => {
  cleanup()
  process.exit(0)
})

// When Claude Code closes the pipe, exit now instead of recording until the next send fails.
mcp.onclose = () => {
  log('transport closed')
  cleanup()
  process.exit(0)
}
await mcp.connect(new StdioServerTransport())
watchParent()
const ok = await startListening()
if (ok !== true) spawnSay(ok.spoken)
