# Configuration

The two config files, how spoken phrases match, and how to add your own. Then profiles, the voice, and another language.

## Copying the two config files

Copy each from its example:

```sh
cp settings.example.jsonc settings.jsonc
cp phrases.example.jsonc phrases.jsonc
```

Both are gitignored, so a pull never touches them. `settings.jsonc` is the machine: devices, timing, model. `phrases.jsonc` is the language: voice, commands, and every sentence the server speaks.

Every option is documented in the example file, commented out at its default. Uncomment a line to change it. If you put a key in the wrong file, the loader tells you which file it belongs in. Run `npm run check` after an edit; it fails on a bad value and names the key.

## Speaking a command

A phrase matches the end of what you said, ignoring case, punctuation, and accents. So "okay, send message" sends.

If you'd like an activation phrase, set `commandPrefix`. It puts a word or two in front of every command, so "hey voice send message" sends and plain "send message" is ordinary speech. Yes and no never take the prefix.

## Adding or changing a phrase

To add a spoken command or change what an existing one says, edit the `commands` block in `phrases.jsonc`. Each command has `say`, the phrases that trigger it, and `call`, what it does. A key that matches a shipped command replaces it; a new key adds one.

```jsonc
"quiet": { "say": ["go quiet"], "call": "pause" },
"ship": { "say": ["ship it"], "call": "send", "args": { "text": "Commit and push." } },
```

The example file lists the nine calls and which arguments each takes. An argument set to `"<text>"`, `"<number>"`, `"<model>"`, or `"<effort>"` is filled from whatever you say after the phrase; any other value is used as written. `voice help` reads the first phrase of every command except send.

To change which words count as yes or no, edit `answers`. To change the words accepted after `replay voice`, edit `numbers`. Setting one key replaces that key's whole list.

## Using a profile or a launch flag

To keep a second set of settings, make a folder `profiles/<name>/` with a `settings.jsonc`, a `phrases.jsonc`, or both, holding only the keys that differ. `profiles/example/` shows the shape. Use it with `--profile <name>`, or set `"profile"` in `settings.jsonc` to make it the default.

Launch flags change one session only and win over both files: `--profile`, `--locale`, `--voice`, `--input`, `--output`, `--model`, `--effort`, and `--set KEY=VALUE` for anything else. `claude-code-handsfree --help` lists them, and `--check` shows what a session would use.

## Changing the voice

Replies use the macOS system voice unless you name one. Leave `voice` empty in `phrases.jsonc` and replies use the voice set in System Settings > Accessibility > Spoken Content. That is the only way to get a Siri voice. To use another voice, put a name from `say -v '?'` there. A name not on that list falls back to a built-in voice with no error. Run `npm run check` after a change; it prints the voice a session would use.

## Running in another language

To run in another language, translate `locales/en.json` into `locales/<code>.json` and set `locale` to that code in `phrases.jsonc`. The copy carries its own `hearLocale`, the language hear listens in. On-device recognition (`hearOnDeviceOnly: true`) works for Siri languages only.
