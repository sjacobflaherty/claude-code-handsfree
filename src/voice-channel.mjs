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
import { EFFORT_WORDS, loadConfig, MODEL_WORDS, VOICE_ROOT } from './config.mjs'
import { allowedSides, deviceVerdict, hasNameFragment, parseAudiodevOutput } from './devices.mjs'
import { hearCommand } from './hear.mjs'
import {
  ARG_PLACEHOLDERS,
  commandList,
  fillTemplate,
  matchCommand,
  normalizeSpokenText,
  stripTrailingPhrase,
  trailingPhrase,
} from './phrases.mjs'
import { buildSayArgs } from './say.mjs'
import { activeFlagPath, isPidAlive, readActiveFlag } from './sessions.mjs'

const AUDIODEV = join(VOICE_ROOT, 'bin', 'audiodev')
// Runs hear as its own responsible process. Under Cursor or VS Code, whose Info.plist has no speech
// usage string, macOS kills hear with SIGABRT instead of prompting; see src/disclaim.c.
const DISCLAIM = join(VOICE_ROOT, 'bin', 'disclaim')
const STATE_DIR = join(VOICE_ROOT, 'state')
const ACTIVE_FLAG = activeFlagPath(VOICE_ROOT)
const NEXT_MODEL_FILE = join(STATE_DIR, 'next-model')

const INJECT_FILE = process.env.CLAUDE_VOICE_INJECT || ''
const IS_SILENT = process.env.CLAUDE_VOICE_SILENT === '1'
const INJECT_POLL_MS = 500
const HEAR_DEVICE_REFUSAL = 'not a valid audio input device'

// Claude Code discards this server's stderr, so every log line also goes to the file settings.log.file names.
let LOG_FILE = ''
// Partials are cumulative, so each one logs only its length and tail.
const tailOf = (t) => ({ chars: t.length, tail: t.slice(-60) })
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
const logFailure =
  (what, fields = {}) =>
  (e) =>
    log(what, { ...fields, message: String(e?.message ?? e) })

const config = loadConfig({
  root: VOICE_ROOT,
  env: process.env,
  fail: (msg) => {
    log('config error', { message: msg })
    console.error(`[voice] config: ${msg}`)
    process.exit(1)
  },
})
const STRINGS = config.strings
const ADVANCED = config.advanced
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
).map((item) => normalizeSpokenText(item.phrase).split(' ').filter(Boolean))
// Only the model word and an optional effort word follow the phrase, so a longer tail is ordinary speech.
const MODEL_TAIL_MAX = 2
openLog(config)

let isListening = false
let isStopped = false
let isPaused = false
const spokenHistory = []
let replayTimer = null
let hearProc = null
const hearFailures = []
let finalizedText = ''
let partialText = ''
let silenceTimer = null
let sayProc = null
let speakingText = ''
let pendingPermission = null
let permissionTimer = null
let shouldAttachClipboard = false
let baselineDevices = null
let deviceTimer = null
const chosen = { input: String(config.sessionInput ?? ''), output: String(config.sessionOutput ?? '') }
let isBargeInArmed = false
let hasTriedFallbackCut = false
let resumeTimer = null
let resumeSeen = null
let resumeStable = 0
let resumeRefused = ''
let audiodevFailures = 0
let injectTimer = null
let injectLines = 0

// The ratio is near 1 when the microphone is hearing `say` itself and near 0 when the user is talking.
function echoRatio(partial, spoken) {
  const pw = normalizeSpokenText(partial).split(' ').filter(Boolean)
  if (pw.length < ADVANCED.bargeInMinWords) return null
  const sw = normalizeSpokenText(spoken).split(' ').filter(Boolean)
  const spokenPairs = new Set()
  for (let i = 0; i + 1 < sw.length; i++) spokenPairs.add(`${sw[i]} ${sw[i + 1]}`)
  let shared = 0
  for (let i = 0; i + 1 < pw.length; i++) if (spokenPairs.has(`${pw[i]} ${pw[i + 1]}`)) shared++
  return shared / (pw.length - 1)
}

function captureStdout(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8' }, (err, stdout) => resolve(err ? '' : stdout))
  })
}

