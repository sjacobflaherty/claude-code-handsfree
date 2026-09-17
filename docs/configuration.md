# Configuration

The two config files, which key goes in which one, precedence, adding a phrase, profiles, launch flags, and the voice. The example files describe every option; this page is the shape around them.

## The two files

`settings.jsonc` and `phrases.jsonc` sit at the root, both gitignored, each copied from its example (`cp settings.example.jsonc settings.jsonc`, `cp phrases.example.jsonc phrases.jsonc`). Each example carries every option the loader accepts as a four-line block: what it does, its default and allowed values, a `setting:` label, then the setting itself, commented out at that default so you uncomment the line to change it. The two device lists and the per-locale voice are live instead of commented, because `npm run setup` writes your answers into them. The loader refuses a key placed in the wrong file and names the right one. Run `npm run check` after an edit; it fails on a bad value and names the key.

- `settings.jsonc` is the machine: `profile`, the allowed and fallback devices, `deviceCheckIntervalMs`, `resumeOnDeviceChange`, turn ending (`silenceFallbackMs`, `sendOnFinal`), speech `rate`, `hearOnDeviceOnly`, `bargeIn`, `bargeInSameDeviceOnly`, the default `model` and `effort`, `speakLaunchCue`, `keepTranscript`, `log`, and the `advanced` timings.
- `phrases.jsonc` is the language: `locale`, `commandPrefix`, and `overrides.<locale>` holding `voice`, `hearLocale`, `commands`, `answers`, `numbers`, and `strings` (every sentence the server speaks).

Precedence, later wins: the shipped defaults, `settings.jsonc`, `phrases.jsonc`, `profiles/<name>/`, then launch flags.

## How phrases match

Phrases match the end of what you have said, ignoring case, punctuation, and accents. `locales/en.json` holds the shipped command table; each entry pairs the phrases that trigger it with the call it makes. `commandPrefix` puts a word or two in front of every command phrase, so `hey voice send message` sends and plain `send message` is ordinary speech; yes and no answers never take the prefix.

## Adding or changing a phrase

Each entry in the command table holds `say` (the phrases that trigger it) and `call` (one of send, interrupt, stop, pause, resume, clipboard, replay, switchModel, help), plus `args` for the calls that take any. An argument written as `"<text>"`, `"<number>"`, `"<model>"`, or `"<effort>"` is filled from the words after the phrase; any other value is fixed and used as written. Add entries under `overrides.<locale>.commands`: a key that matches a shipped entry replaces it, and a new key adds a command. `voice help` reads back the first phrase of every entry that is not a send.

```jsonc
"quiet": { "say": ["go quiet"], "call": "pause" },
"ship": { "say": ["ship it"], "call": "send", "args": { "text": "Commit and push." } },
```

The `numbers` block lists the words accepted after `replay voice`, keyed by the reply each word picks (so `"2": ["two", "to", "too"]`). A key you set replaces that number's whole list. The `answers` block holds the yes and no lists the same way.

## Profiles and launch flags

A profile is a folder `profiles/<name>/` with a `settings.jsonc` and/or `phrases.jsonc` holding only the keys it changes; `profiles/example/` shows the shape. Pick one with `--profile <name>` or `"profile"` in `settings.jsonc`. Launch flags override both files for one session: `--profile`, `--locale`, `--voice`, `--input`, `--output`, `--model`, `--effort`, and `--set KEY=VALUE`. `claude-code-handsfree --help` lists them and `--check` shows the resolved result.

## The voice

Leave `overrides.<locale>.voice` in `phrases.jsonc` empty and a session speaks in the system voice from System Settings > Accessibility > Spoken Content > System Voice, including a downloaded Siri voice, which `say -v '?'` never lists. Naming an Enhanced or Premium voice there replaces the system voice; it does not improve it. A name `say -v '?'` does not list makes `say` fall back to a built-in voice with no error, so run `npm run check` after a change: it prints which voice a session would speak with.

## Another language

`locale` picks `locales/<locale>.json`; `en` ships. A new language is a translated copy of `locales/en.json` under the new code, with `hearLocale` set to the recognizer locale `hear` should use. On-device recognition (`hearOnDeviceOnly: true`) covers Siri locales only.
