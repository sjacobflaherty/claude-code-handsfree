import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'
import { SRC } from '../src/config.mjs'
import { makeRoot } from './fixture-root.mjs'

const SERVER = join(SRC, 'voice-channel.mjs')

const ChannelEventSchema = z.object({
  method: z.literal('notifications/claude/channel'),
  params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }),
})
// looseObject, so a field the server should not send survives into the comparison instead of being stripped.
const PermissionVerdictSchema = z.object({
  method: z.literal('notifications/claude/channel/permission'),
  params: z.looseObject({ request_id: z.string(), behavior: z.string() }),
})

const running = []
let serverSeq = 0

export async function waitUntil(what, fn, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

// The stand-in prints a file the test can rewrite, so a test can change the devices while the server runs.
function writeFakeAudiodev(root) {
  const dir = join(root, 'bin')
  mkdirSync(dir, { recursive: true })
  const pairFile = join(root, 'devices.txt')
  writeFileSync(join(dir, 'audiodev'), `#!/bin/sh\nexec /bin/cat '${pairFile}'\n`, { mode: 0o755 })
  // The real bin/disclaim execs its arguments as their own responsible process; here a plain exec reaches the stub hear on PATH.
  writeFileSync(join(dir, 'disclaim'), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 })
  return pairFile
}

// The UID bin/audiodev prints for a device, which is what hear -n takes.
export function deviceUid(name) {
  return `${name.replace(/\s+/g, '')}_UID`
}

// Written and renamed, because the stand-in can read the file between a truncate and a write.
function writeDevicePair(pairFile, { input, output }) {
  const both = input === output
  const lines = [`in=${input}`, `out=${output}`, `dev=1\t${deviceUid(input)}\t${both ? 'both' : 'in'}\t${input}`]
  if (!both) lines.push(`dev=2\t${deviceUid(output)}\tout\t${output}`)
  writeFileSync(`${pairFile}.tmp`, `${lines.join('\n')}\n`)
  renameSync(`${pairFile}.tmp`, pairFile)
}