async function currentDevices() {
  const out = await captureStdout(AUDIODEV, [])
  if (!out.includes('in=')) return null
  const d = { ...parseAudiodevOutput(out), inputUid: '' }
  const pick = (want, dirs) => d.devices.find((x) => dirs.includes(x.dir) && hasNameFragment(x.name, [want]))
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
  if (!hasNameFragment(d.input, [config.fallbackInput])) return false
  const wantOut = config.fallbackOutput || config.fallbackInput
  return hasNameFragment(d.output, [wantOut])
}

function spawnSay(text, { track = false } = {}) {
  const output = chosen.output && baselineDevices?.output ? baselineDevices.output : ''
  const args = buildSayArgs({ rate: config.rate, voice: config.voice, output }, text)
  if (IS_SILENT) {
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
  if (IS_SILENT) return
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
    if (isStopped) return { content: [{ type: 'text', text: 'voice session is stopped; reply in text instead' }] }
    // Claude Code sends no notification when the keyboard answers a prompt, so Claude speaking again is the only sign it closed.
    if (pendingPermission) clearPendingPermission('claude spoke')
    markSpoke()
    spokenHistory.unshift(text)
    if (spokenHistory.length > ADVANCED.replayHistory) spokenHistory.length = ADVANCED.replayHistory
    const result = await speak(text)
    markSpoke()
    return { content: [{ type: 'text', text: result === 'interrupted' ? 'interrupted by the user' : 'spoken' }] }
  }
  if (name === 'voice_start') {
    if (typeof args?.input === 'string') chosen.input = args.input.trim()
    if (typeof args?.output === 'string') chosen.output = args.output.trim()
    if (isListening) stopSession('restart with new devices')
    const started = await startListening()
    // A refused start is spoken as well as returned, because the user asked for it without looking at the screen.
    if (started !== true) spawnSay(started.spoken)
    return {
      content: [
        {
          type: 'text',
          text:
            started === true
              ? `listening input=${baselineDevices.input} output=${baselineDevices.output}`
              : `refused: ${started.text}`,
        },
      ],
    }
  }
  if (name === 'voice_stop') {
    // A stop asked for while the server waits for an allowed pair has to cancel that wait too.
    const isWaitingForDevices = resumeTimer !== null
    if (!isListening && !isWaitingForDevices) return { content: [{ type: 'text', text: 'already stopped' }] }
    clearInterval(resumeTimer)
    resumeTimer = null
    if (isListening) stopSession('stopped by tool')
    else log('stopped: the wait for an allowed device pair was cancelled by tool')
    return { content: [{ type: 'text', text: 'stopped' }] }
  }
  if (name === 'voice_status') {
    const d = (await currentDevices()) ?? { input: 'audiodev failed', output: 'audiodev failed', devices: [] }
    const list = (d.devices ?? [])
      .map((x) => {
        const { asInput, asOutput } = allowedSides(config, x)
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
          text: `listening=${isListening} paused=${isPaused} stopped=${isStopped} input=${d.input} output=${d.output} locale=${config.locale} profile=${config.profile || 'none'} outputRule=${outputRule} devices=[${list}]`,
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
  if (!isListening) return
  pendingPermission = { request_id: params.request_id, tool_name: params.tool_name }
  clearTimeout(permissionTimer)
  permissionTimer = setTimeout(() => {
    if (pendingPermission?.request_id === params.request_id) clearPendingPermission('timed out')
  }, ADVANCED.permissionTimeoutMs)
  const cap = ADVANCED.permissionPreviewChars
  const preview =
    params.input_preview.length > cap
      ? `${params.input_preview.slice(0, cap)} ${STRINGS.andMore}`
      : params.input_preview
  // A yes or no spoken while the prompt is still playing must reach sendVerdict, so the transcript is cleared before the prompt plays.
  const dropped = currentText()
  if (dropped) log('permission prompt discarded text', { text: dropped })
  resetTranscript()
  await speak(
    fillTemplate(STRINGS.permissionPrompt, { tool: params.tool_name, description: params.description, preview }),
  )
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
  log('permission answered', { request_id: p.request_id, behavior })
}

async function sendMessage(text) {
  let content = text
  if (shouldAttachClipboard) {
    shouldAttachClipboard = false
    const clip = (await captureStdout('/usr/bin/pbpaste', [])).trim()
    if (clip) content += `\n\n<clipboard>\n${clip}\n</clipboard>`
  }
  content += REPLY_INSTRUCTION
  // The Stop hook skips a text reply within its grace window of spoke_at_ms, and the previous speak cannot be the reply to this message.
  writeActiveFlag(0)
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: { content, meta: { mode: 'voice', reply_with: 'speak_tool' } },
  })
  log('sent', config.log.includeSentText ? { text } : { chars: text.length })
  if (config.acknowledgementPhrase) spawnSay(config.acknowledgementPhrase)
}

const REPLY_INSTRUCTION =
  '\n\n[Spoken by the user over the voice channel. They are not looking at the screen. ' +
  'Reply by calling the voice server tool `speak` (mcp__voice__speak) with your whole answer as plain ' +
  'spoken sentences: no markdown, no lists, no code. Do not answer in text. After `speak` returns, end ' +
  `the turn with no text at all (after speak: no text, or the one word Replied). ${STRINGS.languageInstruction}]`

// The hooks match sessionId before cwd because the hook payload's cwd follows a cd during the session.
const SESSION_ID = process.env.CLAUDE_VOICE_SESSION_ID || ''
const flagBody = (spoke_at_ms) =>
  JSON.stringify({ spoke_at_ms, pid: process.pid, cwd: process.cwd(), sessionId: SESSION_ID })

// Only a listening server writes the flag, so a refused one cannot take the microphone from the server that holds it.
function writeActiveFlag(spoke_at_ms) {
  if (!isListening) return
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(ACTIVE_FLAG, flagBody(spoke_at_ms))
  } catch {}
}

