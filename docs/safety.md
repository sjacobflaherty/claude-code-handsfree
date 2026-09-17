# Safety

The device rules, what happens when a device changes, and what leaves the Mac. Every rule here is a setting in `settings.jsonc`; the example file names the default beside each one.

## Which devices may listen

A fresh clone allows no microphone. Listening starts only when the default input matches an entry in `allowedInputs` and the default output passes `allowedOutputs`. `"same"`, the shipped value, means the output must be the same device as the input, which is what any headset gives; a list of name fragments allows other outputs. Otherwise the server says which device failed, or names `npm run setup` when the list is empty.

## When a device changes

Every two seconds (`deviceCheckIntervalMs`) the server re-reads both defaults. When either changes it stops listening, discards anything half heard, and says "Voice session stopped". It then listens again on the first pair that passes those same lists after two identical reads (`advanced.fallbackSettleChecks`) and says which device it moved to. `fallbackInput` narrows that resume to one pair, and `resumeOnDeviceChange: false` keeps the session stopped until you type `start voice`.

Three device-check failures in a row stop the session (`advanced.audiodevFailureLimit`), and so do three recognizer exits without a transcript within five seconds (`advanced.hearFailureLimit`, `advanced.hearFailureWindowMs`).

## Pause and stop

Pause keeps the microphone open and discards what you say until the resume phrase; the stop phrases and a yes or no still work. Stop closes the microphone.

## One session per Mac

`state/active.json` holds the listening server's process id. A second server that finds a live pid there refuses to listen and says so; a dead pid is ignored. Every stop clears the flag, and a server exits with its session, killing `hear` within one device-check interval of the session ending.

## Permission prompts

The server reads a Claude Code permission prompt aloud and takes a spoken yes or no, but only while listening is active. The terminal dialog stays open too, and the first answer wins. Your Claude Code `deny` rules still apply to every tool call.

## Barge-in

Talking over a reply cuts it off, and so does a typed prompt. Barge-in is armed only when input and output are one device (`bargeInSameDeviceOnly: true`), so speakers cannot cut the Mac off with its own voice; set it to `false` to arm it on any pair. Nothing filters the Mac's own voice out of what the microphone hears, which is why a headset is the supported setup.

## What leaves the Mac and what is logged

The default recognizer is Apple's server (`hearOnDeviceOnly: false`), so audio leaves the Mac. The log at `~/Library/Logs/claude-code-handsfree.log` holds the full text of every sent message; `log.includeSentText: false` keeps only lengths, and `log.file: ""` turns the file off.

## Why the permission entries say hear

The server starts `hear` through `bin/disclaim`, which makes `hear` its own responsible process for macOS permissions, so the Microphone and Speech Recognition entries in System Settings are named `hear` and the grant holds in any terminal app. Turning either entry off affects only `hear`.
