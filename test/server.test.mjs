import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { fmt } from '../src/phrases.mjs'
import { cleanupRoots } from './fixture-root.mjs'
import { deviceUid, processAlive, startServer, stopServers, waitUntil } from './fixture-server.mjs'

const EN = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'))

afterEach(stopServers)
afterAll(cleanupRoots)

describe('sending a message', () => {
  it('pushes an injected line as a voice channel event and says the receipt cue', async () => {
    const server = await startServer()
    server.utter('what does take return when the queue is empty')
    const event = await server.waitForEvent('what does take return when the queue is empty')
    expect(event.meta.mode).toBe('voice')
    expect(event.meta.reply_with).toBe('speak_tool')
    await server.waitForSpoken(EN.strings.acknowledgement)
  })

  it('sends what was said before "send message" and not the phrase itself', async () => {
    const server = await startServer()
    server.utter('the queue blocks on take send message')
    const event = await server.waitForEvent('the queue blocks on take')
    expect(event.content.startsWith('the queue blocks on take')).toBe(true)
    expect(event.content).not.toContain('send message')
  })
})

describe('pause session and resume session', () => {
  it('discards what is said while paused and sends again after resume', async () => {
    const server = await startServer()
    server.utter('pause session')
    await server.waitForSpoken(EN.strings.paused)
    server.utter('this line is said while paused')
    server.utter('resume session')
    await server.waitForSpoken(EN.strings.resumed)
    server.utter('this line is said after resuming')
    await server.waitForEvent('this line is said after resuming')
    expect(server.channelEvents.map((e) => e.content).join('\n')).not.toContain('while paused')
  })
})

describe('replay voice', () => {
  const timesSpoken = (server, text) => server.spoken().filter((t) => t === text).length

  it('re-speaks the last reply, and the Nth with a number, without sending the phrase as a message', async () => {
    const server = await startServer({ settings: { advanced: { replaySettleMs: 200 } } })
    await server.speak('the first reply')
    await server.speak('the second reply')

    server.utter('replay voice')
    await waitUntil('the last reply to be replayed', () => timesSpoken(server, 'the second reply') === 2)

    server.utter('replay voice two')
    await waitUntil('the second most recent reply to be replayed', () => timesSpoken(server, 'the first reply') === 2)

    expect(server.channelEvents).toEqual([])
  })
})

describe('stop session', () => {
  it('stops listening, says so, and reports it through voice_status', async () => {
    const server = await startServer()
    server.utter('stop session')
    await server.waitForSpoken(EN.strings.stopped)
    const status = await server.client.callTool({ name: 'voice_status', arguments: {} })
    expect(status.content[0].text).toContain('listening=false')
    expect(status.content[0].text).toContain('stopped=true')
    // A stopped server reads the inject file no more, so there is nothing to wait on but two of its 500 ms polls.
    server.utter('this line is said after the stop')
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(server.channelEvents).toEqual([])
  })
})

describe('the permission relay', () => {
  const request = (server, id, tool) =>
    server.client.notification({
      method: 'notifications/claude/channel/permission_request',
      params: { request_id: id, tool_name: tool, description: `run ${tool}`, input_preview: 'git push origin main' },
    })

  it('turns a spoken yes into an allow verdict and a spoken no into a deny', async () => {
    const server = await startServer()

    await request(server, 'aaaaa', 'Bash')
    await server.waitForSpoken('Bash')
    server.utter('yes')
    expect(await server.waitForVerdict()).toEqual({ request_id: 'aaaaa', behavior: 'allow' })

    await request(server, 'bbbbb', 'Write')
    await server.waitForSpoken('Write')
    server.utter('no')
    await waitUntil('the deny verdict', () => server.verdicts[1])
    expect(server.verdicts[1]).toEqual({ request_id: 'bbbbb', behavior: 'deny' })

    expect(server.channelEvents).toEqual([])
  })
})

