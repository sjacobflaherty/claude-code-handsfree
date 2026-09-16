#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline'
import { dim, flag, green, help, onCrash, red, row, VERBOSE, value, yellow } from './cli.mjs'
import { APP_NAME, MIN_NODE_MAJOR, ROOT, SRC, setAllowedDevices } from './config.mjs'
import { HEAR_RELEASE, hearVersion, installHear } from './hear.mjs'
import { addRcBlock, findRcBlock, RC_BLOCK_BEGIN, RC_BLOCK_END, RC_BLOCK_KEY } from './rc-block.mjs'

help(`
Install ${APP_NAME}: hear, the helpers, your microphone, a voice, and the shell command.

Examples:
  npm run setup                  every section, asking before each step
  npm run setup -- --yes         every section with the defaults, no questions
  npm run setup -- --dry-run     show what would happen, write nothing
  npm run setup -- --only 4,6    only the microphone and the shell command sections

Flags:
  --yes, -y        take every default
  --dry-run        write nothing
  --force          redo sections that are already done
  --only N[,N]     run only these sections: 1 requirements, 2 hear, 3 install, 4 microphones, 5 voice, 6 shell command
  --name COMMAND   the shell command name (default claude-code-handsfree)
  --rc FILE        the rc file to write (default ~/.zshrc, or ~/.bashrc under bash)
  --verbose, -v    print the commands each section runs
  --help, -h       this text
`)
onCrash('npm run setup --')
const YES = flag('--yes', '-y')
const DRY = flag('--dry-run')
const FORCE = flag('--force')
const FUNCTION_NAME = value('--name', 'claude-code-handsfree')
const shellName = basename(process.env.SHELL || 'zsh')
const RC = value('--rc', join(homedir(), shellName === 'bash' ? '.bashrc' : '.zshrc')).replace(/^~/, homedir())
// The folder holding settings.jsonc and phrases.jsonc, which the tests point elsewhere.
const CONFIG_ROOT = process.env.CLAUDE_VOICE_ROOT || ROOT

// A fresh clone has no node_modules, and the questions below come from a package in it, so the install
// runs first, here, instead of the import failing with a stack trace before the first line prints.
if (!existsSync(join(ROOT, 'node_modules', 'prompts'))) {
  console.log('node_modules is missing, so npm install runs first.')
  if (flag('--dry-run')) {
    console.log('  dry-run  would run npm install')
    process.exit(0)
  }
  const install = spawnSync('npm', ['install'], { cwd: ROOT, stdio: 'inherit' })
  if (install.status !== 0) {
    console.log('\nnpm install failed. Fix that, then rerun: npm run setup\n')
    process.exit(1)
  }
}
const prompts = (await import('prompts')).default

