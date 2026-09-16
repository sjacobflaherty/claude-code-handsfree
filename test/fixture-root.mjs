import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, ROOT } from '../src/config.mjs'

const roots = []

function writeConfig(dir, base, body) {
  writeFileSync(join(dir, `${base}.jsonc`), typeof body === 'string' ? body : JSON.stringify(body, null, 2))
}

// localeFiles writes a language file that does not ship, so a test can put a second locale in front of the loader.
export function makeRoot({ settings = {}, phrases = {}, locales = ['en'], localeFiles = {}, profiles = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'voice-config-'))
  roots.push(root)
  writeConfig(root, 'settings', settings)
  writeConfig(root, 'phrases', phrases)
  mkdirSync(join(root, 'locales'))
  for (const locale of locales) cpSync(join(ROOT, 'locales', `${locale}.json`), join(root, 'locales', `${locale}.json`))
  for (const [locale, body] of Object.entries(localeFiles))
    writeFileSync(join(root, 'locales', `${locale}.json`), JSON.stringify(body, null, 2))
  for (const [name, files] of Object.entries(profiles)) {
    const dir = join(root, 'profiles', name)
    mkdirSync(dir, { recursive: true })
    for (const [base, body] of Object.entries(files)) writeConfig(dir, base, body)
  }
  return root
}

export function cleanupRoots() {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true })
}

// fail(message) must not return, so the stand-in throws.
class Refused extends Error {}

export function refuseOnFail(messages) {
  return (message) => {
    messages.push(message)
    throw new Refused(message)
  }
}

export function runRefusable(run) {
  const messages = []
  try {
    return { value: run(refuseOnFail(messages)), refusal: undefined }
  } catch (e) {
    if (!(e instanceof Refused)) throw e
    return { value: undefined, refusal: messages[0] }
  }
}

// Loads the config the way the commands do, from a fresh root or the one given; refusal is the first fail message.
export function loadConfigFromRoot({ root = '', env = {}, ...rootSpec } = {}) {
  const from = root || makeRoot(rootSpec)
  const { value, refusal } = runRefusable((fail) => loadConfig({ root: from, env, fail }))
  return { config: value, refusal, root: from }
}

// The pid of a process that has already exited, for a stale active.json.
export function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid
}

// The body of state/active.json as the server writes it.
export function activeFlagFor({ spoke_at_ms = 0, pid = process.pid, cwd = ROOT, sessionId = 'a-session' } = {}) {
  return { spoke_at_ms, pid, cwd, sessionId }
}
