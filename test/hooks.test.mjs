import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const STOP_SPEECH = join(REPO, 'plugin', 'hooks', 'stop-speech.py')
const SPEAK_REPLY = join(REPO, 'plugin', 'hooks', 'speak-reply.py')
const SESSION_ID = 'a1b2c3d4-0000-0000-0000-000000000000'
const dirs = []

afterAll(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true })
})

function deadPid() {
  const done = spawnSync(process.execPath, ['-e', ''])
  return done.pid
}

function runHook(script, { flag, payload }) {
  const root = mkdtempSync(join(tmpdir(), 'voice-hook-'))
  dirs.push(root)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  mkdirSync(join(root, 'state'))
  if (flag) writeFileSync(join(root, 'state', 'active.json'), JSON.stringify(flag))
  const records = {}
  for (const name of ['say', 'pkill']) {
    const record = join(root, `${name}.txt`)
    records[name] = record
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${record}'\n`)
    chmodSync(join(bin, name), 0o755)
  }
  const result = spawnSync('python3', [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CLAUDE_VOICE_ROOT: root,
      CLAUDE_VOICE_SAY: join(bin, 'say'),
    },
  })
  const calls = (name) => {
    try {
      return readFileSync(records[name], 'utf8').trim().split('\n')
    } catch {
      return []
    }
  }
  return { stderr: result.stderr, say: calls('say'), pkill: calls('pkill') }
}

const flagFor = ({ ts = 0, pid = process.pid, sessionId = SESSION_ID, cwd = REPO } = {}) => ({
  ts,
  pid,
  cwd,
  sessionId,
})

describe('stop-speech.py, the UserPromptSubmit hook', () => {
  const submit = (flag, payload) =>
    runHook(STOP_SPEECH, {
      flag,
      payload: { session_id: SESSION_ID, cwd: REPO, prompt: 'what is left to do', ...payload },
    })

  it('kills say for a typed prompt in the session the flag names', () => {
    const run = submit(flagFor())
    expect(run.pkill).toEqual(['-x say'])
  })

  it('does nothing when the flag names another session', () => {
    const run = submit(flagFor({ sessionId: 'another-session' }))
    expect(run.pkill).toEqual([])
  })

  it('does nothing when the flag is stale, its server gone', () => {
    const run = submit(flagFor({ pid: deadPid() }))
    expect(run.pkill).toEqual([])
  })

  it('falls back to the cwd when the flag carries no session id', () => {
    expect(submit(flagFor({ sessionId: '' })).pkill).toEqual(['-x say'])
    expect(submit(flagFor({ sessionId: '', cwd: '/somewhere/else' })).pkill).toEqual([])
  })

  it('does nothing for a spoken message, which arrives as a prompt starting with the channel tag', () => {
    const run = submit(flagFor(), { prompt: '<channel source="voice" mode="voice">the queue blocks on take</channel>' })
    expect(run.pkill).toEqual([])
  })
})

describe('speak-reply.py, the Stop hook', () => {
  const stop = (flag, payload) =>
    runHook(SPEAK_REPLY, {
      flag,
      payload: {
        session_id: SESSION_ID,
        cwd: REPO,
        last_assistant_message: 'The **queue** blocks on `take`.',
        ...payload,
      },
    })

  it('reads a text reply aloud when the channel has not spoken it', () => {
    const run = stop(flagFor({ ts: 0 }))
    expect(run.say.length).toBe(1)
    expect(run.say[0]).toContain('The queue blocks on take.')
  })

  it('names no voice, so say uses the system voice', () => {
    const run = stop(flagFor({ ts: 0 }))
    expect(run.say[0]).toBe('-r 190 -- The queue blocks on take.')
  })

  it('says nothing when the channel spoke within the grace window', () => {
    const run = stop(flagFor({ ts: Date.now() }))
    expect(run.say).toEqual([])
  })

  it('says nothing when the flag names another session', () => {
    const run = stop(flagFor({ sessionId: 'another-session' }))
    expect(run.say).toEqual([])
  })

  it('says nothing when the flag is stale, its server gone', () => {
    const run = stop(flagFor({ pid: deadPid() }))
    expect(run.say).toEqual([])
  })

  it('falls back to the cwd when the flag carries no session id', () => {
    expect(stop(flagFor({ sessionId: '' })).say.length).toBe(1)
    expect(stop(flagFor({ sessionId: '', cwd: '/somewhere/else' })).say).toEqual([])
  })

  it('says nothing when there is no flag at all', () => {
    const run = stop(null)
    expect(run.say).toEqual([])
  })
})
