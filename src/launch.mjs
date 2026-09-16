#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, MIN_NODE_MAJOR, PLUGIN_DIR, ROOT, SRC } from './config.mjs'

const USAGE = `Start Claude Code with the voice channel loaded.

Examples:
  claude-code-handsfree                      a session, voice on, settings from settings.jsonc
  claude-code-handsfree --input airpods      listen on the microphone whose name has "airpods"
  claude-code-handsfree --model opus --effort high
  claude-code-handsfree --check              run the checks and exit
  claude-code-handsfree --remove --dry-run   show what an uninstall would delete

Voice flags, for this session only (they override settings.jsonc and the profile):
  --profile NAME      profiles/NAME/ on top of settings.jsonc and phrases.jsonc
  --locale CODE       en, es, ... (the "locale" key of phrases.jsonc)
  --voice NAME        a \`say -v '?'\` voice, for the active locale
  --input FRAGMENT    microphone to use, by a fragment of its name (must be allowed)
  --output FRAGMENT   output device, same rule
  --model NAME        Claude model (default from config)
  --effort LEVEL      Claude effort (default from config)
  --set KEY=VALUE     any other config key; VALUE is JSON when it parses, else a string
  --check             run the checks and exit
  --remove            undo everything setup wrote outside this folder, then exit
  --help, -h          this text
Every other argument goes to claude unchanged.

Model switching by voice: the session gets a fixed id, and when state/next-model exists
after claude exits, the launcher resumes the same session on that model.`

const NEXT_MODEL_FILE = join(ROOT, 'state', 'next-model')
const VOICE_FLAGS = new Set(['--profile', '--locale', '--voice', '--input', '--output', '--model', '--effort', '--set'])

export function buildClaudeArgs({ sessionId, model, effort, resume = false, claudeArgs = [] }) {
  return [
    '--mcp-config',
    JSON.stringify({ mcpServers: { voice: { command: 'node', args: [join(SRC, 'voice-channel.mjs')] } } }),
    '--dangerously-load-development-channels',
    'server:voice',
    '--plugin-dir',
    PLUGIN_DIR,
    '--allowedTools',
    'mcp__voice__*',
    // An empty model or effort passes no flag, which leaves Claude Code its own default.
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
    ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]),
    ...claudeArgs,
  ]
}

// The server builds its own say arguments the same way; -r, -v, and the -- sentinel are all a cue needs.
export function buildSayArgs({ rate, voice }, text) {
  const args = ['-r', String(rate)]
  if (voice) args.push('-v', voice)
  args.push('--', text)
  return args
}

// Nobody is at the keyboard to hear a cue when stdin is not a terminal, and CLAUDE_VOICE_SILENT is the no-audio test mode.
export function buildCue({ config, env = process.env, isTTY = false, relaunch = false }) {
  const text = relaunch ? config.strings.launchCueSwitch : config.strings.launchCue
  const audible = Boolean(isTTY) && env.CLAUDE_VOICE_SILENT !== '1'
  return { text, speak: audible && Boolean(text) && (relaunch || config.speakLaunchCue) }
}

function speakCue(cue, config) {
  if (!cue.speak) return
  const proc = spawn('/usr/bin/say', buildSayArgs(config, cue.text), { stdio: 'ignore' })
  // The cue is fire and forget, so a missing or failing say must not reach the launch.
  proc.on('error', () => {})
  proc.unref()
}

