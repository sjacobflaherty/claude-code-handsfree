#!/usr/bin/env node
// Proves the install without a microphone or a Claude Code session: starts the server the way Claude Code
// would, feeds it one utterance through the inject file, waits for it to arrive as a channel event, and has
// it speak once with the audio replaced by a pause. Exit 0 with three ok lines, exit 1 with what failed.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'
import { exitOnCrash, printFailRow, printHelpIfAsked, printOkRow } from './cli.mjs'
import { SRC, VOICE_ROOT } from './config.mjs'

printHelpIfAsked(`
Prove the install without a microphone or a session: start the server, send one typed utterance, hear it speak once (silently).

Examples:
  npm run smoke

Flags:
  --help, -h     this text
`)
exitOnCrash('npm run smoke --')

const LINE = 'smoke test, send message'
const TIMEOUT_MS = 15000

function exitWithFailRow(msg) {
  printFailRow(msg)
  process.exit(1)
}

const work = mkdtempSync(join(tmpdir(), 'handsfree-smoke-'))
const inject = join(work, 'inject.txt')
writeFileSync(inject, '')
mkdirSync(join(VOICE_ROOT, 'state'), { recursive: true })

const ChannelEvent = z.object({
  method: z.literal('notifications/claude/channel'),
  params: z.object({ content: z.string(), meta: z.record(z.string(), z.unknown()).optional() }),
})

const events = []
const client = new Client({ name: 'smoke', version: '0' }, { capabilities: {} })
client.setNotificationHandler(ChannelEvent, async ({ params }) => {
  events.push(params.content)
})
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(SRC, 'voice-channel.mjs')],
  cwd: VOICE_ROOT,
  stderr: 'pipe',
  env: { ...process.env, CLAUDE_VOICE_ROOT: VOICE_ROOT, CLAUDE_VOICE_INJECT: inject, CLAUDE_VOICE_SILENT: '1' },
})
const stderr = []
const timer = setTimeout(() => exitWithFailRow(`no reply within ${TIMEOUT_MS} ms\n${stderr.join('')}`), TIMEOUT_MS)

try {
  await client.connect(transport)
  transport.stderr?.on('data', (c) => stderr.push(c.toString()))
  const tools = (await client.listTools()).tools.map((t) => t.name)
  for (const name of ['speak', 'voice_start', 'voice_stop', 'voice_status'])
    if (!tools.includes(name)) exitWithFailRow(`server has no ${name} tool; it lists ${tools.join(', ')}`)
  printOkRow('server started and lists speak, voice_start, voice_stop, voice_status')

  // The server reads the file's length at start, so the line is appended only once it listens.
  await new Promise((r) => setTimeout(r, 1000))
  writeFileSync(inject, `${LINE}\n`, { flag: 'a' })
  while (!events.some((e) => e.startsWith('smoke test'))) await new Promise((r) => setTimeout(r, 100))
  printOkRow(`an utterance arrived as a voice message: "${LINE}"`)

  const spoken = await client.callTool({ name: 'speak', arguments: { text: 'smoke test reply' } })
  if (spoken.isError) exitWithFailRow(`speak failed: ${JSON.stringify(spoken.content)}`)
  printOkRow('speak ran (audio replaced by a pause, CLAUDE_VOICE_SILENT=1)')
  await client.callTool({ name: 'voice_stop', arguments: {} })
} finally {
  clearTimeout(timer)
  try {
    await client.close()
  } catch {}
  rmSync(work, { recursive: true, force: true })
}
console.log('\nSmoke test passed. A real session needs the headset and: claude-code-handsfree')
process.exit(0)
