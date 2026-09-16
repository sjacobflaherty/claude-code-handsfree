import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseJsonc, ROOT, SRC } from '../src/config.mjs'
import { HEAR_RELEASE } from '../src/hear.mjs'
import { cleanupRoots, makeRoot } from './fixture-root.mjs'

const SETUP = join(SRC, 'setup.mjs')

function installedEnglishVoices() {
  const out = spawnSync('/usr/bin/say', ['-v', '?'], { encoding: 'utf8' }).stdout || ''
  return out
    .split('\n')
    .map((l) => /^(.+?)\s{2,}([a-z]{2,3})[_-]/.exec(l))
    .filter((m) => m && m[2] === 'en')
    .map((m) => m[1].trim())
}

const LIVE_VOICE = { locale: 'en', commandPrefix: '', overrides: { en: { voice: '' } } }

function runVoiceSection(answers, phrases = LIVE_VOICE) {
  const root = makeRoot({ settings: { allowedInputs: ['Wireless Headset'] }, phrases })
  const run = spawnSync(process.execPath, [SETUP, '--only', '5', '--rc', join(root, '.zshrc')], {
    input: `${answers.join('\n')}\n`,
    encoding: 'utf8',
    // A short PATH keeps the closing check from reaching the real hear and claude.
    env: { ...process.env, CLAUDE_VOICE_ROOT: root, PATH: '/usr/bin:/bin' },
  })
  const text = readFileSync(join(root, 'phrases.jsonc'), 'utf8')
  return { stdout: run.stdout || '', text, voice: parseJsonc(text).overrides.en.voice }
}

afterAll(cleanupRoots)

describe('the setup voice picker', () => {
  it('leaves the voice empty when no name is given, so replies use the system voice', () => {
    const run = runVoiceSection([''])
    // --only 5 is the voice section; this fails loudly if the section order changes.
    expect(run.stdout).toContain('5/6 Pick a voice')
    expect(run.voice).toBe('')
  })

  it('writes the voice only after an explicit yes', () => {
    const name = installedEnglishVoices()[0]
    expect(name).toBeTruthy()
    expect(runVoiceSection([name, 'y']).voice).toBe(name)
  })

  it('writes nothing when the pick is not confirmed', () => {
    const name = installedEnglishVoices()[0]
    expect(runVoiceSection([name, 'n']).voice).toBe('')
    expect(runVoiceSection([name]).voice).toBe('')
  })

  it('writes nothing when the answer names no installed voice', () => {
    const run = runVoiceSection(['Wobbel', 'y'])
    expect(run.voice).toBe('')
    expect(run.stdout).toContain('Wobbel')
  })

  it('leaves a commented-out voice line alone and says which line to uncomment', () => {
    const commented = [
      '{',
      '  "locale": "en",',
      '  "overrides": {',
      '    "en": {',
      '      // "voice": "",',
      '    },',
      '  },',
      '}',
    ].join('\n')
    const run = runVoiceSection([installedEnglishVoices()[0], 'y'], commented)
    expect(run.text).toContain('// "voice": "",')
    expect(run.voice).toBe(undefined)
    expect(run.stdout).toContain('no live "voice" line')
  })
})

