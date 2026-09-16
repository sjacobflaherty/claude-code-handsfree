import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseJsonc } from '../src/config.mjs'
import { allowedSides, deviceVerdict, parseAudiodevOutput, setAllowedDevices } from '../src/devices.mjs'

describe('parseAudiodevOutput', () => {
  it('reads the defaults and one device per dev line, keeping tabs inside a name', () => {
    const out = [
      'in=Wireless Headset',
      'out=External Speakers',
      'dev=1\tUID1\tboth\tWireless Headset',
      'dev=2\tUID2\tout\tExternal\tSpeakers',
      '',
    ].join('\n')
    expect(parseAudiodevOutput(out)).toEqual({
      input: 'Wireless Headset',
      output: 'External Speakers',
      devices: [
        { id: '1', uid: 'UID1', dir: 'both', name: 'Wireless Headset' },
        { id: '2', uid: 'UID2', dir: 'out', name: 'External\tSpeakers' },
      ],
    })
  })

  it('reports empty defaults and no devices for empty output', () => {
    expect(parseAudiodevOutput('')).toEqual({ input: '', output: '', devices: [] })
  })
})

describe('setAllowedDevices', () => {
  const example = () => readFileSync(new URL('../settings.example.jsonc', import.meta.url), 'utf8')

  it('writes the chosen microphone into the shipped example file', () => {
    const { text, changed } = setAllowedDevices(example(), { inputs: ['Wireless Headset'], outputs: null })
    expect(changed).toBe(true)
    const config = parseJsonc(text)
    expect(config.allowedInputs).toEqual(['Wireless Headset'])
    expect(config.allowedOutputs).toBe('same')
  })

  it('writes a separate output list for a microphone that cannot play audio', () => {
    const { text } = setAllowedDevices(example(), { inputs: ['USB Microphone'], outputs: ['External Speakers'] })
    const config = parseJsonc(text)
    expect(config.allowedInputs).toEqual(['USB Microphone'])
    expect(config.allowedOutputs).toEqual(['External Speakers'])
  })

  it('changes the settings and not the comments that show example values', () => {
    const { text } = setAllowedDevices(example(), { inputs: ['Wireless Headset'], outputs: null })
    const comments = text.split('\n').filter((l) => l.trim().startsWith('//'))
    expect(comments.join('\n')).not.toContain('Wireless Headset')
    expect(comments.length).toBe(
      example()
        .split('\n')
        .filter((l) => l.trim().startsWith('//')).length,
    )
  })

  it('writes a hand-edited file that keeps the whole object on one line', () => {
    const { text, changed } = setAllowedDevices('{ "rate": 190, "allowedInputs": [], "allowedOutputs": "same" }\n', {
      inputs: ['Wireless Headset'],
      outputs: null,
    })
    expect(changed).toBe(true)
    expect(parseJsonc(text).allowedInputs).toEqual(['Wireless Headset'])
  })

  it('reports that it wrote nothing when the file has no allowedInputs to replace', () => {
    const original = '{\n  "rate": 190,\n}\n'
    const { text, changed } = setAllowedDevices(original, { inputs: ['Wireless Headset'], outputs: null })
    expect(changed).toBe(false)
    expect(text).toBe(original)
  })
})

describe('deviceVerdict', () => {
  const headset = { input: 'Wireless Headset', output: 'Wireless Headset' }

  it('allows a matching input when the output is the same device', () => {
    expect(deviceVerdict({ allowedInputs: ['headset'], allowedOutputs: 'same' }, headset)).toEqual({ allowed: true })
  })

  it('matches a name fragment whatever its case', () => {
    expect(deviceVerdict({ allowedInputs: ['WIRELESS'], allowedOutputs: 'same' }, headset).allowed).toBe(true)
  })

  it('refuses an input that is on no list and names it', () => {
    const v = deviceVerdict(
      { allowedInputs: ['Wireless Headset'], allowedOutputs: 'same' },
      { input: 'Built-in Microphone', output: 'Built-in Microphone' },
    )
    expect(v).toEqual({ allowed: false, reason: 'device', side: 'input', which: 'Built-in Microphone' })
  })

  it('refuses an output that is not the input when allowedOutputs is "same"', () => {
    const v = deviceVerdict(
      { allowedInputs: ['headset'], allowedOutputs: 'same' },
      { input: 'Wireless Headset', output: 'External Speakers' },
    )
    expect(v).toEqual({ allowed: false, reason: 'device', side: 'output', which: 'External Speakers' })
  })

  it('allows a listed output that is not the input device', () => {
    const v = deviceVerdict(
      { allowedInputs: ['USB Microphone'], allowedOutputs: ['External Speakers'] },
      { input: 'USB Microphone', output: 'External Speakers' },
    )
    expect(v).toEqual({ allowed: true })
  })

  it('blames the output when both devices share a name and only the output list rejects it', () => {
    const v = deviceVerdict(
      { allowedInputs: ['USB Microphone'], allowedOutputs: ['External Speakers'] },
      { input: 'USB Microphone', output: 'USB Microphone' },
    )
    expect(v).toEqual({ allowed: false, reason: 'device', side: 'output', which: 'USB Microphone' })
  })

  it('names "none" when a device is missing altogether', () => {
    expect(deviceVerdict({ allowedInputs: ['headset'], allowedOutputs: 'same' }, { input: '', output: '' }).which).toBe(
      'none',
    )
  })

  it('refuses every device when allowedInputs is empty, without blaming a device', () => {
    const v = deviceVerdict({ allowedInputs: [], allowedOutputs: 'same' }, headset)
    expect(v).toEqual({ allowed: false, reason: 'unconfigured' })
  })
})

describe('allowedSides', () => {
  const lists = { allowedInputs: ['Wireless Headset'], allowedOutputs: ['External Speakers'] }

  it('judges a device on the side its direction allows', () => {
    expect(allowedSides(lists, { name: 'Wireless Headset', dir: 'in' })).toEqual({ asInput: true, asOutput: false })
    expect(allowedSides(lists, { name: 'External Speakers', dir: 'out' })).toEqual({ asInput: false, asOutput: true })
  })

  it('judges both sides of a device that does both', () => {
    expect(allowedSides(lists, { name: 'Wireless Headset', dir: 'both' })).toEqual({ asInput: true, asOutput: false })
  })

  it('judges an output against the input list when allowedOutputs is "same"', () => {
    const same = { allowedInputs: ['Wireless Headset'], allowedOutputs: 'same' }
    expect(allowedSides(same, { name: 'Wireless Headset', dir: 'both' })).toEqual({ asInput: true, asOutput: true })
    expect(allowedSides(same, { name: 'External Speakers', dir: 'out' })).toEqual({ asInput: false, asOutput: false })
  })

  it('allows nothing while allowedInputs is empty', () => {
    const empty = { allowedInputs: [], allowedOutputs: 'same' }
    expect(allowedSides(empty, { name: 'Wireless Headset', dir: 'both' })).toEqual({ asInput: false, asOutput: false })
  })
})
