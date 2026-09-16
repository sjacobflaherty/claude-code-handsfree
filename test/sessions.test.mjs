import { describe, expect, it } from 'vitest'
import { isClaudeCommand, parseServerProcesses } from '../src/sessions.mjs'

describe('finding the voice servers ps reports', () => {
  const SERVER = '  4102  4090 node /repo/src/voice-channel.mjs'
  // The line claude itself runs under, which names the server's path inside its --mcp-config argument.
  const CLAUDE = `  4090  4080 claude --mcp-config {"mcpServers":{"voice":{"command":"node","args":["/repo/src/voice-channel.mjs"]}}} --model opus`
  const LAUNCHER = '  4080  4070 node /repo/src/launch.mjs --model opus'

  it('takes the server and leaves the claude and launcher processes that name its path', () => {
    expect(parseServerProcesses([LAUNCHER, CLAUDE, SERVER].join('\n'), 999)).toEqual([
      { pid: 4102, ppid: 4090, command: 'node /repo/src/voice-channel.mjs' },
    ])
  })

  it('leaves out the process doing the asking', () => {
    expect(parseServerProcesses(SERVER, 4102)).toEqual([])
  })

  it('reads a parent command as claude only when the command it runs is claude', () => {
    expect(isClaudeCommand('claude --model opus')).toBe(true)
    expect(isClaudeCommand('/usr/local/bin/claude --model opus')).toBe(true)
    expect(isClaudeCommand('node /repo/claude-voice-channel/node_modules/vitest/vitest.mjs')).toBe(false)
    expect(isClaudeCommand('')).toBe(false)
  })
})