describe('switch model', () => {
  const quickSettle = { settings: { advanced: { modelSettleMs: 200 } } }
  const confirm = (target) => fmt(EN.strings.confirmModel, { model: target })
  const askEffort = (model) => fmt(EN.strings.askEffort, { model })
  // What the confirmation says before the model name, so the test does not repeat the locale file's wording.
  const askPrefix = EN.strings.confirmModel.split('{model}')[0]
  const asked = (server) => server.spoken().filter((t) => t.startsWith(askPrefix))
  const nextModel = (server) => {
    try {
      return readFileSync(join(server.root, 'state', 'next-model'), 'utf8')
    } catch {
      return ''
    }
  }

  it('asks once, with both words, when the model and the effort are said together', async () => {
    const server = await startServer(quickSettle)
    server.utter('switch model fable low')
    await server.waitForSpoken(confirm('fable low'))
    expect(asked(server)).toEqual([confirm('fable low')])
    expect(server.spoken()).not.toContain(askEffort('fable'))
    expect(server.channelEvents).toEqual([])
  })

  it('holds the model word until the effort word arrives, then asks once', async () => {
    const server = await startServer({ settings: { advanced: { modelSettleMs: 3000 } } })
    server.utter('switch model fable')
    await waitUntil('the server to hold the model word', () => server.log().includes('model phrase without effort'))
    expect(asked(server)).toEqual([])
    server.utter('switch model fable low')
    await server.waitForSpoken(confirm('fable low'))
    expect(asked(server)).toEqual([confirm('fable low')])
    expect(server.spoken()).not.toContain(askEffort('fable'))
    expect(server.channelEvents).toEqual([])
  })

  it('asks which effort when the model word is said on its own', async () => {
    const server = await startServer(quickSettle)
    server.utter('switch model fable')
    await server.waitForSpoken(askEffort('fable'))
    expect(asked(server)).toEqual([])
    expect(server.channelEvents).toEqual([])
  })

  it('takes a lone effort word after that question and writes the marker on a yes', async () => {
    // A confirmed switch ends the process the server was started from, so it runs under the stand-in parent here.
    const server = await startServer({ ...quickSettle, orphanable: true })
    server.utter('switch model fable')
    await server.waitForSpoken(askEffort('fable'))
    server.utter('low')
    await server.waitForSpoken(confirm('fable low'))
    server.utter('yes')
    await waitUntil('the next model marker to be written', () => nextModel(server))
    expect(nextModel(server)).toBe('fable low')
    expect(server.channelEvents).toEqual([])
  })

  it('stays on the current model after a no, with no marker written', async () => {
    const server = await startServer(quickSettle)
    server.utter('switch model fable low')
    await server.waitForSpoken(confirm('fable low'))
    server.utter('no')
    await server.waitForSpoken(EN.strings.modelCancelled)
    expect(nextModel(server)).toBe('')
    expect(server.log()).toContain('"reason":"declined"')
    expect(server.channelEvents).toEqual([])
    // The question is closed, so a later yes is ordinary speech and not an answer.
    server.utter('yes')
    await server.waitForEvent('yes')
    expect(nextModel(server)).toBe('')
  })

  it('stays on the current model when nothing is said within modelConfirmMs', async () => {
    const server = await startServer({ settings: { advanced: { modelSettleMs: 200, modelConfirmMs: 800 } } })
    server.utter('switch model fable low')
    await server.waitForSpoken(confirm('fable low'))
    await server.waitForSpoken(EN.strings.modelCancelled)
    expect(nextModel(server)).toBe('')
    expect(server.log()).toContain('"reason":"timed out"')
    expect(server.channelEvents).toEqual([])
  })

  it('says it knows no such model when the word after the phrase names none', async () => {
    const server = await startServer(quickSettle)
    server.utter('switch model banana')
    await server.waitForSpoken(fmt(EN.strings.unknownModel, { model: 'banana' }))
    expect(asked(server)).toEqual([])
    expect(server.channelEvents).toEqual([])
  })

  it('says nothing about an unknown model while the model word is still arriving', async () => {
    const server = await startServer({ settings: { advanced: { modelSettleMs: 3000 } } })
    server.utter('switch model fab')
    await waitUntil('the server to hold the unknown word', () => server.log().includes('model word not known'))
    server.utter('switch model fable low')
    await server.waitForSpoken(confirm('fable low'))
    expect(server.spoken()).not.toContain(fmt(EN.strings.unknownModel, { model: 'fab' }))
  })

  it('drops the pending model when what follows that question is not an effort word', async () => {
    const server = await startServer(quickSettle)
    server.utter('switch model fable')
    await server.waitForSpoken(askEffort('fable'))
    server.utter('what does take return when the queue is empty')
    await server.waitForEvent('what does take return when the queue is empty')
    expect(server.log()).toContain('other speech')
    server.utter('low')
    await server.waitForEvent('low')
    expect(asked(server)).toEqual([])
  })
})

