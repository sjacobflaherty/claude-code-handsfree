# Safety

What stops the microphone, what leaves the Mac, and what a spoken yes can approve. Every rule here is a setting in `settings.jsonc`, with its default beside it in the example file.

## Allowing microphones

A fresh clone has no microphones allowed. Setup adds the ones you pick, and a session listens only when your default microphone is on that list and your default output passes `allowedOutputs`. `"same"`, the shipped value, means the output must be the same device as the microphone, which any headset gives. Otherwise the server tells you which device failed.

## Changing microphone inputs

Unplugging or switching a device stops listening at once, discards anything half heard, and says "Voice session stopped". The session then listens again on the first allowed pair it sees and says which device it moved to. Set `resumeOnDeviceChange` to `false` to stay stopped until you type `start voice`, or `fallbackInput` to name the one microphone it may resume on.

Three device checks failing in a row, or three recognizer failures without transcription within five seconds, also stop the session.

## Pausing and stopping

Pause keeps the microphone open and discards what you say until the resume phrase; the stop phrases and a yes or no still work. Stop closes the microphone.

## Running two sessions

Only one session on the Mac listens at a time. A second one says so and stays off until the first stops.

## Answering permission prompts by voice

A permission prompt is read aloud and takes a spoken yes or no, but only while listening. The terminal prompt stays open too, and whichever answer comes first wins. A prompt left unanswered for two minutes is forgotten; answer it at the keyboard. Your Claude Code `deny` rules still apply to every tool call.

## Interrupting a reply

Talking over a reply cuts it off, and so does typing. This is armed only when the microphone and the output are one device, so speakers cannot cut the Mac off with its own voice. `bargeInSameDeviceOnly: false` arms it on any pair.

## What leaves the Mac

Audio goes to Apple's server recognizer. `hearOnDeviceOnly: true` keeps it on the Mac, with lower accuracy and for Siri languages only. The log at `~/Library/Logs/claude-code-handsfree.log` holds the full text of every sent message; `log.includeSentText: false` keeps only lengths, and `log.file: ""` turns the file off.

## Revoking the macOS permissions

Open System Settings > Privacy & Security and turn off `hear` under Microphone and under Speech Recognition. That stops only this tool.
