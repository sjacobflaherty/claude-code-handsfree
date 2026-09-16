import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const DISCLAIM = join(REPO, 'bin', 'disclaim')

// bin/disclaim execs its arguments as their own responsible process, so TCC judges hear's
// embedded Info.plist instead of the terminal app's. Cursor and VS Code declare no
// NSSpeechRecognitionUsageDescription, and macOS kills hear under them with SIGABRT
// instead of prompting. The TCC seam itself needs an app bundle to reproduce, which is a manual
// check outside this suite. This covers what a unit test can: the exec, the exit code, stdio
// passthrough, and the usage error.
describe('bin/disclaim', () => {
  it('is built by npm run build', () => {
    expect(existsSync(DISCLAIM)).toBe(true)
  })

  it('execs the command in place with its stdio and exit code', () => {
    const r = spawnSync(DISCLAIM, ['/bin/sh', '-c', 'echo out; echo err >&2; exit 7'], { encoding: 'utf8' })
    expect(r.stdout).toBe('out\n')
    expect(r.stderr).toBe('err\n')
    expect(r.status).toBe(7)
  })

  it('finds the command on PATH', () => {
    const r = spawnSync(DISCLAIM, ['echo', 'via path'], { encoding: 'utf8' })
    expect(r.stdout).toBe('via path\n')
  })

  it('exits 127 with a message when the command does not exist', () => {
    const r = spawnSync(DISCLAIM, ['no-such-command-for-disclaim'], { encoding: 'utf8' })
    expect(r.status).toBe(127)
    expect(r.stderr).toContain('no-such-command-for-disclaim')
  })

  it('exits 2 with usage when given nothing', () => {
    const r = spawnSync(DISCLAIM, [], { encoding: 'utf8' })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('usage')
  })
})
