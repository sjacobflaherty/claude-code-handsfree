import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EFFORT_WORDS, MODEL_WORDS } from '../src/config.mjs'
import {
  commandList,
  fillTemplate,
  matchCommand,
  normalizeSpokenText,
  stripTrailingPhrase,
  trailingPhrase,
} from '../src/phrases.mjs'

const EN = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'))
// The locale file keys each word list by the reply it picks; the matcher reads the other direction.
const EN_NUMBERS = Object.fromEntries(
  Object.entries(EN.numbers).flatMap(([n, words]) => words.map((word) => [word, Number(n)])),
)

describe('normalize', () => {
  it('strips accents so an accented transcript matches an unaccented phrase', () => {
    expect(normalizeSpokenText('Sí, ayúda vocal')).toBe('si ayuda vocal')
  })

  it('lowercases, drops punctuation, and collapses the gaps it leaves', () => {
    expect(normalizeSpokenText('Send, message!!  Now?')).toBe('send message now')
  })

  it('keeps apostrophes and digits, which are part of words the recognizer writes', () => {
    expect(normalizeSpokenText("Don't stop -- replay voice 3")).toBe("don't stop replay voice 3")
  })
})

describe('trailingPhrase', () => {
  it('matches a phrase at the end of the transcript and returns it normalized', () => {
    expect(trailingPhrase('what does take return, send message', ['send message'])).toBe('send message')
  })

  it('returns null when the phrase is not at the end', () => {
    expect(trailingPhrase('send message when I say so', ['send message'])).toBe(null)
  })

  it('matches a transcript that is the phrase and nothing else', () => {
    expect(trailingPhrase('send message', ['send message'])).toBe('send message')
  })

  it('matches on a word boundary, so a longer word ending in the phrase does not count', () => {
    expect(trailingPhrase('resend message', ['send message'])).toBe(null)
  })

  it('ignores case and punctuation on both sides', () => {
    expect(trailingPhrase('ok then... SEND MESSAGE!', ['Send, message'])).toBe('send message')
  })

  it('ignores accents on both sides, so an unaccented transcript still matches', () => {
    expect(trailingPhrase('vale, ayuda vocal', ['ayuda vocal'])).toBe('ayuda vocal')
    expect(trailingPhrase('vale, ayúda vocal', ['ayuda vocal'])).toBe('ayuda vocal')
  })

  it('takes the first phrase of the group that matches', () => {
    expect(trailingPhrase('that is wrong, stop message', ['interrupt message', 'stop message'])).toBe('stop message')
  })
})

describe('matchCommand', () => {
  const MODELS = { opus: 'opus', fable: 'fable', fables: 'fable' }
  const EFFORTS = { low: 'low', high: 'high', maximum: 'max' }
  const WORDS = { numbers: EN_NUMBERS, models: MODELS, efforts: EFFORTS }
  const match = (text, commands = EN.commands, words = WORDS) => matchCommand(text, commandList(commands), words)

  it('names the entry, the phrase that matched, and the call it makes', () => {
    expect(match('what does take return, send message')).toMatchObject({
      key: 'send',
      call: 'send',
      phrase: 'send message',
    })
  })

  it('matches nothing when no phrase ends the transcript', () => {
    expect(match('send message when I say so')).toBe(null)
  })

  it('takes the longest phrase, so a shorter one cannot swallow a command that ends the same way', () => {
    const commands = {
      stop: { say: ['stop session'], call: 'stop' },
      quiet: { say: ['session'], call: 'pause' },
    }
    expect(match('stop session', commands).call).toBe('stop')
  })

  it('fills the replay index from the number word said after the phrase', () => {
    expect(match('replay voice').args.n).toBe(1)
    expect(match('replay voice three').args.n).toBe(3)
    expect(match('replay voice 3').args.n).toBe(3)
  })

  it('accepts the homophones the locale file lists, which is what the recognizer often writes', () => {
    for (const [text, n] of [
      ['replay voice to', 2],
      ['replay voice too', 2],
      ['replay voice for', 4],
      ['replay voice ate', 8],
      ['replay voice won', 1],
    ])
      expect(match(text).args.n).toBe(n)
  })

  it('matches no replay when a word that is not a number follows the phrase', () => {
    expect(match('replay voice banana')).toBe(null)
    expect(match('replay voice later, I mean it')).toBe(null)
  })

  it('reads the number words of whatever locale it is given', () => {
    const commands = { replay: { say: ['repetir voz'], call: 'replay', args: { n: '<number>' } } }
    expect(match('repetir voz dos', commands, { numbers: { uno: 1, dos: 2 } }).args.n).toBe(2)
  })

  it('fills the model and the effort from the two words said after the phrase', () => {
    expect(match('switch model fable low').args).toEqual({ model: 'fable', effort: 'low' })
    expect(match('change model fables maximum').args).toEqual({ model: 'fable', effort: 'max' })
  })

  it('reads "below" as the effort low, which is what the recognizer writes for it', () => {
    const words = { numbers: EN_NUMBERS, models: MODEL_WORDS, efforts: EFFORT_WORDS }
    expect(match('switch model fable below', EN.commands, words).args).toEqual({ model: 'fable', effort: 'low' })
  })

  it('leaves the model empty while only the phrase has been said, and the effort empty without that word', () => {
    expect(match('switch model').args).toEqual({ model: '', effort: '' })
    expect(match('switch model fable').args).toEqual({ model: 'fable', effort: '' })
  })

  it('keeps an argument the entry fixes and asks for no word to fill it', () => {
    const commands = {
      'use fable': { say: ['use fable'], call: 'switchModel', args: { model: 'fable', effort: 'low' } },
      daily: { say: ['daily standup'], call: 'send', args: { text: 'Summarize yesterday' } },
    }
    expect(match('ok, use fable', commands).args).toEqual({ model: 'fable', effort: 'low' })
    expect(match('daily standup', commands).args).toEqual({ text: 'Summarize yesterday' })
  })
})

describe('stripTrailingPhrase', () => {
  it('removes the phrase and the punctuation that ran into it', () => {
    expect(stripTrailingPhrase('What does take return, send message', 'send message')).toBe('What does take return')
  })

  it('keeps the casing and punctuation of everything before the phrase', () => {
    expect(stripTrailingPhrase("Fix the bug in take(). It's wrong! Send message!", 'send message')).toBe(
      "Fix the bug in take(). It's wrong",
    )
  })

  it('matches the phrase through accents, so an accented transcript loses it too', () => {
    expect(stripTrailingPhrase('Vale, ayúda vocal', 'ayuda vocal')).toBe('Vale')
  })

  it('returns the transcript when the phrase is not at the end', () => {
    expect(stripTrailingPhrase('send message now', 'send message')).toBe('send message now')
  })

  it('returns the transcript when it is shorter than the phrase', () => {
    expect(stripTrailingPhrase('message', 'send message')).toBe('message')
  })
})

describe('fillTemplate', () => {
  it('fills the placeholders a locale string uses', () => {
    expect(fillTemplate('Nothing to replay at {n}.', { n: 3 })).toBe('Nothing to replay at 3.')
  })

  it('leaves a placeholder alone when nothing was given for it', () => {
    expect(fillTemplate('Switched to {input}, output {output}.', { input: 'Headset' })).toBe(
      'Switched to Headset, output {output}.',
    )
  })
})