describe('the setup hear section', () => {
  // A release zip shaped like the author's: one folder holding hear and hear.1.
  function makeZip(dir, hearBody) {
    const folder = join(dir, 'hear-9.9')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'hear'), hearBody, { mode: 0o755 })
    writeFileSync(join(folder, 'hear.1'), '.TH hear 1\n')
    spawnSync('zip', ['-q', '-r', 'hear.zip', 'hear-9.9'], { cwd: dir })
    return `file://${join(dir, 'hear.zip')}`
  }
  // codesign is what says who signed the binary; a stand-in on PATH is the only way to make an unsigned test file pass.
  function stubCodesign(dir, team) {
    const bin = join(dir, 'stub-bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'codesign'), `#!/bin/sh\necho "TeamIdentifier=${team}" >&2\nexit 0\n`, { mode: 0o755 })
    return bin
  }
  function runHearSection(root, env, answers = ['y']) {
    const run = spawnSync(process.execPath, [SETUP, '--only', '2', '--rc', join(root, '.zshrc')], {
      input: `${answers.join('\n')}\n`,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_VOICE_ROOT: root, PATH: '/usr/bin:/bin', ...env },
    })
    return { stdout: run.stdout || '', stderr: run.stderr || '', status: run.status, bin: join(root, 'bin') }
  }

  it('downloads the release, keeps hear in bin/ when the signature is by the pinned team, and reports its version', () => {
    const root = makeRoot()
    const url = makeZip(root, '#!/bin/sh\necho "hear version 9.9 stand-in"\n')
    const r = runHearSection(root, {
      CLAUDE_VOICE_HEAR_URL: url,
      PATH: `${stubCodesign(root, HEAR_RELEASE.team)}:/usr/bin:/bin`,
    })
    expect(r.stdout).toContain('2/6 Install hear')
    expect(existsSync(join(r.bin, 'hear'))).toBe(true)
    expect(existsSync(join(r.bin, 'hear.1'))).toBe(true)
    expect(existsSync(join(r.bin, 'hear.zip'))).toBe(false)
    expect(r.stdout).toContain('bin/hear: hear version 9.9 stand-in')
  })

  it('refuses a hear that is not signed by the pinned team, deletes it, and names the URL', () => {
    const root = makeRoot()
    const url = makeZip(root, '#!/bin/sh\necho unsigned\n')
    const r = runHearSection(root, { CLAUDE_VOICE_HEAR_URL: url })
    expect(r.status).toBe(1)
    expect(r.stdout + r.stderr).toContain('hear was not installed')
    expect(r.stderr).toContain('not validly signed')
    expect(r.stderr).toContain(url)
    expect(existsSync(join(r.bin, 'hear'))).toBe(false)
    expect(existsSync(join(r.bin, 'hear.zip'))).toBe(false)
  })

  it('leaves a hear already on PATH alone and says a session uses it', () => {
    const root = makeRoot()
    const bin = join(root, 'stub-bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'hear'), '#!/bin/sh\necho "hear version 0.8 on path"\n', { mode: 0o755 })
    const r = runHearSection(root, { CLAUDE_VOICE_HEAR_URL: 'file:///nowhere/hear.zip', PATH: `${bin}:/usr/bin:/bin` })
    expect(r.stdout).toContain('hear version 0.8 on path on PATH; a session uses it')
    expect(existsSync(join(r.bin, 'hear'))).toBe(false)
  })
})

