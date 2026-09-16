import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

// The author's signed build of hear. Setup puts it in bin/ so nobody needs Homebrew, the
// full Xcode app (the Homebrew formula builds from source with xcodebuild), or sudo.
export const HEAR_RELEASE = {
  url: 'https://sveinbjorn.org/files/software/hear.zip',
  // The Developer ID team the binary must be signed by, checked with codesign before it ever runs.
  team: '5WX26Y89JP',
}

// bin/hear when setup placed it there, else hear from PATH for a user who installed it themselves.
export function hearCommand(root) {
  const local = join(root, 'bin', 'hear')
  return existsSync(local) ? local : 'hear'
}

export function hearVersion(command) {
  const r = spawnSync(command, ['-v'], { encoding: 'utf8' })
  return r.status === 0 ? (r.stdout || '').trim().split('\n')[0] : ''
}

// The TeamIdentifier from a valid signature, '' when the file is unsigned, tampered with, or not there.
export function signingTeam(file) {
  const verify = spawnSync('codesign', ['--verify', '--strict', file], { encoding: 'utf8' })
  if (verify.status !== 0) return ''
  const info = spawnSync('codesign', ['-dv', '--verbose=2', file], { encoding: 'utf8' })
  const m = /TeamIdentifier=(\S+)/.exec(`${info.stdout}\n${info.stderr}`)
  return m ? m[1] : ''
}

// Downloads the release zip into bin/, extracts hear and its man page, and keeps them only when the
// signature is by HEAR_RELEASE.team. Returns { ok, message }; nothing runnable is left behind on failure.
export function installHear(root, { url = process.env.CLAUDE_VOICE_HEAR_URL || HEAR_RELEASE.url } = {}) {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const zip = join(bin, 'hear.zip')
  const files = [join(bin, 'hear'), join(bin, 'hear.1')]
  const discard = () => {
    for (const f of [zip, ...files])
      try {
        unlinkSync(f)
      } catch {}
  }
  const dl = spawnSync('curl', ['-fsSL', '-o', zip, url], { encoding: 'utf8' })
  if (dl.status !== 0) {
    discard()
    return { ok: false, message: `download failed: ${url}\n${(dl.stderr || '').trim()}` }
  }
  const unzip = spawnSync('unzip', ['-o', '-q', '-j', zip, '*/hear', '*/hear.1', '-d', bin], { encoding: 'utf8' })
  if (unzip.status !== 0 || !existsSync(files[0])) {
    discard()
    return { ok: false, message: `${url} did not hold hear and hear.1 in a folder at its top level` }
  }
  const team = signingTeam(files[0])
  if (team !== HEAR_RELEASE.team) {
    discard()
    return {
      ok: false,
      message: `the hear in ${url} is ${team ? `signed by team ${team}` : 'not validly signed'}, expected Developer ID team ${HEAR_RELEASE.team}; nothing was kept`,
    }
  }
  try {
    unlinkSync(zip)
  } catch {}
  return { ok: true, message: hearVersion(files[0]) || 'hear' }
}
