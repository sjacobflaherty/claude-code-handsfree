# claude-code-handsfree

Hands-free voice conversation inside a Claude Code session on macOS. `src/voice-channel.mjs` is a local MCP server that listens through `hear`, pushes each utterance into the session as a channel message, and speaks replies through its `speak` tool with `/usr/bin/say`. `src/launch.mjs` starts `claude` with that server and the plugin in `plugin/` for one session; nothing is written into `~/.claude`. The README is the user's path, and the pages under `docs/` hold the reference:

- `docs/setup.md`: what each setup section does, the macOS permissions, launching without the shell command.
- `docs/configuration.md`: the two config files, which key goes where, precedence, adding a phrase, profiles, the voice.
- `docs/safety.md`: the device rules and what happens on a device change.
- `docs/uninstall.md`: every location an install touches and how to clear each.

## Files you may edit for the user

Edit on request: `settings.jsonc`, `phrases.jsonc`, and `profiles/<name>/settings.jsonc` or `profiles/<name>/phrases.jsonc`. When the file is missing, copy the example first. Read the option's block in the example file and uncomment its line rather than writing a key from memory; `docs/configuration.md` says which key goes in which file, and the loader refuses a key in the wrong file. Run `npm run check` after an edit; it fails on a bad value and names the key.

Do not edit unless asked: `src/`, `plugin/`, `locales/`, `test/`, the two example files, `biome.jsonc`, `vitest.config.mjs`, `package.json`. Never write into `~/.claude` or the rc file; `npm run setup` and `--remove` are the only code that touches the rc file. Never edit `state/`.

## In a session

A voice message arrives as `← voice: ...`; answer it through `speak` and write no text after the tool returns. `/handsfree` (the plugin skill) checks and starts listening, stops it, picks devices, and lists the spoken commands from the resolved config; typing `start voice` does the same as `/handsfree`.

## Microphone rules

- Listening starts only when the default input matches an entry in `allowedInputs` and the default output passes `allowedOutputs`. `allowedInputs` ships empty, so a fresh clone refuses. Naming a device is the user's decision; do not add the built-in microphone unprompted.
- Every device rule is a setting with a safe default and an override. Never hardcode which input or output a feature works with.
- `bargeInSameDeviceOnly: true` arms barge-in only when input and output are one device. With speakers the microphone hears `say`.
- One server listens per Mac: `state/active.json` holds the listening server's pid, a second server that finds a live pid there refuses to listen, and every stop clears the flag.
- The server starts `hear` through `bin/disclaim` so macOS charges the permission to `hear`. Without it, a `hear` started under an app whose Info.plist lacks `NSSpeechRecognitionUsageDescription` (Cursor, VS Code) is killed with SIGABRT before any dialog; the log shows that as three `hear exit` lines with `"signal":"SIGABRT"` followed by `hear failing`.
- The log (`log.file`, default `~/Library/Logs/claude-code-handsfree.log`) records every sent message in full unless `log.includeSentText` is false. Read it when a message goes missing or arrives truncated.

## Testing without a microphone

| Variable | Effect |
| --- | --- |
| `CLAUDE_VOICE_INJECT=<file>` | The server skips the device guard and `hear` and polls that file instead. Each newline-ended line appended after start is one utterance, and every phrase works. |
| `CLAUDE_VOICE_SILENT=1` | The server runs a `sleep` of the same length instead of `say` and logs the text as `silent say`. |
| `CLAUDE_VOICE_ROOT=<folder>` | The server, both hooks, `src/setup.mjs`, and `src/check.mjs` treat that folder as this one, which is how the tests run them against a temporary folder. |
| `CLAUDE_VOICE_SAY=<path>` | `plugin/hooks/speak-reply.py` runs that instead of `/usr/bin/say`. |

All four are unset in a real session. `test/fixture-server.mjs` and `test/hooks.test.mjs` set them. A whole session can be driven the same way:

```sh
: > /tmp/inject.txt
CLAUDE_VOICE_INJECT=/tmp/inject.txt CLAUDE_VOICE_SILENT=1 node src/launch.mjs --model fable --effort low
echo "what does this repo do, send message" >> /tmp/inject.txt   # from a second terminal
```
