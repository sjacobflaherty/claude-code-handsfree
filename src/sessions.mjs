// Which voice servers are running and which one holds the microphone: state/active.json and ps.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM means the process is there and owned by someone else.
    return e.code === 'EPERM'
  }
}

export function activeFlagPath(root) {
  return join(root, 'state', 'active.json')
}

// state/active.json names the one server listening on this root; alive is false when that server is gone.
export function readActiveFlag(root) {
  let flag
  try {
    flag = JSON.parse(readFileSync(activeFlagPath(root), 'utf8'))
  } catch {
    return null
  }
  const pid = Number(flag?.pid)
  if (!Number.isInteger(pid) || pid < 1) return null
  return { ...flag, pid, alive: isPidAlive(pid) }
}

// The server runs as `node <path>/voice-channel.mjs`. The claude process that starts it names the same path inside
// --mcp-config, and the launcher names it in its own arguments, so neither of those is a server.
function isServerCommand(command) {
  const script = command.trim().split(/\s+/)[1] || ''
  return basename(script) === 'voice-channel.mjs'
}

export function parseServerProcesses(psOutput, self = process.pid) {
  const servers = []
  for (const line of String(psOutput).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    if (pid === self || !isServerCommand(m[3])) continue
    servers.push({ pid, ppid: Number(m[2]), command: m[3] })
  }
  return servers
}

// ps is the only way to see a server this process did not start.
export function findRunningServers() {
  const r = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
  return parseServerProcesses(r.stdout || '')
}

export function readProcessCommand(pid) {
  if (!isPidAlive(pid)) return ''
  const r = spawnSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  return r.status === 0 ? (r.stdout || '').trim() : ''
}

// Claude Code starts the server, so the first word of the parent's command line is the claude binary.
export function isClaudeCommand(command) {
  const first = String(command).trim().split(/\s+/)[0] || ''
  return basename(first) === 'claude'
}