describe('commands the user adds to the table', () => {
  const withCommands = (commands, settings = {}) => ({ settings, phrases: { overrides: { en: { commands } } } })

  it('runs a shipped call from a phrase the user adds', async () => {
    const server = await startServer(withCommands({ quiet: { say: ['go quiet'], call: 'pause' } }))
    server.utter('go quiet')
    await server.waitForSpoken(EN.strings.paused)
    server.utter('this line is said while paused')
    server.utter('resume session')
    await server.waitForSpoken(EN.strings.resumed)
    expect(server.channelEvents).toEqual([])
  })

  it('asks to confirm the fixed model and effort of a preset, without waiting for either word', async () => {
    const server = await startServer(
      withCommands(
        { 'use fable': { say: ['use fable'], call: 'switchModel', args: { model: 'fable', effort: 'low' } } },
        { advanced: { modelSettleMs: 3000 } },
      ),
    )
    server.utter('use fable')
    await server.waitForSpoken(fmt(EN.strings.confirmModel, { model: 'fable low' }))
    expect(server.spoken()).not.toContain(fmt(EN.strings.askEffort, { model: 'fable' }))
    expect(server.channelEvents).toEqual([])
  })

  it('sends the fixed text of a send preset and not the phrase that asked for it', async () => {
    const text = 'Summarize what changed since yesterday'
    const server = await startServer(withCommands({ daily: { say: ['daily standup'], call: 'send', args: { text } } }))
    server.utter('ok, daily standup')
    const event = await server.waitForEvent(text)
    expect(event.content).not.toContain('daily standup')
  })
})

describe('the microphone guard', () => {
  const headset = { input: 'Wireless Headset', output: 'Wireless Headset' }

  it('refuses to listen and names the setup command when no device is configured', async () => {
    const server = await startServer({ devices: headset, settings: { allowedInputs: [], allowedOutputs: 'same' } })
    await server.waitForSpoken(EN.strings.noDeviceConfigured)
    expect(EN.strings.noDeviceConfigured).toContain('npm run setup')
    expect(server.log()).toContain('npm run setup')
    expect(server.spoken().join('\n')).not.toContain('Wireless Headset')
    const status = await server.client.callTool({ name: 'voice_status', arguments: {} })
    expect(status.content[0].text).toContain('listening=false')
  })

  it('still names the device when one is configured and a different one is plugged in', async () => {
    const server = await startServer({
      devices: { input: 'Built-in Microphone', output: 'Built-in Speakers' },
      settings: { allowedInputs: ['Wireless Headset'], allowedOutputs: 'same' },
    })
    const spoken = await server.waitForSpoken('Built-in Microphone')
    expect(spoken).not.toContain('npm run setup')
  })

  it('listens on a configured device, which is what setup writes', async () => {
    const server = await startServer({
      devices: headset,
      settings: { allowedInputs: ['Wireless Headset'], allowedOutputs: 'same' },
    })
    await waitUntil('the server to listen on the configured device', () =>
      server.log().includes('listening on Wireless Headset'),
    )
    const status = await server.client.callTool({ name: 'voice_status', arguments: {} })
    expect(status.content[0].text).toContain('listening=true')
  })
})