// The pid in the flag when another server is listening, and 0 when the flag is absent, stale, or this server's own.
function flagOwner() {
  const flag = readActiveFlag(VOICE_ROOT)
  if (!flag || flag.pid === process.pid || !flag.alive) return 0
  return flag.pid
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
  if (readActiveFlag(VOICE_ROOT)?.pid !== process.pid) return
  try {
    unlinkSync(ACTIVE_FLAG)
  } catch {}
}
function markSpoke() {
  writeActiveFlag(Date.now())
}

function resetTranscript() {
  finalizedText = ''
  partialText = ''
  hasTriedFallbackCut = false
  clearTimeout(silenceTimer)
  silenceTimer = null
  restartHear()
}

function currentText() {
  return [finalizedText, partialText].filter(Boolean).join(' ').trim()
}

function startHear() {
  if (!isListening || hearProc || INJECT_FILE) return
  const hearArgs = ['-p', '-l', config.hearLocale]
  if (config.hearOnDeviceOnly) hearArgs.unshift('-d')
  if (baselineDevices?.inputUid) hearArgs.push('-n', baselineDevices.inputUid)
  hearProc = spawn(DISCLAIM, [hearCommand(VOICE_ROOT), ...hearArgs], { stdio: ['ignore', 'pipe', 'pipe'] })
  const proc = hearProc
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
    if (hearProc !== proc) return
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
    log('hear stderr', { message: msg })
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
    if (hearProc !== proc) return
    hearProc = null
    if (buf.trim()) {
      acceptLine(buf)
      buf = ''
    }
    // Repeated exits with nothing transcribed mean hear cannot run at all, such as a revoked permission or a missing binary.
    if (!sawPartial) {
      const now = Date.now()
      hearFailures.push(now)
      while (hearFailures.length && now - hearFailures[0] > ADVANCED.hearFailureWindowMs) hearFailures.shift()
      if (hearFailures.length >= ADVANCED.hearFailureLimit) {
        const reason = rejectedDevice ? 'hear rejected device' : 'hear failing'
        log(reason, { exits: hearFailures.length, code, signal, input: baselineDevices?.input })
        hearFailures.length = 0
        stopSession(reason, {
          spoken: rejectedDevice
            ? fillTemplate(STRINGS.hearRejectedDevice, { input: baselineDevices?.input || 'none' })
            : 'The hear command keeps failing. Check that it is installed and that Terminal has microphone and speech recognition permission.',
        })
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
      paused: isPaused,
      pending_permission: !!pendingPermission,
    })
    if (isPaused) {
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
      sendMessage(body).catch(logFailure('send failed', { trigger: 'hear exit' }))
    } else if (finalizedText) {
      log('hear exit held text, not sent')
    }
    if (isListening && !isStopped) setTimeout(startHear, 150)
  }
}

