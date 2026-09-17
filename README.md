# claude-code-handsfree

![macOS](https://img.shields.io/badge/platform-macOS-lightgrey) ![Node 20+](https://img.shields.io/badge/node-20%2B-green) ![Research preview](https://img.shields.io/badge/channels-research_preview-orange)

Hands-free voice conversation inside a Claude Code session on macOS.

A local MCP server listens on your headset, sends what you say into the session as a message, and reads Claude's replies aloud. It is a normal `claude` session with one server added, so your `CLAUDE.md`, skills, hooks, and MCP servers all apply, and it runs under your Claude subscription with no API key. Speech recognition is Apple's, through [hear](https://github.com/sveinbjornt/hear); playback is `/usr/bin/say`. Everything loads per session from this folder, and a plain `claude` session never starts the microphone.

A session: type the first message, then talk. Claude speaks its reply, you answer, and the server sends what you said six seconds after your last word or when you say "send message". You hear "Got it" when a message is sent, and the terminal shows it as `← voice: ...`. Say "stop session" to stop listening; the session stays open for typing.

## Requirements

- A headset: one device that is both the microphone and the output. Speakers with the built-in microphone are not supported, because the microphone hears each reply and the session answers itself.
- Claude Code signed in to your Claude subscription.
- Node 20 or later.
- The Xcode command line tools (`xcode-select --install`). Full Xcode and Homebrew are not needed.

## Install

```sh
git clone https://github.com/sjacobflaherty/claude-code-handsfree.git
cd claude-code-handsfree
npm run setup
```

Setup asks `Run this now?` before each of its six sections (requirements, `hear`, build, microphones, voice, shell command); the shell command is the one thing it writes outside this folder. `npm run setup -- --help` lists the flags, and [docs/setup.md](docs/setup.md) says what each section does. The first session that listens triggers two macOS dialogs, Microphone and Speech Recognition, each naming `hear`. Allow both.

Open a new terminal, then run the check. `npm run smoke` proves the install without a headset.

```sh
claude-code-handsfree --check
```

## Use

Start a session inside the repository you want to work in:

```sh
claude-code-handsfree
claude-code-handsfree --model fable
```

Phrases match the end of what you have said. `/handsfree commands` lists the phrases this install answers to; after a stop, `/handsfree` or typing `start voice` listens again, and `/handsfree devices` picks another allowed microphone.

| Say | Effect |
| --- | --- |
| `send message` | Send everything said since the last send. |
| `interrupt message` or `stop message` | Stop the reply that is playing and keep listening. |
| `use clipboard` | Attach the clipboard contents to the next message. |
| `replay voice`, `replay voice three` | Read the last reply again, or the third most recent. |
| `pause session`, `resume session` | Discard everything said until resume. The stop phrases and a yes or no still work. |
| `stop session` | Stop listening. The session stays open for typing. |
| `yes`, `approve`, `no`, `deny` | Answer a permission prompt that was read aloud. The last word decides. |
| `switch model fable high` | Restart the session on that model and effort once you confirm with yes. |
| `voice help` | Read the command list aloud. |

## Configure

Two gitignored files at the root, each copied from its example: `settings.jsonc` is the machine (devices, timing, model) and `phrases.jsonc` is the language (voice, phrases, every spoken sentence). The example file describes every option. Run `npm run check` after an edit. Profiles, launch flags, adding a phrase, and picking a voice are in [docs/configuration.md](docs/configuration.md).

## Safety

- A fresh clone allows no microphone. Listening needs the default input on `allowedInputs` and the default output on `allowedOutputs`, and a device change stops listening at once.
- Audio goes to Apple's server recognizer, and the log at `~/Library/Logs/claude-code-handsfree.log` holds the full text of every sent message; `log.includeSentText: false` keeps lengths only.
- A permission prompt can be approved by voice only while listening, and your Claude Code `deny` rules still apply.

The full device rules are in [docs/safety.md](docs/safety.md).

## Uninstall

```sh
claude-code-handsfree --remove
```

It asks before removing the shell command and prints the `rm -rf` for the clone folder without running it. The log, the two macOS permissions, and a downloaded voice stay; [docs/uninstall.md](docs/uninstall.md) has a command for each.

## Known limits

- Channels are a research preview, and the `--dangerously-load-development-channels` flag may change between Claude Code releases. If launch fails, check code.claude.com/docs/en/channels against `src/launch.mjs`.
- Every launch shows a full-screen dialog that only Enter dismisses. The launcher speaks a cue telling you to press it.
- Automatic send waits six seconds after the transcript last changed, plus a few seconds of recognizer tail.
- Model switching by voice is not verified in a live session. `--model` at launch and `/model` work.
- The first half of a long spoken paragraph was lost once and has not been reproduced. Apple documents a one-minute cap per utterance on its server recognizer; utterances over two minutes have arrived whole.
- Claude sometimes answers in text instead of speaking, most often on the first turn after `/clear`. The Stop hook reads that text aloud, and that reading cannot be replayed.
- A channel registers only at launch. A plain `claude` session cannot become a voice session; restart with `claude-code-handsfree`.

## Contributing

Changes reach `main` through a pull request, squash-merged once CI is green.

## License

MIT, see [LICENSE](LICENSE). Speech recognition is [hear](https://github.com/sveinbjornt/hear) by Sveinbjorn Thordarson, and the barge-in echo guard follows [Hermes Agent](https://github.com/NousResearch/hermes-agent).
