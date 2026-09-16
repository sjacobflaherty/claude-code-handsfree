import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanupRoots, makeRoot } from './fixture-root.mjs'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const SMOKE = join(REPO, 'src', 'smoke.mjs')

afterAll(cleanupRoots)

describe('npm run smoke', () => {
  it('starts the server, gets one utterance through, speaks once, and passes without a microphone', () => {
    const root = makeRoot()
    const run = spawnSync(process.execPath, [SMOKE], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_VOICE_ROOT: root },
      timeout: 30000,
    })
    expect(run.stdout).toContain('ok    server started')
    expect(run.stdout).toContain('ok    an utterance arrived')
    expect(run.stdout).toContain('ok    speak ran')
    expect(run.stdout).toContain('Smoke test passed')
    expect(run.status).toBe(0)
  })
})