// Each run appends its arguments to argsFile, so a test can read what the server asked hear for.
function writeStubHear(root, argsFile, rejectsDevice) {
  const dir = join(root, 'stub-bin')
  mkdirSync(dir, { recursive: true })
  const body = rejectsDevice
    ? `echo "The device 'x' is not a valid audio input device." >&2\nexit 1\n`
    : 'exec sleep 600\n'
  writeFileSync(join(dir, 'hear'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argsFile}'\n${body}`, { mode: 0o755 })
  return dir
}

// The stand-in for the client side: the server's parent, which a test can kill while the pipe to the client stays open.
function writeParentWrapper(root, pidFile) {
  const path = join(root, 'parent.mjs')
  const body = [
    "import { spawn } from 'node:child_process'",
    "import { writeFileSync } from 'node:fs'",
    "const child = spawn(process.execPath, process.argv.slice(2), { stdio: 'inherit' })",
    `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))`,
    'setInterval(() => {}, 60000)',
    '',
  ].join('\n')
  writeFileSync(path, body)
  return path
}

export async function startServer({
  settings = {},
  phrases = {},
  sessionId = 'test-session',
  devices = null,
  hearRejectsDevice = false,
  // An existing root, for a second server that shares one state folder with the first.
  root: sharedRoot = '',
  // Spawn the server under a stand-in parent that killClient() can kill on its own.
  orphanable = false,
} = {}) {
  const seq = ++serverSeq
  const root =
    sharedRoot ||
    makeRoot({
      settings: {
        rate: 400,
        silenceFallbackMs: 0,
        allowedInputs: ['no such device'],
        allowedOutputs: ['no such device'],
        log: { file: 'voice-channel.log', includeSentText: true },
        ...settings,
      },
      phrases,
    })
  const injectFile = join(root, 'inject.txt')
  // Two servers sharing a root each write their own log, so one server's lines never answer a wait on the other's.
  const logFile = join(root, sharedRoot ? `voice-channel-${seq}.log` : 'voice-channel.log')
  const hearArgsFile = join(root, 'hear-args.txt')
  const serverPidFile = join(root, `server-${seq}.pid`)
  if (!sharedRoot) writeFileSync(injectFile, '')
  writeFileSync(logFile, '')
  let pairFile = ''
  if (devices) {
    pairFile = writeFakeAudiodev(root)
    writeDevicePair(pairFile, devices)
  }

  const channelEvents = []
  const verdicts = []
  const stderrChunks = []
  const client = new Client({ name: 'voice-test-client', version: '0.0.1' }, { capabilities: {} })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: orphanable ? [writeParentWrapper(root, serverPidFile), SERVER] : [SERVER],
    cwd: root,
    stderr: 'pipe',
    // The SDK passes only a short allowlist of variables by default, which would drop CLAUDE_VOICE_* and start the real microphone.
    env: {
      ...process.env,
      CLAUDE_VOICE_ROOT: root,
      CLAUDE_VOICE_INJECT: devices ? '' : injectFile,
      CLAUDE_VOICE_SILENT: '1',
      CLAUDE_VOICE_SESSION_ID: sessionId,
      ...(devices ? { PATH: `${writeStubHear(root, hearArgsFile, hearRejectsDevice)}:${process.env.PATH}` } : {}),
      ...(sharedRoot ? { CLAUDE_VOICE_OVERRIDES: JSON.stringify({ log: { file: logFile } }) } : {}),
    },
  })
  client.setNotificationHandler(ChannelEventSchema, async ({ params }) => {
    channelEvents.push(params)
  })
  client.setNotificationHandler(PermissionVerdictSchema, async ({ params }) => {
    verdicts.push(params)
  })

  const server = {
    root,
    injectFile,
    client,
    channelEvents,
    verdicts,
    sessionId,
    stderr: () => stderrChunks.join(''),
    log: () => {
      try {
        return readFileSync(logFile, 'utf8')
      } catch {
        return ''
      }
    },
    utter(line) {
      appendFileSync(injectFile, `${line}\n`)
    },
    // The pid of the server itself, which is the child of the stand-in parent when the server is orphanable.
    serverPid() {
      if (!orphanable) return transport.pid
      try {
        return Number(readFileSync(serverPidFile, 'utf8').trim())
      } catch {
        return 0
      }
    },
    // Kills the process the server was started from, leaving the pipe to the client open.
    killClient() {
      try {
        process.kill(transport.pid, 'SIGKILL')
      } catch {}
    },
    // state/active.json, the flag that names the one server listening on this root.
    activeFlag() {
      try {
        return JSON.parse(readFileSync(join(root, 'state', 'active.json'), 'utf8'))
      } catch {
        return null
      }
    },
    // The pid of every stand-in hear this server has started, in order.
    hearPids() {
      return server
        .log()
        .split('\n')
        .map((l) => /hear start \{"pid":(\d+)/.exec(l))
        .filter(Boolean)
        .map((m) => Number(m[1]))
    },
    // One line per stand-in hear run, holding the arguments that run was given.
    hearArgs() {
      try {
        return readFileSync(hearArgsFile, 'utf8').split('\n').filter(Boolean)
      } catch {
        return []
      }
    },
    // What the next device read reports, for a server started with the devices option.
    setDevices(pair) {
      writeDevicePair(pairFile, pair)
    },
    speak(text) {
      return client.callTool({ name: 'speak', arguments: { text } })
    },
    // Every `silent say` line carries the argument list the real /usr/bin/say would have been given.
    sayCalls() {
      const calls = []
      for (const line of server.log().split('\n')) {
        const at = line.indexOf('silent say {')
        if (at === -1) continue
        try {
          calls.push(JSON.parse(line.slice(at + 'silent say '.length)))
        } catch {}
      }
      return calls
    },
    spoken() {
      return server.sayCalls().map((c) => c.text)
    },
    waitForEvent(match, timeoutMs) {
      return waitUntil(
        `a channel event matching ${match}`,
        () => channelEvents.find((e) => e.content.includes(match)),
        timeoutMs,
      )
    },
    waitForSpoken(match, timeoutMs) {
      return waitUntil(`the server to speak ${match}`, () => server.spoken().find((t) => t.includes(match)), timeoutMs)
    },
    waitForVerdict(timeoutMs) {
      return waitUntil('a permission verdict', () => verdicts[0], timeoutMs)
    },
    // Closing the transport only ends the pipe and then waits two seconds for the child, so SIGTERM goes first.
    async stop() {
      const pid = transport.pid
      // A stand-in parent does not pass a signal on, so the server it started is ended here too.
      const child = orphanable ? server.serverPid() : 0
      if (child)
        try {
          process.kill(child, 'SIGTERM')
        } catch {}
      if (pid)
        try {
          process.kill(pid, 'SIGTERM')
        } catch {}
      try {
        await client.close()
      } catch {}
      if (pid)
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
    },
  }
  running.push(server)
  await client.connect(transport)
  transport.stderr?.on('data', (chunk) => stderrChunks.push(chunk.toString()))
  // A line written before the server has read the inject file's starting length would be skipped.
  const ready = devices
    ? () => server.log().includes('listening on') || server.log().includes('refusing to listen')
    : () => server.log().includes('inject listening on') || server.log().includes('refusing to listen')
  try {
    await waitUntil('the server to start listening', ready, 8000)
  } catch (e) {
    throw new Error(`${e.message}\nserver stderr:\n${server.stderr()}`)
  }
  return server
}

export async function stopServers() {
  while (running.length) await running.pop().stop()
}