const say = (s = '') => console.log(s)
const ok = (s) => row('ok', s, green)
const missing = (s) => row('miss', s, yellow)
const wrote = (s) => row(DRY ? 'dry' : 'wrote', s, dim)
const skipped = (s) => row('skip', s, dim)
// The commands a section runs, for a reader who wants to run them by hand; --verbose shows them.
function steps(lines) {
  if (!VERBOSE) return
  say(dim('  Commands:'))
  for (const l of lines) say(dim(`    ${l}`))
}
// Piped answers are queued because readline drops lines that arrive before their question when stdin is not a terminal.
const TTY = stdin.isTTY
const rl = TTY ? null : createInterface({ input: stdin })
const answers = []
const waiting = []
let stdinClosed = false
if (rl) {
  rl.on('line', (l) => {
    const w = waiting.shift()
    if (w) w(l)
    else answers.push(l)
  })
  rl.on('close', () => {
    stdinClosed = true
    while (waiting.length) waiting.shift()(null)
  })
}
function nextAnswer() {
  if (answers.length) return Promise.resolve(answers.shift())
  if (stdinClosed) return Promise.resolve(null)
  return new Promise((resolve) => waiting.push(resolve))
}
function cancelled() {
  say('\nCancelled. Nothing more was written.')
  process.exit(130)
}
async function prompt(q, fallback) {
  if (YES) return fallback
  say()
  if (TTY) {
    const { v } = await prompts({ ...q, name: 'v' }, { onCancel: cancelled })
    return v
  }
  return pipedPrompt(q, fallback)
}
async function pipedPrompt(q, fallback) {
  const list = q.choices || []
  if (q.type === 'select' || q.type === 'multiselect') {
    say(`  ${q.message}`)
    for (const [i, c] of list.entries())
      say(`    ${i + 1}. ${c.title}${c.selected && !/default/i.test(c.title) ? '  (default)' : ''}`)
  }
  const hint =
    q.type === 'confirm'
      ? ` (y/n) [${q.initial === false ? 'n' : 'y'}]`
      : q.type === 'multiselect'
        ? ' (numbers, space separated)'
        : q.type === 'select'
          ? ' (number)'
          : q.initial
            ? ` [${q.initial}]`
            : ''
  stdout.write(`  ${q.type === 'select' || q.type === 'multiselect' ? 'Answer' : q.message}${hint}: `)
  const a = await nextAnswer()
  say()
  if (a === null || !a.trim()) return fallback
  const t = a.trim()
  if (q.type === 'confirm') return /^y/i.test(t)
  if (q.type === 'select') return list[Number(t) - 1]?.value ?? fallback
  if (q.type === 'multiselect') {
    const picked = t
      .split(/[\s,]+/)
      .map((n) => list[Number(n) - 1])
      .filter(Boolean)
      .map((c) => c.value)
    return picked.length ? picked : fallback
  }
  return t
}
const confirm = (message, initial = true) => prompt({ type: 'confirm', message, initial }, initial)
function run(cmd, cmdArgs, opts = {}) {
  return spawnSync(cmd, cmdArgs, { encoding: 'utf8', ...opts })
}
function stop(msg) {
  say(`\n${msg}\n`)
  process.exit(1)
}
const SECTIONS = [
  {
    label: 'Check requirements',
    steps: [
      'node --version',
      `(need ${MIN_NODE_MAJOR} or later: nodejs.org, or brew install node)`,
      'xcode-select -p',
      '(missing: xcode-select --install)',
    ],
    async run(chosen) {
      if (chosen) steps(this.steps)
      const nodeMajor = Number(process.versions.node.split('.')[0])
      if (nodeMajor < MIN_NODE_MAJOR)
        stop(
          `Node ${process.versions.node} is too old. Install Node ${MIN_NODE_MAJOR} or later from nodejs.org or with Homebrew, then rerun.`,
        )
      ok(`Node ${process.versions.node}`)
      const xcode = run('xcode-select', ['-p'])
      if (xcode.status !== 0)
        stop('Xcode command line tools are missing. Run: xcode-select --install, accept the dialog, then rerun.')
      ok('Xcode command line tools')
    },
  },
  {
    label: 'Install hear, the speech recognizer',
    steps: [
      `curl -fsSL -o bin/hear.zip ${HEAR_RELEASE.url}`,
      'unzip -o -q -j bin/hear.zip "*/hear" "*/hear.1" -d bin',
      `codesign --verify --strict bin/hear   (must be Developer ID team ${HEAR_RELEASE.team})`,
      'bin/hear -v',
    ],
    async run(chosen) {
      const local = join(CONFIG_ROOT, 'bin', 'hear')
      if (existsSync(local) && !FORCE) {
        if (chosen) steps(this.steps)
        ok(`bin/hear: ${hearVersion(local) || 'present'}`)
        return
      }
      const onPath = hearVersion('hear')
      if (onPath && !FORCE) {
        if (chosen) steps(this.steps)
        ok(`${onPath} on PATH; a session uses it. Rerun with --force to place the signed build in bin/ instead.`)
        return
      }
      steps(this.steps)
      say(
        "  Downloads the author's signed build (about 200 KB) into bin/ after checking its signature. No Homebrew, no sudo.",
      )
      if (!(await confirm('Run this now?'))) {
        skipped('hear')
        return
      }
      if (DRY) {
        wrote('would download, verify, and place bin/hear')
        return
      }
      const result = installHear(CONFIG_ROOT)
      if (!result.ok) stop(`hear was not installed: ${result.message}`)
      ok(`bin/hear: ${result.message}`)
    },
  },
  {
    label: `Install ${APP_NAME}`,
    steps: ['npm install', 'npm run build'],
    async run(chosen) {
      const haveModules = existsSync(join(ROOT, 'node_modules'))
      const haveHelper = existsSync(join(ROOT, 'bin', 'audiodev')) && existsSync(join(ROOT, 'bin', 'disclaim'))
      if (haveModules && haveHelper && !FORCE) {
        if (chosen) steps(this.steps)
        ok('dependencies installed')
        ok('helpers built')
        return
      }
      steps(this.steps)
      if (!(await confirm('Run this now?'))) {
        skipped(APP_NAME)
        return
      }
      if (!haveModules || FORCE) {
        if (DRY) wrote('would run npm install')
        else if (run('npm', ['install'], { cwd: ROOT, stdio: 'inherit' }).status !== 0) stop('npm install failed.')
        else ok('dependencies installed')
      } else ok('dependencies installed')
      if (!haveHelper || FORCE) {
        if (DRY) wrote('would run npm run build')
        else if (run('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' }).status !== 0)
          stop('npm run build failed. It needs swiftc and clang from the Xcode command line tools.')
        else ok('helpers built')
      } else ok('helpers built')
    },
  },
  {
    label: `Detect microphones and add to ${APP_NAME}`,
    steps: ['./bin/audiodev', 'settings.jsonc: "allowedInputs": ["<device name>"], "allowedOutputs": "same"'],
    async run() {
      steps(this.steps)
      say('  The first session asks for Microphone, then Speech Recognition, each dialog named hear: allow both.')
      if (!(await confirm('Run this now?'))) {
        skipped('microphones')
        return
      }
      const audiodev = join(ROOT, 'bin', 'audiodev')
      if (!existsSync(audiodev)) {
        missing('bin/audiodev; run npm run build, then rerun setup')
        return
      }
      const out = run(audiodev, []).stdout || ''
      const lines = out.split('\n')
      const defIn = (lines.find((l) => l.startsWith('in=')) || '').slice(3)
      const devices = lines
        .filter((l) => l.startsWith('dev='))
        .map((l) => {
          const [id, uid, dir, ...n] = l.slice(4).split('\t')
          return { id, uid, dir, name: n.join('\t') }
        })
      const inputs = devices.filter((d) => d.dir !== 'out')
      if (!inputs.length) {
        missing('no microphone found; connect one and rerun setup')
        return
      }
      say(
        '  Only the devices picked here can drive a session. Use a headset; speakers let the microphone hear the replies.',
      )
      const defaultInput =
        inputs.find((d) => /headset|headphones|earbuds/i.test(d.name))?.name || defIn || inputs[0].name
      const chosenInputs = await prompt(
        {
          type: 'multiselect',
          message: 'Preselect microphone inputs (you may change this after the install)',
          instructions: '\n  Space selects. Enter submits.',
          min: 1,
          choices: inputs.map((d) => ({
            title: `${d.name}${d.name === defIn ? '  (default)' : ''}`,
            value: d.name,
            selected: d.name === defaultInput,
          })),
        },
        [defaultInput],
      )
      const canBeSame = chosenInputs.every((n) => devices.find((d) => d.name === n)?.dir === 'both')
      // --yes keeps the shipped "same": a list of the default output at this moment would be wrong the next time it changes.
      const same =
        YES || (canBeSame && (await confirm('Output must be the same device as the microphone (a headset)?', true)))
      let chosenOutputs = null
      if (!same) {
        const defOut = (lines.find((l) => l.startsWith('out=')) || '').slice(4)
        const outputs = devices.filter((d) => d.dir !== 'in')
        if (!canBeSame) say('  That microphone has no speaker, so pick the output separately.')
        const defaultOutput = outputs.find((d) => d.name === defOut)?.name || outputs[0]?.name
        chosenOutputs = await prompt(
          {
            type: 'multiselect',
            message: 'Preselect speaker outputs (you may change this after the install)',
            instructions: '\n  Space selects. Enter submits.',
            min: 1,
            choices: outputs.map((d) => ({
              title: `${d.name}${d.name === defOut ? '  (default)' : ''}`,
              value: d.name,
              selected: d.name === defaultOutput,
            })),
          },
          [defaultOutput].filter(Boolean),
        )
      }
      const configPath = join(CONFIG_ROOT, 'settings.jsonc')
      const summary = `allowedInputs ${JSON.stringify(chosenInputs)}, allowedOutputs ${chosenOutputs ? JSON.stringify(chosenOutputs) : '"same"'}`
      if (DRY) {
        wrote(`would set ${summary}`)
        return
      }
      if (!existsSync(configPath) && !existsSync(join(CONFIG_ROOT, 'settings.json')))
        copyFileSync(join(CONFIG_ROOT, 'settings.example.jsonc'), configPath)
      const { text, changed } = setAllowedDevices(readFileSync(configPath, 'utf8'), {
        inputs: chosenInputs,
        outputs: chosenOutputs,
      })
      if (changed) {
        writeFileSync(configPath, text)
        wrote(`settings.jsonc: ${summary}`)
      } else
        missing(`"allowedInputs" in settings.jsonc. Add it yourself: "allowedInputs": ${JSON.stringify(chosenInputs)}`)
    },
  },
  {
    label: 'Pick a voice',
    steps: [
      "say -v '?'",
      'phrases.jsonc: "overrides": { "<locale>": { "voice": "<name>" } }',
      '(better voices: System Settings > Accessibility > Spoken Content > System Voice > Manage Voices)',
    ],
    async run() {
      steps(this.steps)
      const phrasesPath = join(CONFIG_ROOT, 'phrases.jsonc')
      const sayList = run('/usr/bin/say', ['-v', '?']).stdout || ''
      const voices = sayList
        .split('\n')
        .map((l) => /^(.+?)\s{2,}([a-z]{2,3})[_-]/.exec(l))
        .filter(Boolean)
        .map((m) => ({ name: m[1].trim(), lang: m[2] }))
      let locale = 'en'
      for (const p of [phrasesPath, join(CONFIG_ROOT, 'phrases.example.jsonc')]) {
        try {
          locale = (/"locale"\s*:\s*"([a-z]{2})/.exec(readFileSync(p, 'utf8')) || [])[1] || locale
          break
        } catch {}
      }
      const forLocale = voices.filter((v) => v.lang === locale)
      say(`  ${forLocale.length} installed voice(s) for "${locale}".`)
      say('  System default keeps the Spoken Content system voice, the only way to get a Siri voice.')
      if (locale !== 'en')
        say(
          `  The system voice is usually English, so pick a "${locale}" voice or replies will play in the wrong language.`,
        )
      // `prompts` falls back to the title for an empty value, so the system default carries a sentinel.
      const SYSTEM = '<system default>'
      const picked = await prompt(
        {
          type: 'autocomplete',
          message: 'Voice',
          hint: 'type to filter, Enter picks',
          choices: [
            { title: 'System default', value: SYSTEM },
            ...forLocale.map((v) => ({ title: v.name, value: v.name })),
          ],
          initial: 0,
        },
        SYSTEM,
      )
      const voicePick = picked === SYSTEM ? '' : String(picked ?? '').trim()
      if (!voicePick) {
        ok('system voice')
        return
      }
      // One stray Tab, arrow, or letter moves the autocomplete onto a real voice, so the pick is
      // only written after a yes, and only when say lists it.
      if (!voices.some((v) => v.name === voicePick)) {
        missing(`"${voicePick}" is not a voice say -v '?' lists; keeping the system voice`)
        return
      }
      if (!(await confirm(`Speak replies in "${voicePick}" instead of the system voice?`, false))) {
        ok('system voice')
        return
      }
      if (DRY) {
        wrote(`would set overrides.${locale}.voice "${voicePick}"`)
        return
      }
      if (!existsSync(phrasesPath)) {
        missing(
          `phrases.jsonc. Run: cp phrases.example.jsonc phrases.jsonc, then set overrides.${locale}.voice to ${JSON.stringify(voicePick)}`,
        )
        return
      }
      // The newline and the indent before the key are what keep a commented-out example line from being rewritten.
      const blockRe = new RegExp(`("${locale}"\\s*:\\s*\\{[^}]*?[\\n{][ \\t]*"voice"\\s*:\\s*)"[^"]*"`)
      const before = readFileSync(phrasesPath, 'utf8')
      const after = before.replace(blockRe, `$1${JSON.stringify(voicePick)}`)
      if (after === before)
        missing(
          `no live "voice" line under overrides.${locale} in phrases.jsonc; uncomment it and set it to ${JSON.stringify(voicePick)} yourself`,
        )
      else {
        writeFileSync(phrasesPath, after)
        wrote(`phrases.jsonc: overrides.${locale}.voice "${voicePick}"`)
      }
    },
  },
  {
    label: `Add ${FUNCTION_NAME} command to shell`,
    get steps() {
      return [`append to ${RC}:`, RC_BLOCK_BEGIN, ...fnBody().split('\n'), RC_BLOCK_END]
    },
    async run(chosen) {
      let rcText = ''
      // The write replaces the whole file, so a read that failed for anything but ENOENT must stop here.
      try {
        rcText = readFileSync(RC, 'utf8')
      } catch (e) {
        if (e.code !== 'ENOENT')
          stop(`Cannot read ${RC} (${e.code}). Fix that, then rerun; nothing else is left to do.`)
      }
      const rcBlock = findRcBlock(rcText)
      const body = fnBody()
      if (rcBlock?.body === body && !FORCE) {
        if (chosen) steps(this.steps)
        ok(`${RC} has the ${RC_BLOCK_KEY} block`)
        return
      }
      steps(this.steps)
      if (rcBlock) say(`  ${RC} already has a ${RC_BLOCK_KEY} block; this replaces it.`)
      if (!(await confirm('Run this now?'))) {
        skipped('shell command')
        return
      }
      if (DRY) {
        wrote(`would write the ${RC_BLOCK_KEY} block to ${RC}`)
        return
      }
      writeFileSync(RC, addRcBlock(rcText, body))
      wrote(`${RC_BLOCK_KEY} block in ${RC}`)
    },
  },
]

