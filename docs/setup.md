# Setup

What `npm run setup` does, section by section, and what to run afterwards. The README's Install section is the short version.

## Running setup

Setup asks whether to run everything or choose sections, then asks `Run this now?` before each one. A missing requirement stops the run with the instruction to follow. Any other problem is reported and the run continues.

1. **Requirements:** Setup checks for Node 20 or later and the Xcode command line tools. If one is missing, it tells you how to install it and stops. Install it and run setup again.
2. **Install hear:** downloads the author's signed build (about 200 KB) into the repo's own `bin/` folder, so macOS never asks for your password. Skipped if hear is already on your PATH, unless you pass `--force`.
3. **Build the app:** runs `npm install` if needed, then builds two small helpers for hear and microphone inputs.
4. **Microphones:** lists your audio devices and you select the ones a session may listen through. You can change the list later in the config. Output uses the same device as the microphone unless you choose otherwise. `--yes` picks a headset if it finds one, otherwise the default microphone.
5. **Voice:** System default, as set in System Settings > Accessibility > Spoken Content. Change it here or later in the config.
6. **Shell command:** adds a `claude-code-handsfree` command to your shell (zsh, bash, or fish). `--name` picks a different name, and `--remove` takes it out later.

Setup ends by running the check. `npm run setup -- --help` lists the flags. `--dry-run` previews every section without writing anything, `--only 4,6` runs only those sections, and `--yes` takes every default.

## Allowing the macOS permissions

The first time a session listens, macOS asks for Microphone and then Speech Recognition. Allow both.

If a session hears nothing, open System Settings > Privacy & Security and check that both are on.

## Checking the install

```sh
claude-code-handsfree --check
```

Run this whenever something seems off. It prints an ok or FAIL row for your config, the tools, your audio devices, the voice, the plugin, running sessions, and what setup wrote outside this folder. It changes nothing. Add `--verbose` to see every setting, device, and voice.

## Testing without a headset

```sh
npm run smoke
```

Proves the install without a headset or a session. It starts the server, sends it one typed line as if you had spoken it, and has the server speak once with the audio muted. Three ok lines means it passed.

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

The first flag loads the voice server for this session only. The plugin flag loads the hooks and the `/handsfree` skill. The allowed tools flag lets replies be spoken without a permission prompt. The development channels flag is required while channels are a research preview.

Launching this way, you lose the voice flags (`--profile`, `--locale`, `--voice`, `--input`, `--output`, `--set`) and switching models by voice. Your settings files still apply.