// fail(message) must not return.
export function buildLaunchPlan({
  argv,
  env: baseEnv = process.env,
  root = ROOT,
  sessionId = randomUUID(),
  isTTY = false,
  fail = failAndExit,
}) {
  const overrides = {}
  let profile = baseEnv.CLAUDE_VOICE_PROFILE || ''
  const claudeArgs = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') return { action: 'help' }
    if (a === '--check' || a === '--remove') return { action: a.slice(2), rest: argv.slice(i + 1) }
    const [flag, inlineValue] =
      a.includes('=') && a.startsWith('--') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined]
    if (!VOICE_FLAGS.has(flag)) {
      claudeArgs.push(a)
      continue
    }
    const value = inlineValue ?? argv[++i]
    if (value === undefined) fail(`${flag} needs a value`)
    if (flag === '--profile') {
      profile = value
      continue
    }
    if (flag === '--set') {
      const eq = value.indexOf('=')
      if (eq < 1) fail('--set needs KEY=VALUE')
      const key = value.slice(0, eq)
      const rawVal = value.slice(eq + 1)
      let parsed
      try {
        parsed = JSON.parse(rawVal)
      } catch {
        parsed = rawVal
      }
      overrides[key] = parsed
      continue
    }
    if (flag === '--input') {
      overrides.sessionInput = value
      continue
    }
    if (flag === '--output') {
      overrides.sessionOutput = value
      continue
    }
    overrides[flag.slice(2)] = value
  }

  const env = { ...baseEnv }
  if (profile) env.CLAUDE_VOICE_PROFILE = profile
  if (Object.keys(overrides).length) env.CLAUDE_VOICE_OVERRIDES = JSON.stringify(overrides)

  // Claude Code hides the server's stderr, so a config error has to fail here in the shell.
  const config = loadConfig({ root, env, fail })
  // Claude Code sets CLAUDE_CODE_CHILD_SESSION on every process it spawns, and a `claude` that inherits it turns transcript saving off.
  if (config.keepTranscript) delete env.CLAUDE_CODE_CHILD_SESSION

  // Claude Code passes its environment to the servers it spawns, which is how the server learns its session id.
  env.CLAUDE_VOICE_SESSION_ID = sessionId
  const { model, effort } = config
  return {
    action: 'launch',
    args: buildClaudeArgs({ sessionId, model, effort, claudeArgs }),
    env,
    config,
    sessionId,
    claudeArgs,
    cue: buildCue({ config, env: baseEnv, isTTY }),
  }
}

function failAndExit(msg) {
  console.error(`claude-code-handsfree: ${msg}`)
  process.exit(2)
}

async function main() {
  // The shell function runs bare `node`, which can be a different Node from the one setup checked.
  if (Number(process.versions.node.split('.')[0]) < MIN_NODE_MAJOR)
    failAndExit(
      `Node ${process.versions.node} is too old; ${MIN_NODE_MAJOR} or later is required. This terminal's \`node\` may differ from the one setup checked.`,
    )
  const argv = process.argv.slice(2)
  const plan = buildLaunchPlan({ argv, isTTY: process.stdin.isTTY })
  if (plan.action === 'help') {
    console.log(USAGE)
    process.exit(0)
  }
  if (plan.action === 'check' || plan.action === 'remove') {
    const script = plan.action === 'check' ? 'check.mjs' : 'remove.mjs'
    const r = spawnSync(process.execPath, [join(SRC, script), ...plan.rest], { stdio: 'inherit', env: process.env })
    process.exit(r.status ?? 1)
  }
  const { env, sessionId, claudeArgs, config } = plan
  let { args, cue } = plan
  const switchCue = buildCue({ config, isTTY: process.stdin.isTTY, relaunch: true })
  let model = config.model
  let effort = config.effort
  for (;;) {
    const child = spawn('claude', args, { stdio: 'inherit', env })
    // Only Enter dismisses the development-channels dialog, and it is up before claude reads anything else.
    speakCue(cue, config)
    const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c ?? 1)))
    if (!existsSync(NEXT_MODEL_FILE)) process.exit(code)
    let next = ''
    try {
      next = readFileSync(NEXT_MODEL_FILE, 'utf8').trim()
      unlinkSync(NEXT_MODEL_FILE)
    } catch {}
    if (!next) process.exit(code)
    const [nextModel, nextEffort] = next.split(/\s+/)
    model = nextModel
    if (nextEffort) effort = nextEffort
    args = buildClaudeArgs({ sessionId, model, effort, resume: true, claudeArgs })
    cue = switchCue
    console.error(
      `claude-code-handsfree: resuming the same conversation with model ${model}, effort ${effort || "Claude Code's default"}`,
    )
  }
}

// realpath because the npm bin entry is a symlink to this file.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
