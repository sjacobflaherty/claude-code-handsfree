export function normalizeSpokenText(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function matchTrailing(text, phrases, { number = null } = {}) {
  const n = normalizeSpokenText(text)
  const words = n.split(' ')
  const last = words[words.length - 1]
  const head = words.slice(0, -1).join(' ')
  let numberValue
  if (number) numberValue = /^\d+$/.test(last) ? parseInt(last, 10) : number[last]
  for (const p of phrases) {
    const np = normalizeSpokenText(p)
    if (n === np || n.endsWith(` ${np}`)) return { phrase: np, n: 1 }
    if (numberValue !== undefined && (head === np || head.endsWith(` ${np}`))) return { phrase: np, n: numberValue }
  }
  return null
}

export function trailingPhrase(text, phrases) {
  return matchTrailing(text, phrases)?.phrase ?? null
}

// An argument set to its placeholder is filled from the words said after the phrase; any other value is fixed.
export const ARG_PLACEHOLDERS = { text: '<text>', n: '<number>', model: '<model>', effort: '<effort>' }

// One item per spoken phrase, longest phrase first, so "stop message" wins over a shorter "stop".
export function commandList(commands) {
  const items = []
  for (const [key, entry] of Object.entries(commands)) {
    for (const phrase of entry.say) {
      items.push({
        key,
        call: entry.call,
        args: entry.args ?? {},
        phrase,
        words: normalizeSpokenText(phrase).split(' ').filter(Boolean).length,
      })
    }
  }
  return items.sort((a, b) => b.words - a.words)
}

function matchItem(text, item, { numbers, models, efforts }) {
  const args = { ...item.args }
  let tail = text
  if (args.effort === ARG_PLACEHOLDERS.effort) {
    const words = normalizeSpokenText(tail).split(' ')
    const effort = efforts[words[words.length - 1]] || ''
    args.effort = effort
    if (effort) tail = words.slice(0, -1).join(' ')
  }
  if (args.model === ARG_PLACEHOLDERS.model) {
    const hit = matchTrailing(tail, [item.phrase], { number: models })
    if (!hit) return null
    // n is 1 when the phrase itself ends the transcript, which means the model word has not arrived yet.
    return { ...item, args: { ...args, model: hit.n === 1 ? '' : hit.n } }
  }
  if (args.n === ARG_PLACEHOLDERS.n) {
    const hit = matchTrailing(tail, [item.phrase], { number: numbers })
    if (!hit) return null
    return { ...item, args: { ...args, n: hit.n } }
  }
  if (!trailingPhrase(tail, [item.phrase])) return null
  return { ...item, args }
}

export function matchCommand(text, list, { numbers = {}, models = {}, efforts = {} } = {}) {
  for (const item of list) {
    const hit = matchItem(text, item, { numbers, models, efforts })
    if (hit) return hit
  }
  return null
}

export function stripTrailingPhrase(text, phrase) {
  const phraseWords = normalizeSpokenText(phrase).split(' ').filter(Boolean)
  const tokens = text.split(/(\s+)/)
  const wordIdx = []
  for (let i = 0; i < tokens.length; i++) if (tokens[i].trim()) wordIdx.push(i)
  if (wordIdx.length < phraseWords.length) return text.trim()
  for (let k = 0; k < phraseWords.length; k++) {
    const tok = tokens[wordIdx[wordIdx.length - 1 - k]]
    if (normalizeSpokenText(tok) !== phraseWords[phraseWords.length - 1 - k]) return text.trim()
  }
  const cut = wordIdx[wordIdx.length - phraseWords.length]
  return tokens
    .slice(0, cut)
    .join('')
    .replace(/[\s,.!?]+$/, '')
    .trim()
}

export function fillTemplate(template, values) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in values ? String(values[k]) : m))
}
