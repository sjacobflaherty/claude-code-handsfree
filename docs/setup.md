# Setup

What `npm run setup` does in each of its six sections, the macOS permission dialogs, the check and smoke test, and how to launch without the shell command. The README's Install section is the short version.

## The six sections

Setup runs `npm install` itself when `node_modules` is missing, then opens with one question, run everything or choose sections, and works through the sections in order. Each asks `Run this now?` before it changes anything. A missing requirement in section 1 stops the run with the instruction to follow; every other problem is reported and the run continues.

1. Requirements: Node 20 or later and the Xcode command line tools. Setup checks for them, stops when one is missing, and does not install it.
2. `hear`: downloads the author's signed build into `bin/` inside this folder and checks the Developer ID signature. No sudo. Skipped when a `hear` is already on your PATH; a session then uses that one.
3. The app: `npm install` when it has not run yet, then `npm run build`, which compiles two helpers. `bin/audiodev` reads your default audio devices. `bin/disclaim` starts `hear` as its own process, so macOS asks permission for `hear` rather than for your terminal app.
4. Microphones: lists your devices without opening any of them. The ones you tick become `allowedInputs` in `settings.jsonc`, copied from `settings.example.jsonc` when the file is missing, and the output stays `"same"` unless you pick otherwise. `--yes` ticks the default microphone and keeps `"same"`. Only those devices can ever drive a session.
5. Voice: `System default`, the default choice, keeps the macOS system voice from System Settings > Accessibility > Spoken Content, which is the only way to get a Siri voice. To name a voice instead, answer yes when setup asks; it writes the name into `phrases.jsonc` when that file exists and has a live `voice` line, which the example ships, and it refuses any name `say -v '?'` does not list.
6. Shell command: a `claude-code-handsfree` function in `~/.zshrc`, `~/.bashrc` under bash, or `~/.config/fish/config.fish` under fish, between two marker lines so `--remove` can find it later. The function calls the `node` that ran setup by its absolute path, so it works in any shell whatever its PATH. `--name` picks another command name.

Setup ends by running the check and printing two reminders: `cp phrases.example.jsonc phrases.jsonc` when you want to change the voice or the phrases, and `claude-code-handsfree --remove` to uninstall.

Flags go after `--`; `npm run setup -- --help` lists them. `--dry-run` previews all six sections without writing anything, `--only 4,6` runs only those sections, and `--verbose` prints the commands each section runs so you can run them yourself.

## The macOS permissions

Setup never opens the microphone. The first session that listens starts `hear`, and macOS asks twice, once for Microphone and once for Speech Recognition. Allow both. Each dialog names `hear`, and the grant then holds in any terminal app, including the Cursor and VS Code terminals. If a session hears nothing, open System Settings > Privacy & Security > Microphone and check that `hear` is on, then do the same under Speech Recognition.

## The check

`claude-code-handsfree --check`, or `npm run check` in this folder, is read-only. It prints `ok` and `FAIL` rows for the resolved config, the tool versions including the claude login, every audio device with its default and allowed tags, whether a session would listen or refuse and why, the voice a session would speak with, the plugin files, running sessions, and what is outside this folder. Exit 1 on any FAIL. `--verbose` adds every setting, device, and voice.

## The smoke test

`npm run smoke` starts the server the way a session would, feeds it one typed utterance in place of the microphone, waits for it to arrive as a voice message, and has the server speak once with the audio replaced by a pause. It proves the install without a headset or a session.

## Launching without the shell command

The shell command runs `node <clone>/src/launch.mjs`, which starts `claude` with these flags. Replace `/path/to/claude-code-handsfree` with your clone folder:

```sh
claude \
  --mcp-config '{"mcpServers":{"voice":{"command":"node","args":["/path/to/claude-code-handsfree/src/voice-channel.mjs"]}}}' \
  --dangerously-load-development-channels server:voice \
  --plugin-dir /path/to/claude-code-handsfree/plugin \
  --allowedTools 'mcp__voice__*' \
  --model opus --effort high
```

`--mcp-config` loads the server for that session only. `--plugin-dir` loads the two hooks and the `/handsfree` skill. `--allowedTools` lets `speak` run without a permission prompt. `--dangerously-load-development-channels` is required while channels are a research preview. Started this way, the `--profile`, `--locale`, `--voice`, `--input`, `--output`, and `--set` flags are unavailable, model switching by voice does not work, and the hooks identify the session by its working directory instead of a session id. The settings files still apply.