describe('the device hear is told to record from', () => {
  const headset = { input: 'Wireless Headset', output: 'Wireless Headset' }
  const allowHeadset = { allowedInputs: ['Wireless Headset'], allowedOutputs: 'same' }

  it('passes the device UID, not the numeric id, when a session picks the input by name', async () => {
    const server = await startServer({ devices: headset, settings: allowHeadset })
    await server.client.callTool({ name: 'voice_start', arguments: { input: 'Headset' } })
    const args = await waitUntil('hear to be started on a named device', () =>
      server.hearArgs().find((a) => a.includes('-n ')),
    )
    expect(args).toContain(`-n ${deviceUid('Wireless Headset')}`)
  })

  it('names the device when hear refuses to record from it', async () => {
    const server = await startServer({ devices: headset, settings: allowHeadset, hearRejectsDevice: true })
    await server.waitForSpoken(fmt(EN.strings.hearRejectedDevice, { input: 'Wireless Headset' }))
    expect(server.log()).toContain('hear rejected device')
  })
})

describe('the device list voice_status reports', () => {
  const statusText = async (server) => {
    const status = await server.client.callTool({ name: 'voice_status', arguments: {} })
    return status.content[0].text
  }

  it('tags each device with its direction and both verdicts, and names the output rule', async () => {
    const server = await startServer({
      devices: { input: 'Wireless Headset', output: 'External Speakers' },
      settings: { allowedInputs: ['Wireless Headset'], allowedOutputs: ['External Speakers'] },
    })
    const text = await statusText(server)
    expect(text).toContain('outputRule=list')
    expect(text).toContain('Wireless Headset (in, input allowed)')
    expect(text).toContain('External Speakers (out, output allowed)')
  })

  it('marks a device that is on neither list, so the skill can leave it out', async () => {
    const server = await startServer({
      devices: { input: 'Built-in Microphone', output: 'Built-in Microphone' },
      settings: { allowedInputs: ['Wireless Headset'], allowedOutputs: 'same' },
    })
    const text = await statusText(server)
    expect(text).toContain('outputRule=same-as-input')
    expect(text).toContain('Built-in Microphone (both, input not allowed, output not allowed)')
  })
})