function restartHear() {
  if (hearProc) {
    const proc = hearProc
    hearProc = null
    proc.removeAllListeners('close')
    try {
      proc.kill('SIGTERM')
    } catch {}
    partialText = ''
    if (isListening && !isStopped) setTimeout(startHear, 150)
  } else if (isListening && !isStopped) {
    startHear()
  }
}

function onTranscriptChanged() {
  // A late partial after stopSession must not arm the silence timer.
  if (!isListening) return
  const text = currentText()
  const answers = config.answers

  if (isBargeInArmed) {
    if (sayProc && speakingText) {
      const ratio = echoRatio(partialText, speakingText)
      if (ratio !== null && ratio < ADVANCED.bargeInMaxEcho) {
        log('barge-in', { ratio: Number(ratio.toFixed(2)), ...tailOf(partialText) })
        stopSpeaking()
      }
    } else if (
      !hasTriedFallbackCut &&
      normalizeSpokenText(partialText).split(' ').filter(Boolean).length >= ADVANCED.bargeInMinWords
    ) {
      // A `say` with no server-tracked process belongs to the Stop hook fallback, whose text is unknown here, so there is no echo guard and one pkill per utterance.
      hasTriedFallbackCut = true
      try {
        execFileSync('/usr/bin/pkill', ['-x', 'say'], { stdio: 'ignore' })
        log('barge-in cut fallback say', tailOf(partialText))
      } catch {}
    }
  }

  // The last word decides, so "yes yes" and "sure, yes" answer and a yes after earlier held text still lands.
  if (pendingPermission) {
    if (trailingPhrase(text, answers.yes)) {
      sendVerdict('allow').catch(logFailure('verdict failed', { behavior: 'allow' }))
      resetTranscript()
      return
    }
    if (trailingPhrase(text, answers.no)) {
      sendVerdict('deny').catch(logFailure('verdict failed', { behavior: 'deny' }))
      resetTranscript()
      return
    }
  }
  if (pendingModel) {
    if (trailingPhrase(text, answers.yes)) {
      const model = pendingModel
      clearPendingModel('confirmed')
      resetTranscript()
      switchModel(model).catch(logFailure('model switch failed'))
      return
    }
    if (trailingPhrase(text, answers.no)) {
      clearPendingModel('declined')
      resetTranscript()
      speak(STRINGS.modelCancelled)
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
  if (isPaused) {
    if (hit?.call === 'resume') {
      isPaused = false
      log('resumed by voice')
      resetTranscript()
      speak(STRINGS.resumed)
    }
    return
  }
  // A settle waits for a word that may never come, so every later transcript cancels the one that is waiting.
  clearTimeout(replayTimer)
  replayTimer = null
  clearTimeout(modelSettleTimer)
  modelSettleTimer = null
  if (hit && runVoiceCommand(hit, text)) return

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
      speak(fillTemplate(STRINGS.unknownModel, { model: late }))
    }, ADVANCED.modelSettleMs)
    return
  }

  if (config.silenceFallbackMs > 0) {
    clearTimeout(silenceTimer)
    silenceTimer = setTimeout(() => {
      const body = currentText()
      if (body && !pendingPermission) {
        log('silence fallback fired')
        sendMessage(body).catch(logFailure('send failed', { trigger: 'silence fallback' }))
        resetTranscript()
      }
    }, config.silenceFallbackMs)
  }
}