describe('setup as a whole', () => {
  function runSetup(root, args, env = {}) {
    const run = spawnSync(process.execPath, [SETUP, '--rc', join(root, '.zshrc'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_VOICE_ROOT: root, PATH: '/usr/bin:/bin', ...env },
    })
    return { stdout: run.stdout || '', status: run.status }
  }

  it('previews all six sections under --dry-run with hear absent, writing nothing', () => {
    const root = makeRoot()
    const r = runSetup(root, ['--yes', '--dry-run'])
    for (const n of [1, 2, 3, 4, 5, 6]) expect(r.stdout).toContain(`== ${n}/6 `)
    expect(r.stdout).toContain('would download, verify, and place bin/hear')
    expect(existsSync(join(root, 'bin', 'hear'))).toBe(false)
    expect(existsSync(join(root, '.zshrc'))).toBe(false)
  })

  it('--yes keeps "same" for the outputs, never runs hear, and writes the function with the absolute node', () => {
    // The two live device lines of the shipped example, which setup rewrites.
    const root = makeRoot({ settings: { allowedInputs: [], allowedOutputs: 'same' } })
    // A hear on PATH so section 2 keeps it instead of downloading. Any call other than -v leaves a marker: setup
    // must never open the microphone.
    const bin = join(root, 'stub-bin')
    mkdirSync(bin, { recursive: true })
    const marker = join(root, 'hear-ran')
    writeFileSync(
      join(bin, 'hear'),
      `#!/bin/sh\nif [ "$1" = "-v" ]; then echo "hear version 0.8 stand-in"; else touch ${JSON.stringify(marker)}; fi\nexit 0\n`,
      {
        mode: 0o755,
      },
    )
    const r = runSetup(root, ['--yes'], { PATH: `${bin}:/usr/bin:/bin` })
    const settings = parseJsonc(readFileSync(join(root, 'settings.jsonc'), 'utf8'))
    expect(settings.allowedInputs.length).toBeGreaterThan(0)
    expect(settings.allowedOutputs).toBe('same')
    expect(existsSync(marker)).toBe(false)
    expect(r.stdout).not.toContain('WARN')
    expect(r.stdout).not.toContain('Done. Next')
    // The closing check fails here too (no claude on this PATH), so only a non-zero exit is asserted.
    expect(r.status).toBeGreaterThan(0)
    expect(r.stdout).toContain('Not done')
    const rc = readFileSync(join(root, '.zshrc'), 'utf8')
    expect(rc).toContain(`${JSON.stringify(process.execPath)} ${JSON.stringify(join(SRC, 'launch.mjs'))} "$@"`)
  })

  it('creates the default Fish config directory before writing its shell function', () => {
    const root = makeRoot()
    spawnSync(process.execPath, [SETUP, '--only', '6', '--yes'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_VOICE_ROOT: root,
        HOME: root,
        PATH: '/usr/bin:/bin',
        SHELL: '/opt/homebrew/bin/fish',
      },
    })
    const fishConfig = join(root, '.config', 'fish', 'config.fish')
    expect(readFileSync(fishConfig, 'utf8')).toContain('function claude-code-handsfree')
  })

  it('updates settings.json when it exists without creating settings.jsonc', () => {
    const copy = join(makeRoot(), 'clone')
    mkdirSync(copy, { recursive: true })
    for (const f of ['src', 'locales', 'plugin', 'package.json', 'package-lock.json', 'settings.example.jsonc'])
      spawnSync('cp', ['-R', join(ROOT, f), join(copy, f)])
    symlinkSync(join(ROOT, 'node_modules'), join(copy, 'node_modules'), 'dir')
    mkdirSync(join(copy, 'bin'))
    writeFileSync(
      join(copy, 'bin', 'audiodev'),
      '#!/bin/sh\nprintf "in=USB Headset\\nout=USB Headset\\ndev=1\\tUID1\\tboth\\tUSB Headset\\n"\n',
      { mode: 0o755 },
    )
    writeFileSync(join(copy, 'settings.json'), JSON.stringify({ allowedInputs: [], allowedOutputs: 'same' }))
    writeFileSync(join(copy, 'phrases.jsonc'), JSON.stringify(LIVE_VOICE))
    spawnSync(
      process.execPath,
      [join(copy, 'src', 'setup.mjs'), '--only', '4', '--yes', '--rc', join(copy, '.zshrc')],
      {
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_VOICE_ROOT: copy, PATH: '/usr/bin:/bin' },
      },
    )
    expect(JSON.parse(readFileSync(join(copy, 'settings.json'), 'utf8')).allowedInputs).toEqual(['USB Headset'])
    expect(existsSync(join(copy, 'settings.jsonc'))).toBe(false)
  })

  it('runs npm install first on a copy of the tree that has no node_modules, instead of failing on an import', () => {
    const copy = join(makeRoot(), 'clone')
    mkdirSync(copy, { recursive: true })
    for (const f of [
      'src',
      'locales',
      'plugin',
      'package.json',
      'package-lock.json',
      'settings.example.jsonc',
      'phrases.example.jsonc',
    ])
      spawnSync('cp', ['-R', join(ROOT, f), join(copy, f)])
    const run = spawnSync(process.execPath, [join(copy, 'src', 'setup.mjs'), '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_VOICE_ROOT: copy, PATH: '/usr/bin:/bin' },
    })
    expect(run.stdout).toContain('node_modules is missing, so npm install runs first.')
    expect(run.stdout).toContain('would run npm install')
    expect(run.stderr || '').not.toContain('ERR_MODULE_NOT_FOUND')
    expect(run.status).toBe(0)
  })
})
