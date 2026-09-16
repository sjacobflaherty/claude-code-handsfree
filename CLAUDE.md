# claude-code-handsfree

Hands-free voice conversation inside a Claude Code session on macOS. `src/voice-channel.mjs` is a local MCP server that listens on the microphone through `hear`, pushes each utterance into the session as a channel message, and reads replies aloud through its `speak` tool with `/usr/bin/say`. `src/launch.mjs` starts `claude` with that server, a plugin holding two hooks and the `/handsfree` skill, and the `mcp__voice__*` allow rule, for that session only. Nothing is written into `~/.claude`. The one thing outside this folder is the `claude-code-handsfree` shell function that `npm run setup` adds to the rc file.

## Layout

| Path | Holds |
| --- | --- |
| `src/` | The code: the server, the launcher, `cli.mjs` (what every command shares, after clig.dev: `--help` led by examples, six-wide `ok`/`FAIL`/`WARN` rows, colour only on a TTY, `--verbose`, a one-line crash message), `config.mjs` (loader and validation), `devices.mjs` (parsing `bin/audiodev` output and the allowed-device rules), `sessions.mjs` (which servers run and which holds `state/active.json`), `say.mjs` (`buildSayArgs`, the one place `say` arguments are built), `phrases.mjs` (phrase matching), `hear.mjs` (the signed `hear` release, its download and verification, which `hear` a session runs), `setup.mjs`, `remove.mjs`, `check.mjs`, `commands.mjs` (list of the spoken commands as resolved), `rc-block.mjs`, `audiodev.swift`, `disclaim.c`. |
| `plugin/` | The Claude Code plugin loaded per session with `--plugin-dir`. `hooks/hooks.json` registers `hooks/stop-speech.py` on UserPromptSubmit and `hooks/speak-reply.py` on Stop; `skills/handsfree/SKILL.md` is `/handsfree`. |
| `locales/` | One JSON file per language, `en` ships: the command table, the yes and no answers, number words, every sentence the server speaks, the recognizer locale, the default voice. |
| `profiles/` | One folder per profile with a `settings.jsonc` and/or `phrases.jsonc` holding only the keys it changes. `example/` is committed, the rest are gitignored. |
| `docs/` | User guides, listed below. |
| `test/` | Vitest suites plus two helpers, `fixture-root.mjs` and `fixture-server.mjs`. |
| `bin/` | `audiodev` and `disclaim`, built from `src/audiodev.swift` and `src/disclaim.c` by `npm run build`, and `hear`, the author's signed build that `npm run setup` downloads and verifies (`src/hear.mjs` holds the URL and the signing team; a session uses `bin/hear` when present, else `hear` from PATH). Gitignored. |
| `state/` | Runtime state the server writes: `active.json` (the flag both hooks read) and `next-model`. Gitignored. |
| root | `settings.example.jsonc` and `phrases.example.jsonc` (committed, every key described), `settings.jsonc` and `phrases.jsonc` (the user's copies, gitignored), `package.json`, `biome.jsonc`, `vitest.config.mjs`, `.github/workflows/ci.yml`. |

## Commands

| Command | Does |
| --- | --- |
| `npm run setup` | Runs `npm install` first when `node_modules` is missing, then an interactive install in six sections: requirements, `hear` (the signed download into `bin/`), `npm install` and build, microphones (lists the devices without opening any, writes `allowedInputs` into `settings.jsonc`, keeps `allowedOutputs: "same"` under `--yes`; the macOS permission dialogs come with the first session), voice, shell function (calls the absolute `node` that ran setup). Flags after `--`: `--yes`, `--dry-run`, `--force`, `--only N[,N]`, `--verbose` (the commands each section runs), `--name <command>`, `--rc <file>`, `--help`. |
| `npm run smoke` | Starts the server with `CLAUDE_VOICE_INJECT` and `CLAUDE_VOICE_SILENT`, sends one utterance, waits for the channel event, calls `speak`, exit 0 on three ok lines. Proves an install without a microphone or a session. |
| `npm run check` | Read-only. `ok` and `FAIL` rows for the config, the tools (including the claude login), whether a session would listen or refuse and on which devices, the voice a session would speak with, the plugin files, running sessions, and what is outside this folder, then one closing line with the next command. `--verbose` adds the `note` rows: every setting, device, and voice. Exit 1 on any FAIL. |
| `npm run commands` | Read-only. The spoken commands a session answers to, each with its phrases, the call it makes and what that call does, then the yes and no answers, the number words after the replay phrase, and the model and effort words. Resolved the way the server resolves them (locale file, `phrases.jsonc`, profile, launch flags); `/handsfree commands` runs it in a session. |
| `npm run build` | Compiles `bin/audiodev` with `swiftc` and `bin/disclaim` with `clang`. |
| `npm run devices` | Prints the default input and output and every audio device. |
| `npm run launch` | What the shell function runs. |
| `npm run remove` | Uninstall. Flags after `--`: `--yes`, `--dry-run`, `--rc <file>`. |
| `npm run lint` | `biome check` over `src/`, `test/`, and `vitest.config.mjs`. The formatter is on; `npx biome check --write` applies it. |
| `npm test` | `vitest run`: 284 tests in about 40 seconds, no microphone needed. |

`claude-code-handsfree [voice flags] [claude flags]` runs `node src/launch.mjs`. Voice flags, each for one session: `--profile NAME`, `--locale CODE`, `--voice NAME`, `--input FRAGMENT`, `--output FRAGMENT`, `--model NAME`, `--effort LEVEL`, `--set KEY=VALUE`. `--check` runs `src/check.mjs`, `--remove` runs `src/remove.mjs`, `--help` prints the list. Every other argument goes to `claude`. Model and effort come from `settings.jsonc`; empty, the shipped value, passes no flag and Claude Code uses its own default.

CI (`.github/workflows/ci.yml`) runs `npm run build`, `npx biome check`, and `npx vitest run` on macOS with Node 20 on every push and pull request. Changes reach `main` through a pull request, squash-merged once that check is green.

In a session the server's tools are `speak`, `voice_start`, `voice_stop`, and `voice_status`. `/handsfree` checks and starts listening, `/handsfree stop` stops it, `/handsfree input <name>` restarts it on a named microphone, `/handsfree devices` offers the allowed devices through `AskUserQuestion` and starts on the pair the user picks; typing `start voice` does the same as `/handsfree`. `/handsfree commands`, or any question about how to use voice or what to say, lists the spoken commands from the resolved config (the skill runs `src/commands.mjs` when it loads), and saying "voice help" reads them aloud. `voice_status` reports each device with its direction, whether it is allowed on each side, and `outputRule`, which is `same-as-input` when `allowedOutputs` is `"same"`. A voice message arrives as `← voice: ...`; answer it through `speak` and write no text after the tool returns.

## Files you may edit for the user

Edit on request: `settings.jsonc`, `phrases.jsonc`, and `profiles/<name>/settings.jsonc` or `profiles/<name>/phrases.jsonc`. When the file is missing, copy the example first (`cp settings.example.jsonc settings.jsonc`, `cp phrases.example.jsonc phrases.jsonc`). The example file holds every option as a four-line block (description, default and allowed values, a `setting:` label, then the setting itself, commented out at its default except the two device lists and the per-locale voice, which `npm run setup` writes into), so read that block and uncomment its line rather than writing a key from memory. Machine keys (`profile`, devices, timing, `rate`, `hearOnDeviceOnly`, `bargeIn`, `bargeInSameDeviceOnly`, `model`, `effort`, `keepTranscript`, `log`, `advanced`) go in `settings.jsonc`. Language keys (`locale`, `commandPrefix`, and `overrides.<locale>` with `voice`, `hearLocale`, `commands`, `answers`, `numbers`, `strings`) go in `phrases.jsonc`. Each `commands` entry holds `say`, `call`, and optional `args`; the calls are send, interrupt, stop, pause, resume, clipboard, replay, switchModel, and help, and an override entry replaces the shipped entry with the same key. Each `numbers` key is the reply its words pick, holding every word heard for that reply, and an override replaces that number's whole list. The loader refuses a key in the wrong file and names the right one. Precedence, later wins: defaults, `settings.jsonc`, `phrases.jsonc`, `profiles/<name>/`, launch flags. Run `npm run check` after an edit; it fails on a bad value and names the key.

Do not edit unless asked: `src/`, `plugin/`, `locales/`, `test/`, the two example files, `biome.jsonc`, `vitest.config.mjs`, `package.json`. Never write into `~/.claude` or the rc file; `npm run setup` and `--remove` are the only code that touches the rc file. Never edit `state/`.

## Microphone rules

- Listening starts only when the default input matches an entry in `allowedInputs` and the default output passes `allowedOutputs` (`"same"`, or a list). `allowedInputs` ships empty, so a fresh clone refuses. Naming a device is the user's decision; do not add the built-in microphone unprompted.
- Every device rule is a setting with a safe default and an override. Never hardcode which input or output a feature works with.
- `bargeInSameDeviceOnly: true` arms barge-in only when input and output are one device. With speakers the microphone hears `say`.
- Every `deviceCheckIntervalMs` the server re-reads both defaults. A change stops listening and discards the transcript. `resumeOnDeviceChange` (default true) then has it watch the devices and listen again on the first pair that reads the same `advanced.fallbackSettleChecks` times in a row and passes both allowed lists, speaking `strings.switchedDevice`; `fallbackInput` narrows that resume to one pair, and `resumeOnDeviceChange: false` leaves the session stopped.
- One server listens per Mac: `state/active.json` holds the listening server's pid, a second server that finds a live pid there refuses to listen and speaks `anotherSession` (a dead pid is ignored), every stop clears the flag, and a server exits with its session, killing `hear` and clearing the flag within one `deviceCheckIntervalMs` of stdin closing or the parent process disappearing.
- The server starts `hear` through `bin/disclaim`, which makes `hear` its own responsible process for macOS permissions, so the Microphone and Speech Recognition entries in System Settings are named `hear`. Without it, a `hear` started under an app whose Info.plist lacks `NSSpeechRecognitionUsageDescription` (Cursor, VS Code) is killed with SIGABRT before any dialog; the log shows that as three `hear exit` lines with `"signal":"SIGABRT"` followed by `hear failing`.
- A spoken yes to a permission prompt works only while listening. The user's `deny` rules still apply to every tool call.
- The log (`log.file`, default `~/Library/Logs/claude-code-handsfree.log`) records every sent message in full unless `log.includeSentText` is false. Read it when a message goes missing or arrives truncated.

## Testing without a microphone

| Variable | Effect |
| --- | --- |
| `CLAUDE_VOICE_INJECT=<file>` | The server skips the device guard and `hear` and polls that file instead. Each newline-ended line appended after start is one utterance, and every phrase works. |
| `CLAUDE_VOICE_SILENT=1` | The server runs a `sleep` of the same length instead of `say` and logs the text as `silent say`. |
| `CLAUDE_VOICE_ROOT=<folder>` | The server and both hooks treat that folder as this one: config files, `locales/`, `bin/audiodev` and `bin/disclaim`, `state/`. `src/setup.mjs` and `src/check.mjs` read and write their config files there too, which is how the tests run them against a temporary folder. |
| `CLAUDE_VOICE_SAY=<path>` | `plugin/hooks/speak-reply.py` runs that instead of `/usr/bin/say`. |

All four are unset in a real session. `test/fixture-server.mjs` and `test/hooks.test.mjs` set them. A whole session can be driven the same way:

```sh
: > /tmp/inject.txt
CLAUDE_VOICE_INJECT=/tmp/inject.txt CLAUDE_VOICE_SILENT=1 node src/launch.mjs --model fable --effort low
echo "what does this repo do, send message" >> /tmp/inject.txt   # from a second terminal
```

## docs/

- `docs/uninstall.md`: every location an install touches, what `claude-code-handsfree --remove` removes, and the command or System Settings path for the rest.
