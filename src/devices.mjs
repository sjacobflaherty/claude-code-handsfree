// The audio device rules: what bin/audiodev reports and which pairs settings.jsonc allows.

// bin/audiodev prints in=<name>, out=<name>, then one dev=<id>\t<uid>\t<dir>\t<name> line per device.
export function parseAudiodevOutput(text) {
  const lines = String(text).split('\n')
  const field = (key) => (lines.find((l) => l.startsWith(`${key}=`)) || '').slice(key.length + 1)
  const devices = lines
    .filter((l) => l.startsWith('dev='))
    .map((l) => {
      const [id, uid, dir, ...name] = l.slice(4).split('\t')
      return { id, uid, dir, name: name.join('\t') }
    })
  return { input: field('in'), output: field('out'), devices }
}

export function hasNameFragment(name, fragments) {
  const n = String(name).toLowerCase()
  return fragments.some((f) => n.includes(String(f).toLowerCase()))
}

// The verdict names the side because the input and the output can carry the same device name.
export function deviceVerdict({ allowedInputs, allowedOutputs }, { input, output }) {
  if (!allowedInputs.length) return { allowed: false, reason: 'unconfigured' }
  if (!input || !hasNameFragment(input, allowedInputs))
    return { allowed: false, reason: 'device', side: 'input', which: input || 'none' }
  const isOutputAllowed =
    allowedOutputs === 'same' ? output === input : Boolean(output) && hasNameFragment(output, allowedOutputs)
  if (!isOutputAllowed) return { allowed: false, reason: 'device', side: 'output', which: output || 'none' }
  return { allowed: true }
}

// With allowedOutputs "same" an output is usable only as the pair of that same input, so it is judged against allowedInputs.
export function allowedSides({ allowedInputs, allowedOutputs }, { name, dir }) {
  const outputList = allowedOutputs === 'same' ? allowedInputs : allowedOutputs
  return {
    asInput: dir !== 'out' && hasNameFragment(name, allowedInputs),
    asOutput: dir !== 'in' && hasNameFragment(name, outputList),
  }
}

function maskComments(text) {
  let masked = ''
  let state = 'code'
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    const next = text[i + 1]
    if (state === 'line') {
      masked += char === '\n' ? '\n' : ' '
      if (char === '\n') state = 'code'
    } else if (state === 'block') {
      if (char === '*' && next === '/') {
        masked += '  '
        i++
        state = 'code'
      } else masked += char === '\n' ? '\n' : ' '
    } else if (state === 'string') {
      masked += char
      if (char === '\\') {
        masked += next || ''
        i++
      } else if (char === '"') state = 'code'
    } else if (char === '"') {
      masked += char
      state = 'string'
    } else if (char === '/' && (next === '/' || next === '*')) {
      masked += '  '
      i++
      state = next === '/' ? 'line' : 'block'
    } else masked += char
  }
  return masked
}

export function setAllowedDevices(text, { inputs, outputs }) {
  const masked = maskComments(text)
  const input = /"allowedInputs"\s*:\s*\[[^\]]*\]/m.exec(masked)
  const output = /"allowedOutputs"\s*:\s*(\[[^\]]*\]|"same")/m.exec(masked)
  const replacements = [
    [input, `"allowedInputs": ${JSON.stringify(inputs)}`],
    [output, `"allowedOutputs": ${outputs ? JSON.stringify(outputs) : '"same"'}`],
  ]
    .filter(([match]) => match)
    .sort(([a], [b]) => b.index - a.index)
  let written = text
  for (const [match, replacement] of replacements)
    written = written.slice(0, match.index) + replacement + written.slice(match.index + match[0].length)
  return { text: written, changed: Boolean(input) }
}
