import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanupRoots, makeRoot } from './fixture-root.mjs'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const CHECK = join(REPO, 'src', 'check.mjs')
const dirs = []

function runCheck({ voice = '', activeFlag = null, extraPath = '' } = {}) {
  const root = makeRoot({
    settings: { allowedInputs: ['Wireless Headset'] },
    phrases: { locale: 'en', overrides: { en: { voice } } },
  })
  if (activeFlag) {
    mkdirSync(join(root, 'state'), { recursive: true })
    writeFileSync(join(root, 'state', 'active.json'), JSON.stringify(activeFlag))
  }
  const run = spawnSync(process.execPath, [CHECK], {
    encoding: 'utf8',
    // A short PATH keeps the check from reaching the real hear and claude.
    env: { ...process.env, CLAUDE_VOICE_ROOT: root, PATH: `${extraPath ? `${extraPath}:` : ''}/usr/bin:/bin` },
  })
  return run.stdout || ''
}

// A stand-in claude whose auth status answer is given, since --version alone says nothing about a login.
function stubClaude(loggedIn) {
  const dir = mkdtempSync(join(tmpdir(), 'voice-claude-stub-'))
  dirs.push(dir)
  const status = JSON.stringify(loggedIn ? { loggedIn: true, email: 'someone@example.com' } : { loggedIn: false })
  writeFileSync(
    join(dir, 'claude'),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi\nif [ "$1" = "auth" ]; then echo '${status}'; exit 0; fi\nexit 1\n`,
    { mode: 0o755 },
  )
  return dir
}

const flagFor = (pid) => ({ ts: 0, pid, cwd: REPO, sessionId: 'a-session' })

function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid
}

// A process whose command names the server, started by this test run rather than by claude.
function withServerProcess(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'voice-orphan-'))
  dirs.push(dir)
  const script = join(dir, 'voice-channel.mjs')
  writeFileSync(script, 'setTimeout(() => {}, 20000)\n')
  const child = spawn(process.execPath, [script], { stdio: 'ignore' })
  try {
    return fn(child.pid)
  } finally {
    child.kill('SIGKILL')
  }
}

afterAll(() => {
  cleanupRoots()
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true })
})

describe('npm run check reports the voice a session would speak with', () => {
  it('names the system voice and where to change it when voice is empty', () => {
    const out = runCheck()
    expect(out).toContain('a session would speak in the system voice')
    expect(out).toContain('Spoken Content')
  })

  it('names a configured voice that say lists', () => {
    expect(runCheck({ voice: 'Whisper' })).toContain('a session would speak in "Whisper"')
  })

  it('fails on a configured voice say does not list, because say would fall back', () => {
    const out = runCheck({ voice: 'Wobbel' })
    expect(out).toContain('FAIL')
    expect(out).toContain('falls back to a built-in voice')
  })
})

describe('npm run check reports the running session', () => {
  it('says nothing is listening when there is no flag', () => {
    expect(runCheck()).toContain('no voice session is listening')
  })

  it('names the listening server and its pid', () => {
    const out = runCheck({ activeFlag: flagFor(process.pid) })
    expect(out).toContain(`server pid ${process.pid}`)
    expect(out).toContain('listening')
  })

  it('calls a flag stale when the server it names is gone', () => {
    const out = runCheck({ activeFlag: flagFor(deadPid()) })
    expect(out).toContain('stale')
    expect(out).not.toContain('no voice session is listening')
  })

  it('lists a server whose parent is not claude, with the kill to run', () => {
    withServerProcess((pid) => {
      const out = runCheck()
      expect(out).toContain(`kill ${pid}`)
      expect(out).toContain('FAIL')
    })
  })
})

describe('the claude row', () => {
  it('passes only when claude is signed in, and names the login command otherwise', () => {
    expect(runCheck({ extraPath: stubClaude(true) })).toContain(
      'claude 9.9.9 (Claude Code), signed in as someone@example.com',
    )
    const out = runCheck({ extraPath: stubClaude(false) })
    expect(out).toContain('FAIL  claude 9.9.9 (Claude Code) is not signed in; run claude, then /login')
  })
})
