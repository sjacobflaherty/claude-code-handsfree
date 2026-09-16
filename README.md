# claude-code-handsfree

![macOS](https://img.shields.io/badge/platform-macOS-lightgrey) ![Node 20+](https://img.shields.io/badge/node-20%2B-green) ![Research preview](https://img.shields.io/badge/channels-research_preview-orange)

Hands-free voice conversation inside a Claude Code session. A local MCP server listens on your microphone, pushes what you say into the session as a message, and reads Claude's replies aloud through its `speak` tool. The session is a normal `claude` session with one server added, so your `CLAUDE.md`, skills, hooks, and MCP servers all apply, and it runs under your Claude subscription with no API key.

macOS only. Speech recognition is Apple's, through [`hear`](https://github.com/sveinbjornt/hear), and playback is `/usr/bin/say`. Everything loads per session from this folder; a plain `claude` session never starts the microphone, and nothing is written into `~/.claude`.

## Requirements

- A headset: one device that is both the microphone and the output, so the microphone cannot hear the replies. AirPods in this example, any headset works. Speakers with the built-in microphone are not supported: the microphone hears each reply, the reply becomes the next message, and the session answers itself. The shipped `allowedOutputs: "same"` refuses that pair.
- Claude Code signed in to your Claude subscription.
- Node 20 or later.
- The Xcode command line tools (`xcode-select --install`). Setup checks for them, stops when they are missing, and does not install them. The full Xcode app and Homebrew are not needed.
- `hear`, the speech recognizer. Setup downloads its author's signed build, checks the Developer ID signature, and keeps it in `bin/` inside this folder. No sudo. A `hear` already on your PATH is used instead when present.

## Install

```sh
git clone https://github.com/sjacobflaherty/claude-code-handsfree.git
cd claude-code-handsfree
npm run setup
```

Setup runs `npm install` itself when `node_modules` is missing, then opens with one question, run everything or choose sections, and works through six sections in order. A missing requirement in section 1 stops the run with the instruction to follow; every other problem is reported and the run continues. `--dry-run` previews all six sections without writing anything.

1. Check requirements: Node and the Xcode command line tools.
2. Install `hear`: download the signed build into `bin/`, verify its signature, done. Skipped when a `hear` is already on your PATH.
3. Install the app: `npm install` when it has not run yet, and `npm run build`, which compiles two helpers: `bin/audiodev`, which reads your default audio devices, and `bin/disclaim`, which starts `hear` as its own process so macOS asks permission for `hear` rather than for your terminal app.
4. Detect microphones. Setup lists your devices without opening any of them; the ones you tick become `allowedInputs` in `settings.jsonc`, copied from `settings.example.jsonc` when the file is missing, and the output stays `"same"` unless you pick otherwise. `--yes` ticks the default microphone and keeps `"same"`. Only those devices can ever drive a session.
5. Pick a voice. `System default`, the default choice, keeps the macOS system voice from System Settings > Accessibility > Spoken Content, which is the only way to get a Siri voice. To name a voice instead, answer yes when setup asks (the default is no); setup writes the name into `phrases.jsonc` when that file exists and has a live `voice` line, which the example ships, and it refuses any name `say -v '?'` does not list.
6. Add the shell command: a `claude-code-handsfree` function in `~/.zshrc` (or `~/.bashrc` under bash), between two marker lines so `--remove` can find it later. The function calls the `node` that ran setup by its absolute path, so it works in any shell whatever its PATH. Under fish, pass `--rc ~/.config/fish/config.fish`. `--name` picks another command name.

Each section asks `Run this now?` before it changes anything. Flags go after `--`: `npm run setup -- --yes` takes every default, `--dry-run` writes nothing, `--force` redoes sections that are already done, `--only 4,6` runs only those sections, `--verbose` prints the commands each section runs so you can run them yourself, and `--help` lists all of that. Setup ends by running the check below and printing two reminders: `cp phrases.example.jsonc phrases.jsonc` when you want to change the voice or the phrases, and `claude-code-handsfree --remove` to uninstall.

Setup never opens the microphone. The first session that listens starts `hear`, and macOS asks twice, once for Microphone and once for Speech Recognition. Allow both. Each dialog names `hear`, and the grant then holds in any terminal app, including the Cursor and VS Code terminals. If a session hears nothing, open System Settings > Privacy & Security > Microphone and check that `hear` is on, then do the same under Speech Recognition.

To prove the install without a headset, run the smoke test. It starts the server the way a session would, feeds it one typed utterance in place of the microphone, waits for it to arrive as a voice message, and has the server speak once with the audio replaced by a pause:

```sh
npm run smoke
```

Open a new terminal, or `source ~/.zshrc`, then run the check:

```sh
claude-code-handsfree --check
```

It prints the resolved config, the tool versions, every audio device with its default and allowed tags, and whether a session would listen or refuse and why.

### Launching without the shell function

The function runs `node <clone>/src/launch.mjs`, which starts `claude` with these flags. Replace `/path/to/claude-code-handsfree` with your clone folder:

```sh
claude \
  --mcp-config '{"mcpServers":{"voice":{"command":"node","args":["/path/to/claude-code-handsfree/src/voice-channel.mjs"]}}}' \
  --dangerously-load-development-channels server:voice \
  --plugin-dir /path/to/claude-code-handsfree/plugin \
  --allowedTools 'mcp__voice__*' \
  --model opus --effort high
```

`--mcp-config` loads the server for that session only. `--plugin-dir` loads the two hooks and the `/handsfree` skill. `--allowedTools` lets `speak` run without a permission prompt. `--dangerously-load-development-channels` is required while channels are a research preview. Started this way, the `--profile`, `--locale`, `--voice`, `--input`, `--output`, and `--set` flags are unavailable, model switching by voice does not work, and the hooks identify the session by its working directory instead of a session id. The settings files still apply.

## Use

Start a voice session inside the repository you want to work in:

```sh
claude-code-handsfree
claude-code-handsfree --model fable
claude-code-handsfree --profile example
```

Type the first message. Everything after that is hands-free. Claude speaks its reply, you talk back, and the server sends what you said when the transcript has not changed for six seconds (`silenceFallbackMs`) or when you say "send message". Apple's recognizer keeps updating the transcript for a few seconds after you stop, so the wait from your last word is longer than six. The terminal shows each message as `← voice: ...`, and you hear "Got it" when it is sent, before Claude has answered. Talking over a reply cuts it off when input and output are the same device, and a typed prompt cuts it off too.

Phrases match the end of what you have said, ignoring case, punctuation, and accents. `locales/en.json` holds the command table; each entry pairs the phrases that trigger it with the call it makes. Configure, below, covers adding your own entries.

| Say | Effect |
| --- | --- |
| `send message` | Send everything said since the last send. |
| `interrupt message` or `stop message` | Stop the reply that is playing and keep listening. |
| `use clipboard` | Attach the clipboard contents to the next message. |
| `replay voice`, `replay voice three`, `replay voice 3` | Read the last reply again, or the third most recent. The server keeps the last 10. |
| `pause session` | Keep listening but discard everything until `resume session`. The stop phrases and a yes or no still work. |
| `resume session` | End a pause. |
| `stop session`, `stop listening`, or `end session` | Stop listening. The session stays open for typing. |
| `yes`, `yeah`, `yep`, `approve`, `allow` | Approve a permission prompt that was read aloud. The last word decides: "sure, yes" approves, "yes please" does not. |
| `no`, `nope`, `deny`, `reject` | Deny it. The terminal dialog stays open too, and the first answer wins. |
| `switch model fable high` or `change model opus low` | Ask to restart the session on that model (opus, sonnet, haiku, fable) at that effort (low, medium, high, max), then confirm with yes. The effort word is required; say the model on its own and the server asks which effort, then takes that one word. See known limits. |
| `voice help` | Read the command list aloud. |

After a stop, type `start voice` or `/handsfree` to listen again. `/handsfree stop` stops listening, and `/handsfree input Headset` restarts it on a named microphone. `/handsfree devices` asks which allowed microphone and output to use and starts listening on the pair you pick, so you never type a device name. `/handsfree commands` lists the spoken phrases this install answers to, including any you changed in `phrases.jsonc`, and asking Claude how to use voice or what you can say gives the same answer.

## Configure

Two files at the root, both gitignored, each copied from its example. Each example carries every option the loader accepts as a four-line block (what it does, its default and allowed values, a `setting:` label, then the setting itself, commented out at that default so you uncomment the line to change it). The two device lists and the per-locale voice are live instead of commented, because `npm run setup` writes your answers into them. The loader refuses a key placed in the wrong file and names the right one.

- `settings.jsonc` is the machine: allowed and fallback devices, the device check interval, turn ending (`silenceFallbackMs`, `sendOnFinal`), speech `rate`, `hearOnDeviceOnly`, barge-in, the default `model` and `effort`, the log, and the `advanced` timings. Setup writes the device keys. Copy from `settings.example.jsonc` for the rest.
- `phrases.jsonc` is the language: `locale` (`en` ships; a new language is a copy of `locales/en.json` translated), `commandPrefix`, and per-locale `overrides` for the voice, the recognizer locale, the command table, the yes and no answers, the number words (keyed by the reply each word picks, so `"2": ["two", "to", "too"]`), and every sentence the server speaks. Copy from `phrases.example.jsonc`.

Each entry in the command table holds `say` (the phrases that trigger it) and `call` (one of send, interrupt, stop, pause, resume, clipboard, replay, switchModel, help), plus `args` for the calls that take any. An argument written as `"<text>"`, `"<number>"`, `"<model>"`, or `"<effort>"` is filled from the words after the phrase; any other value is fixed and used as written. Add entries under `overrides.<locale>.commands`: a key that matches a shipped entry replaces it, and a new key adds a command. `voice help` reads back the first phrase of every entry that is not a send.

```jsonc
"quiet": { "say": ["go quiet"], "call": "pause" },
"ship": { "say": ["ship it"], "call": "send", "args": { "text": "Commit and push." } },
```

A profile is a folder `profiles/<name>/` with a `settings.jsonc` and/or `phrases.jsonc` holding only the keys it changes; `profiles/example/` shows the shape. Pick one with `--profile <name>` or `"profile"` in `settings.jsonc`. Launch flags override both files for one session: `--profile`, `--locale`, `--voice`, `--input`, `--output`, `--model`, `--effort`, and `--set KEY=VALUE`. `claude-code-handsfree --help` lists them and `--check` shows the resolved result.

Leave `overrides.<locale>.voice` in `phrases.jsonc` empty and a session speaks in the system voice from System Settings > Accessibility > Spoken Content > System Voice, including a downloaded Siri voice, which `say -v '?'` never lists. Naming an Enhanced or Premium voice there replaces the system voice; it does not improve it. A name `say -v '?'` does not list makes `say` fall back to a built-in voice with no error, so run `npm run check` after a change: it prints which voice a session would speak with.

## Safety

- A fresh clone allows no microphone. Listening starts only when the default input matches an entry in `allowedInputs` and the default output passes `allowedOutputs` (`"same"` means the same device as the input). Otherwise the server says which device failed, or names `npm run setup` when the list is empty.
- Every two seconds the server re-reads both defaults. When either changes it stops listening, discards anything half heard, and says "Voice session stopped". It then listens again on the first pair that passes those same lists after two identical reads and says which device it moved to; `fallbackInput` narrows that to one pair, and `resumeOnDeviceChange: false` keeps the session stopped until you type `start voice`.
- Three device-check failures in a row stop the session, and so do three recognizer exits without a transcript within five seconds.
- Pause keeps the microphone open; stop closes it.
- A permission prompt can be approved by voice only while listening is active. Your Claude Code `deny` rules still apply to every tool call.
- Barge-in is armed only when input and output are one device (`bargeInSameDeviceOnly: true`), so speakers cannot cut the Mac off with its own voice. Set it to `false` to arm it on any pair.
- Audio leaves the Mac: the default recognizer is Apple's server (`hearOnDeviceOnly: false`). The log at `~/Library/Logs/claude-code-handsfree.log` holds the full text of every sent message; `log.includeSentText: false` keeps only lengths, and `log.file: ""` turns the file off.

## Uninstall

```sh
claude-code-handsfree --remove
```

It shows the shell function block and asks before deleting it, keeping a backup of the rc file, then asks about anything an older version wrote into `~/.claude`, and ends by printing the `rm -rf` for the clone folder, which it never runs. The log file, the two macOS permissions, and a downloaded voice stay; [docs/uninstall.md](docs/uninstall.md) gives the command or System Settings path for each. The flags go straight after `--remove`: `claude-code-handsfree --remove --dry-run` prints what it would do, `--remove --yes` answers yes to everything, and `--remove --rc <file>` names another rc file. `npm run remove -- --yes` runs the same script once the function is gone.

## Known limits

- Channels are a research preview. The `--dangerously-load-development-channels` flag and the notification schema may change between Claude Code releases. If launch fails, check code.claude.com/docs/en/channels against `src/launch.mjs`.
- `claude --dangerously-load-development-channels` shows a full-screen dialog at every launch, including the relaunch after a spoken model switch, that only Enter dismisses and no voice command can answer, so the launcher speaks a cue (`strings.launchCue` on a first launch, behind the `speakLaunchCue` setting, and `strings.launchCueSwitch` on the model-switch relaunch) telling a hands-free user to press Enter.
- The first half of a long spoken paragraph has been lost in a session. The cause is not yet found. The log records `hear partial` lengths and `permission prompt discarded text` lines, which are the two remaining suspects.
- Model switching by voice (`switch model`) is not verified in a live session. `--model` at launch and `/model` work.
- Automatic send waits six seconds after the transcript last changed, plus the recognizer's tail of a few seconds.
- No echo cancellation. Nothing filters the Mac's own voice out of what the microphone hears, so the input and the output must not be able to hear each other. A headset is the supported setup; a speakers pair only works with the microphone muted while the Mac talks, and that is not built.
- Apple documents a one-minute limit per recognition request on its server recognizer, but it has not been seen here: a live utterance of 129 seconds and 1074 characters arrived whole in the default mode, and an 86-second recording of 1588 characters transcribed in full through `hear -i` in both modes. On-device mode (`hearOnDeviceOnly: true`) supports Siri locales only.
- Claude can answer in text instead of calling `speak`, most often on the first turn after `/clear`. The Stop hook then reads the text aloud, and that reading cannot be replayed.
- A channel registers only at launch. A plain `claude` session cannot become a voice session; restart with `claude-code-handsfree`.
- The install has run on one Mac so far.

MIT license, see [LICENSE](LICENSE). Speech recognition is [hear](https://github.com/sveinbjornt/hear) by Sveinbjorn Thordarson, and the barge-in echo guard follows [Hermes Agent](https://github.com/NousResearch/hermes-agent).