// Runs the call a matched entry names. False means the transcript was left alone, so the words count as ordinary speech.
function runVoiceCommand({ call, args, phrase }, text) {
  if (call === 'pause') {
    isPaused = true
    log('paused by voice')
    clearTimeout(silenceTimer)
    silenceTimer = null
    resetTranscript()
    speak(STRINGS.paused)
    return true
  }
  if (call === 'help') {
    log('help phrase', { text })
    resetTranscript()
    speak(fillTemplate(STRINGS.help, { list: HELP_LIST }))
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
      speak(entry ?? fillTemplate(STRINGS.nothingToReplay, { n }))
    }, ADVANCED.replaySettleMs)
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
      speak(fillTemplate(STRINGS.askEffort, { model }))
    }, ADVANCED.modelSettleMs)
    return true
  }
  if (call === 'interrupt') {
    log('interrupt phrase', { text })
    stopSpeaking()
    resetTranscript()
    return true
  }
  if (call === 'clipboard') {
    shouldAttachClipboard = true
    finalizedText = stripTrailingPhrase(text, phrase)
    partialText = ''
    restartHear()
    return true
  }
  if (call === 'send') {
    const body = args.text === ARG_PLACEHOLDERS.text ? stripTrailingPhrase(text, phrase) : args.text
    clearTimeout(silenceTimer)
    silenceTimer = null
    if (body || shouldAttachClipboard) sendMessage(body).catch(logFailure('send failed', { trigger: 'send phrase' }))
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
  const words = normalizeSpokenText(text).split(' ').filter(Boolean)
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
  const words = normalizeSpokenText(text).split(' ')
  return EFFORT_WORDS[words[words.length - 1]] || ''
}

function armModelTimeout() {
  clearTimeout(modelTimer)
  modelTimer = setTimeout(() => {
    if (pendingModel || awaitingEffort) {
      clearPendingModel('timed out')
      speak(STRINGS.modelCancelled)
    }
  }, ADVANCED.modelConfirmMs)
}

function askToSwitch(target, text) {
  log('model phrase', { text, target })
  resetTranscript()
  awaitingEffort = ''
  pendingModel = target
  armModelTimeout()
  speak(fillTemplate(STRINGS.confirmModel, { model: target }))
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
  await speak(fillTemplate(STRINGS.switchingModel, { model }))
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(NEXT_MODEL_FILE, model)
  let parentCmd = ''
  try {
    parentCmd = execFileSync('ps', ['-o', 'command=', '-p', String(process.ppid)], { encoding: 'utf8' })
  } catch {}
  if (!/claude/.test(parentCmd)) {
    log('model switch: parent is not claude, marker written only', { parent_cmd: parentCmd.trim() })
    return
  }
  stopSession('model switch')
  log('model switch: ending claude', { pid: process.ppid, model })
  try {
    process.kill(process.ppid, 'SIGTERM')
  } catch (e) {
    log('model switch: kill failed', { message: String(e?.message ?? e) })
  }
}

// A refusal carries both the line voice_start returns and the sentence the server speaks, which differ where a pid is named.
const refuse = (text, spoken = text) => ({ text, spoken })

function refuseForOtherSession(pid) {
  log('refusing to listen: another voice session is listening', { pid })
  return refuse(`another voice session is listening (pid ${pid})`, STRINGS.anotherSession)
}

function startInject() {
  const owner = claimMicrophone()
  if (owner) return refuseForOtherSession(owner)
  isStopped = false
  isPaused = false
  isListening = true
  shouldAttachClipboard = false
  isBargeInArmed = false
  baselineDevices = { input: INJECT_FILE, output: 'inject', inputUid: '' }
  writeActiveFlag(0)
  finalizedText = ''
  partialText = ''
  clearTimeout(silenceTimer)
  silenceTimer = null
  injectLines = readInjectLines().length
  clearInterval(injectTimer)
  injectTimer = setInterval(pollInject, INJECT_POLL_MS)
  log('inject listening on', { file: INJECT_FILE })
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
  if (!isListening) return
  const lines = readInjectLines()
  while (injectLines < lines.length) {
    const line = lines[injectLines++].trim()
    if (line) injectUtterance(line)
    if (!isListening) return
  }
}