describe('a device change while listening', () => {
  const headset = { input: 'Wireless Headset', output: 'Wireless Headset' }
  const desk = { input: 'Desk Microphone', output: 'Desk Microphone' }
  const twoAllowed = {
    allowedInputs: ['Wireless Headset', 'Desk Microphone'],
    allowedOutputs: ['Wireless Headset', 'Desk Microphone'],
    deviceCheckIntervalMs: 100,
  }
  const switchedTo = (name) => fmt(EN.strings.switchedDevice, { input: name })
  const listensOn = (server, name) =>
    waitUntil(`the server to listen on ${name}`, () => server.log().includes(`listening on ${name}`))
  const isListening = async (server) => {
    const status = await server.client.callTool({ name: 'voice_status', arguments: {} })
    return status.content[0].text.includes('listening=true')
  }

  it('resumes on the new pair when it is allowed and says which device it moved to', async () => {
    const server = await startServer({ devices: headset, settings: twoAllowed })
    await listensOn(server, 'Wireless Headset')
    server.setDevices(desk)
    await server.waitForSpoken(switchedTo('Desk Microphone'))
    await listensOn(server, 'Desk Microphone')
    expect(await isListening(server)).toBe(true)
  })

  it('stays stopped and logs the device and the side when the new pair is not allowed', async () => {
    const server = await startServer({
      devices: headset,
      settings: { ...twoAllowed, allowedInputs: ['Wireless Headset'], allowedOutputs: 'same' },
    })
    await listensOn(server, 'Wireless Headset')
    server.setDevices({ input: 'Built-in Microphone', output: 'Built-in Microphone' })
    const line = await waitUntil('the log to say why it did not resume', () =>
      server
        .log()
        .split('\n')
        .find((l) => l.includes('not resuming')),
    )
    expect(line).toContain('Built-in Microphone')
    expect(line).toContain('input')
    expect(await isListening(server)).toBe(false)
    expect(server.spoken()).not.toContain(switchedTo('Built-in Microphone'))
  })

  it('stays stopped when resumeOnDeviceChange is false', async () => {
    const server = await startServer({ devices: headset, settings: { ...twoAllowed, resumeOnDeviceChange: false } })
    await listensOn(server, 'Wireless Headset')
    server.setDevices(desk)
    await waitUntil('the session to stop', () => server.log().includes('stopped: audio device changed'))
    // Six device checks at the interval above, which is three times what a resume needs.
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(server.log()).not.toContain('listening on Desk Microphone')
    expect(await isListening(server)).toBe(false)
  })

  it('resumes no more once voice_stop has answered the wait', async () => {
    const server = await startServer({ devices: headset, settings: twoAllowed })
    await listensOn(server, 'Wireless Headset')
    server.setDevices({ input: 'Built-in Microphone', output: 'Built-in Microphone' })
    await waitUntil('the log to say why it did not resume', () => server.log().includes('not resuming'))
    const stop = await server.client.callTool({ name: 'voice_stop', arguments: {} })
    expect(stop.content[0].text).toBe('stopped')
    server.setDevices(desk)
    // Six device checks at the interval above, which is three times what a resume needs.
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(server.log()).not.toContain('listening on Desk Microphone')
    expect(await isListening(server)).toBe(false)
  })

  it('resumes only on the fallback pair when fallbackInput is set', async () => {
    const three = ['Wireless Headset', 'Desk Microphone', 'Studio Monitor']
    const server = await startServer({
      devices: headset,
      settings: {
        ...twoAllowed,
        allowedInputs: three,
        allowedOutputs: three,
        fallbackInput: 'Desk Microphone',
      },
    })
    await listensOn(server, 'Wireless Headset')
    server.setDevices({ input: 'Studio Monitor', output: 'Studio Monitor' })
    await waitUntil('the log to refuse an allowed pair that is not the fallback', () =>
      server.log().includes('not resuming'),
    )
    expect(server.log()).not.toContain('listening on Studio Monitor')
    server.setDevices(desk)
    await listensOn(server, 'Desk Microphone')
    await server.waitForSpoken(switchedTo('Desk Microphone'))
  })
})

