// With no -v, say speaks in the system voice from System Settings > Accessibility > Spoken Content. That is the only
// way to reach a downloaded Siri voice: `say -v '?'` lists none, and an unlisted name makes say fall back to a
// built-in voice. -r, -a, and the -- sentinel do not change the voice; say writes identical bytes either way.
// `say` plays on the macOS default output unless -a names another device; the server passes one, a cue never does.
export function buildSayArgs({ rate, voice, output = '' }, text) {
  const args = ['-r', String(rate)]
  if (voice) args.push('-v', voice)
  if (output) args.push('-a', output)
  args.push('--', text)
  return args
}
