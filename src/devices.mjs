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

// Each pattern starts at a line with no / before the key, so the example value inside a // comment is never the one rewritten.
export function setAllowedDevices(text, { inputs, outputs }) {
  const written = text
    .replace(/^([^\n/]*)"allowedInputs"\s*:\s*\[[^\]]*\]/m, `$1"allowedInputs": ${JSON.stringify(inputs)}`)
    .replace(
      /^([^\n/]*)"allowedOutputs"\s*:\s*(\[[^\]]*\]|"same")/m,
      `$1"allowedOutputs": ${outputs ? JSON.stringify(outputs) : '"same"'}`,
    )
  return { text: written, changed: /^[^\n/]*"allowedInputs"\s*:\s*\[[^\]]*\]/m.test(text) }
}