function injectUtterance(line) {
  log('inject', { text: line })
  partialText = line
  onTranscriptChanged()
  const held = currentText()
  if (!held || !isListening) return
  if (replayTimer || modelSettleTimer) return
  if (isPaused) {
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
  sendMessage(held).catch(logFailure('send failed', { trigger: 'inject' }))
}

async function startListening() {
  const ownerPid = flagOwner()
  if (ownerPid) return refuseForOtherSession(ownerPid)
  if (INJECT_FILE) return startInject()
  for (const [helper, path] of [
    ['bin/audiodev', AUDIODEV],
    ['bin/disclaim', DISCLAIM],
  ]) {
    if (existsSync(path)) continue
    log('refusing to listen: helper missing, run npm run build', { helper })
    return refuse(`${helper} is missing, run npm run build in the voice channel folder`, STRINGS.audiodevMissing)
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
      return refuse(STRINGS.noDeviceConfigured)
    }
    log('refusing to listen: device not allowed', {
      input: d.input || 'none',
      output: d.output || 'none',
      side: verdict.side,
      which: verdict.which,
    })
    return refuse(
      fillTemplate(STRINGS.refusedDevice, {
        input: d.input || 'none',
        output: d.output || 'none',
        which: verdict.which,
      }),
    )
  }
  const owner = claimMicrophone()
  if (owner) return refuseForOtherSession(owner)
  clearInterval(resumeTimer)
  resumeTimer = null
  audiodevFailures = 0
  baselineDevices = { input: d.input, output: d.output, inputUid: d.inputUid }
  isBargeInArmed = config.bargeIn && (!config.bargeInSameDeviceOnly || d.input === d.output)
  if (config.bargeIn && !isBargeInArmed)
    log('barge-in off: output is not the input device', { input: d.input, output: d.output })
  if (isBargeInArmed && d.input !== d.output)
    log('barge-in on across devices, echo guard only', { input: d.input, output: d.output })
  isStopped = false
  isPaused = false
  isListening = true
  shouldAttachClipboard = false
  writeActiveFlag(0)
  resetTranscript()
  clearInterval(deviceTimer)
  deviceTimer = setInterval(checkDevices, config.deviceCheckIntervalMs)
  log('listening on', { input: d.input })
  return true
}

async function checkDevices() {
  if (!isListening) return
  const d = await currentDevices()
  if (!d) {
    // A failed read is not a device change, but repeated failures stop the session so the guard is never blind.
    audiodevFailures += 1
    log('audiodev failed', { consecutive: audiodevFailures })
    if (audiodevFailures >= ADVANCED.audiodevFailureLimit)
      stopSession('audiodev failing', { spoken: STRINGS.deviceCheckFailing })
    return
  }
  audiodevFailures = 0
  if (d.input !== baselineDevices.input || d.output !== baselineDevices.output) {
    stopSession('audio device changed', { input: d.input || 'none', output: d.output || 'none' })
    if (config.resumeOnDeviceChange) armResumeWatch()
  }
}

function resumeRefusal(d) {
  const ownerPid = flagOwner()
  if (ownerPid) return `another voice session is listening (pid ${ownerPid})`
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
    if (isListening) {
      clearInterval(resumeTimer)
      resumeTimer = null
      return
    }
    const d = await currentDevices()
    if (!d) return
    const same = resumeSeen && resumeSeen.input === d.input && resumeSeen.output === d.output
    resumeStable = same ? resumeStable + 1 : 1
    resumeSeen = { input: d.input, output: d.output }
    if (resumeStable < ADVANCED.fallbackSettleChecks) return
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
    const started = await startListening()
    log('resuming after device change', {
      input: d.input,
      output: d.output,
      started: started === true ? 'listening' : started.text,
    })
    if (started === true) spawnSay(fillTemplate(STRINGS.switchedDevice, { input: d.input }))
  }, config.deviceCheckIntervalMs)
}

// fields go into the log line; spoken is read aloud after the stopped string.
function stopSession(reason, { spoken = '', ...fields } = {}) {
  if (!isListening) return
  isListening = false
  isStopped = true
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
  if (hearProc) {
    const p = hearProc
    hearProc = null
    p.removeAllListeners('close')
    try {
      p.kill('SIGTERM')
    } catch {}
  }
  stopSpeaking()
  clearActiveFlag()
  log('stopped', { reason, ...fields })
  spawnSay(`${STRINGS.stopped} ${spoken}`.trim())
}

function cleanup() {
  clearInterval(deviceTimer)
  clearInterval(injectTimer)
  clearInterval(resumeTimer)
  clearInterval(parentTimer)
  if (hearProc)
    try {
      hearProc.kill('SIGTERM')
    } catch {}
  hearProc = null
  stopSpeaking()
  clearActiveFlag()
}

// The server must not outlive the session that started it, so it watches the pid it was started from.
const PARENT_PID = process.ppid
let parentTimer = null
function watchParent() {
  clearInterval(parentTimer)
  parentTimer = setInterval(() => {
    if (isPidAlive(PARENT_PID)) return
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
const started = await startListening()
if (started !== true) spawnSay(started.spoken)
