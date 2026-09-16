import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { addRcBlock } from '../src/rc-block.mjs'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const dirs = []
const RC_BEFORE = addRcBlock(
  "export PATH=/usr/local/bin:$PATH\nalias ll='ls -la'\n",
  'claude-voice() {\n  node "/repo/src/launch.mjs" "$@"\n}',
)

function runRemove(args, { activeFlag = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'voice-remove-'))
  dirs.push(dir)
  const rc = join(dir, '.zshrc')
  writeFileSync(rc, RC_BEFORE)
  mkdirSync(join(dir, 'claude'))
  const root = join(dir, 'voice')
  mkdirSync(join(root, 'state'), { recursive: true })
  if (activeFlag) writeFileSync(join(root, 'state', 'active.json'), JSON.stringify(activeFlag))
  const r = spawnSync(process.execPath, [join(REPO, 'src', 'remove.mjs'), '--yes', '--rc', rc, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: join(dir, 'claude'), CLAUDE_VOICE_ROOT: root },
  })
  return {
    rc,
    dir,
    status: r.status,
    stdout: r.stdout,
    backups: readdirSync(dir).filter((f) => f.startsWith('.zshrc.bak-')),
  }
}

afterAll(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true })
})

describe('node src/remove.mjs --rc <file>', () => {
  it('deletes the block, keeps the rest of the rc file, and leaves a backup', () => {
    const { rc, stdout, backups } = runRemove([])
    expect(readFileSync(rc, 'utf8')).toBe("export PATH=/usr/local/bin:$PATH\nalias ll='ls -la'\n")
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(dirname(rc), backups[0]), 'utf8')).toBe(RC_BEFORE)
    expect(stdout).toContain('claude-code-handsfree')
  })

  it('writes nothing under --dry-run', () => {
    const { rc, stdout, backups } = runRemove(['--dry-run'])
    expect(readFileSync(rc, 'utf8')).toBe(RC_BEFORE)
    expect(backups).toHaveLength(0)
    expect(stdout).toContain('dry-run: would write')
  })

  it('reports a listening session by pid and leaves it alone', () => {
    const flag = { ts: 0, pid: process.pid, cwd: REPO, sessionId: 'a-session' }
    const { stdout } = runRemove([], { activeFlag: flag })
    expect(stdout).toContain(`server pid ${process.pid}`)
    expect(stdout).toContain('not touched here')
  })

  it('calls a flag stale when the server it names is gone', () => {
    const dead = spawnSync(process.execPath, ['-e', '']).pid
    const { stdout } = runRemove([], { activeFlag: { ts: 0, pid: dead, cwd: REPO, sessionId: 'gone' } })
    expect(stdout).toContain('stale')
  })
})