// The node that ran setup, by absolute path, so the function works in a shell whose PATH has no node.
const NODE = process.execPath
function fnBody() {
  const fn =
    shellName === 'fish'
      ? `function ${FUNCTION_NAME}\n  ${JSON.stringify(NODE)} ${JSON.stringify(join(SRC, 'launch.mjs'))} $argv\nend`
      : `${FUNCTION_NAME}() {\n  ${JSON.stringify(NODE)} ${JSON.stringify(join(SRC, 'launch.mjs'))} "$@"\n}`
  return `# ${join(ROOT, 'CLAUDE.md')}\n${fn}`
}

say(
  `${APP_NAME} setup${DRY ? ' (dry run, nothing is written)' : ''}${FORCE ? ' (force: every section runs again)' : ''}`,
)
const only = value('--only', '')
let selected = SECTIONS.map(() => true)
if (only) {
  const picks = only.split(',').map((n) => Number(n.trim()))
  if (!picks.length || picks.some((n) => !Number.isInteger(n) || n < 1 || n > SECTIONS.length))
    stop(`--only takes section numbers 1 to ${SECTIONS.length}, comma separated. See: npm run setup -- --help`)
  selected = SECTIONS.map((_, i) => picks.includes(i + 1))
}

for (const [i, s] of SECTIONS.entries()) {
  if (!selected[i]) continue
  say(`\n== ${i + 1}/${SECTIONS.length} ${s.label}`)
  await s.run(true)
}

say('\n== Check')
rl?.close()
const check = run(process.execPath, [join(SRC, 'check.mjs'), ...(VERBOSE ? ['--verbose'] : [])], {
  stdio: 'inherit',
  env: process.env,
})
const done = check.status === 0
say(
  done
    ? green(`\nDone. Next: open a new terminal (or source ${RC}), put the headset on, and run: ${FUNCTION_NAME}`)
    : red('\nNot done. Fix the FAIL lines above, then run: npm run check'),
)
say(dim(`Phrases and voice: cp phrases.example.jsonc phrases.jsonc. Uninstall: ${FUNCTION_NAME} --remove`))
process.exit(check.status || 0)