describe('one listening server per Mac', () => {
  const flagOf = (server) => waitUntil('the server to claim state/active.json', () => server.activeFlag())

  it('refuses a second server while the first holds the flag, speaks it, and leaves the flag alone', async () => {
    const first = await startServer()
    const held = await flagOf(first)
    const second = await startServer({ root: first.root })

    await second.waitForSpoken(EN.strings.anotherSession)
    expect(second.log()).toContain('another voice session is listening')
    const start = await second.client.callTool({ name: 'voice_start', arguments: {} })
    expect(start.content[0].text).toBe(`refused: another voice session is listening (pid ${held.pid})`)
    // A server that is not listening never writes the flag, so the first server stays the one the hooks answer to.
    await second.speak('the second session answers in text')
    expect(second.activeFlag().pid).toBe(held.pid)

    first.utter('the first session still sends send message')
    await first.waitForEvent('the first session still sends')
    expect(second.channelEvents).toEqual([])
  })

  it('ignores a flag that names a dead server', async () => {
    const first = await startServer()
    const root = first.root
    await first.stop()
    const done = spawnSync(process.execPath, ['-e', ''])
    mkdirSync(join(root, 'state'), { recursive: true })
    writeFileSync(
      join(root, 'state', 'active.json'),
      JSON.stringify({ ts: 0, pid: done.pid, cwd: root, sessionId: 'gone' }),
    )

    const second = await startServer({ root })
    expect(second.log()).not.toContain('another voice session is listening')
    expect(second.activeFlag().pid).toBe(second.serverPid())
    second.utter('the stale flag blocked nothing send message')
    await second.waitForEvent('the stale flag blocked nothing')
  })

  it('lets the other server take over once voice_stop has released the flag', async () => {
    const first = await startServer()
    await flagOf(first)
    const second = await startServer({ root: first.root })

    const stop = await first.client.callTool({ name: 'voice_stop', arguments: {} })
    expect(stop.content[0].text).toBe('stopped')
    expect(first.activeFlag()).toBe(null)

    const start = await second.client.callTool({ name: 'voice_start', arguments: {} })
    expect(start.content[0].text).toContain('listening input=')
    expect(second.activeFlag().pid).toBe(second.serverPid())
  })
})

describe('a server that has lost its session', () => {
  it('kills hear, clears the flag, and exits when the process it was started from is gone', async () => {
    const server = await startServer({
      devices: { input: 'Wireless Headset', output: 'Wireless Headset' },
      settings: { allowedInputs: ['Wireless Headset'], allowedOutputs: 'same', deviceCheckIntervalMs: 100 },
      orphanable: true,
    })
    await waitUntil('the server to listen', () => server.log().includes('listening on Wireless Headset'))
    const serverPid = server.serverPid()
    const hearPid = await waitUntil('the stand-in hear to start', () => server.hearPids()[0])
    expect(processAlive(serverPid)).toBe(true)
    expect(processAlive(hearPid)).toBe(true)

    server.killClient()
    await waitUntil('the server to exit', () => !processAlive(serverPid), 8000)
    await waitUntil('the stand-in hear to exit', () => !processAlive(hearPid), 8000)
    expect(server.activeFlag()).toBe(null)
    // The pipe to the client stays open when the stand-in parent dies, so only the parent watch can have ended this server.
    expect(server.log()).toContain('parent gone, exiting')
  })
})

describe('the say arguments a reply is spoken with', () => {
  const lastCall = (server, text) => server.sayCalls().find((c) => c.text === text)

  it('names no voice when voice is empty, so say uses the system voice', async () => {
    const server = await startServer({ settings: { rate: 190 } })
    await server.speak('the queue blocks on take')
    expect(lastCall(server, 'the queue blocks on take').args).toEqual(['-r', '190', '--', 'the queue blocks on take'])
  })

  it('names the voice when one is configured', async () => {
    const server = await startServer({ settings: { rate: 190 }, phrases: { overrides: { en: { voice: 'Whisper' } } } })
    await server.speak('the queue blocks on take')
    expect(lastCall(server, 'the queue blocks on take').args).toEqual([
      '-r',
      '190',
      '-v',
      'Whisper',
      '--',
      'the queue blocks on take',
    ])
  })
})

describe('the speak tool', () => {
  it('returns spoken once playback has finished', async () => {
    const server = await startServer()
    const result = await server.speak('the queue returns nothing when it is empty')
    expect(result.content[0].text).toBe('spoken')
  })

  it('returns interrupted by the user when the interrupt phrase arrives during playback', async () => {
    const server = await startServer()
    // 30 words at 400 a minute is a 4.5 second stand-in sleep, still playing when the inject poll reads the line up to 500 ms later.
    const reply = Array(6).fill('the queue blocks on take').join(' ')
    const pending = server.speak(reply)
    server.utter('interrupt message')
    const result = await pending
    expect(result.content[0].text).toBe('interrupted by the user')
  })
})
