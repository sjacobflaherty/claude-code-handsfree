---
name: handsfree
description: Start or check the voice channel microphone in the current session, pick the microphone and output from a list, or explain how the voice channel works and which spoken commands this install answers to. Use when the user says start voice, check voice, is voice listening, voice status, pick a microphone, runs /handsfree, or asks anything about using voice: what can I say, what commands are there, how do I send or stop or pause or replay or switch model by voice, how does the voice channel work, voice help.
allowed-tools: mcp__voice__voice_status mcp__voice__voice_start mcp__voice__voice_stop AskUserQuestion
---

# Voice channel control

Arguments: `$ARGUMENTS` (empty, `stop`, `devices`, `commands`, `input <name fragment>`, `output <name fragment>`, or both, e.g. `input Headset output Speakers`). A question about how to use voice, typed or spoken, counts as `commands`.

Repo folder resolved from this skill's location:

!`cd -P "${CLAUDE_SKILL_DIR:-/nonexistent}/../../.." 2>/dev/null && pwd || echo "(unresolved: use the folder whose src/ holds voice-channel.mjs)"`

The spoken commands this install answers to, resolved the way the server resolves them (locale file, then `phrases.jsonc`, the profile, and the launch flags). Read this, never the raw JSON, when answering what the user can say:

!`cd -P "${CLAUDE_SKILL_DIR:-/nonexistent}/../../.." 2>/dev/null && node src/commands.mjs 2>&1 || echo "(unresolved: run node <repo>/src/commands.mjs)"`

## Step 1: is the server loaded in this session?

Look at your own tool list for `mcp__voice__voice_status`.

If it is missing, the voice MCP server is not loaded in this session. Do not try to
start it. A channel only registers at launch, so no command can add it to a session
that is already running. Reply with this and nothing else, substituting the folder
path resolved above for `<repo>`:

```
Voice is not loaded in this session. A channel only registers at launch, so exit and restart with:

claude-code-handsfree

(or, without the shell function: node <repo>/src/launch.mjs)
```

Then stop. Do not run the command yourself.

## Step 2: `$ARGUMENTS` is `stop`

Call `mcp__voice__voice_stop`. It returns `stopped` or `already stopped`. Reply with that
in one line in text and add that `/handsfree` starts it again. Stop.

## Step 3: `$ARGUMENTS` is `commands`, or the user asked how to use voice

Answer from the command list printed above. It is the live config, so a user who renamed
a phrase in `phrases.jsonc` or a profile sees their own phrases, not the shipped ones.

- Asked for the whole list: give every command with its phrases and what it does, then
  the yes and no answers, and that "voice help" reads the list aloud. Skip the number,
  model, and effort words unless asked.
- Asked about one thing ("how do I stop", "can I replay that"): give that command's
  phrases and one line on what it does, nothing else.
- Asked how the channel works: speech is transcribed and the words are watched for
  these phrases; the send phrase (or the silence timeout, when `silenceFallbackMs` is
  set) ends the turn and sends the text; the reply is read aloud through `speak`.
- The list above says `(unresolved ...)`: say the command list could not be read and
  give the command it names for the user to run.

Reply through the channel the question came in on: a voice message gets `speak`, in
plain sentences with the phrases said as words, and typed text gets text. This is the
one step that may call `speak`.

To change a phrase, point at `phrases.jsonc` (`overrides.<locale>.commands`) and
`npm run check` afterwards; do not edit it from this skill.

## Step 4: `$ARGUMENTS` is `devices`

The user picks the pair from a list instead of typing a name.

1. Call `mcp__voice__voice_status`. Its line carries what this step needs:
   `input=<name>` and `output=<name>` are the current pair, `outputRule=` is
   `same-as-input` or `list`, and `devices=[...]` holds one entry per device as
   `<name> (<direction>, <tag>, <tag>)`, for example
   `Wireless Headset (both, input allowed, output allowed)`.
2. The microphones you may offer are the entries tagged `input allowed`, and nothing else.
   If there are none, reply in one line that no device on this Mac matches `allowedInputs`
   in `settings.jsonc`, list the device names `voice_status` returned, and stop. If the
   user has never configured one, the fix is `npm run setup` in the repo folder.
3. One allowed microphone: use it and ask nothing, because a question needs at least two
   options. Two or more: ask with `AskUserQuestion`, one question, `header` "Microphone",
   question "Which microphone should voice listen on?", single select, which is the default.
   Each option is one allowed microphone: `label` is its name in five words or fewer,
   unique within the question, and `description`, which every option needs, is the full
   name, with `Current input.` added to the one that matches `input=`. Offer each name
   once even when the list repeats it. Add no option of your own beyond the one in step 4;
   the user can always type an answer instead of picking.
4. A question shows two to four options, so with more than four allowed microphones ask
   in rounds: each round offers three devices plus a fourth option `More devices`, and the
   last round offers the final two to four devices and no `More devices`. Ask the next
   round only when the user picks `More devices`.
5. If the user types an answer instead of picking one, follow what they wrote. When it
   names a device, use that name, and if no allowed device matches it, say so and stop.
6. The output:
   - `outputRule=same-as-input`: the output has to be the same device as the input. Ask
     nothing and use the chosen microphone for both.
   - `outputRule=list`: ask a second `AskUserQuestion` over the entries tagged
     `output allowed`, `header` "Output", question "Which output should replies play
     through?", marking the one that matches `output=` as the current output. Steps 3 and 4
     apply again: one allowed output is used without a question, and more than four are
     asked in rounds.
7. Call `mcp__voice__voice_start` with `{ "input": "<fragment>", "output": "<fragment>" }`.
   Each fragment is the part of the chosen name that no other device in the list shares,
   for example `Headset` for `Wireless Headset`. When in doubt pass the whole name.
8. Reply in one line in text with what `voice_start` returned, as the next step does.
   Do not call `speak`.

## Step 5: `input` or `output` given

Call `mcp__voice__voice_start` with `{ "input": "<fragment>" }`, `{ "output": "<fragment>" }`,
or both, exactly as the user wrote them. The server restarts listening on that device
for the rest of the session. It returns `listening input=<name> output=<name>` or
`refused: <reason>`. Reply in one line in text with the result. If it refused, the
reason names the device that is not on the allowed list; say so and mention
`allowedInputs` in `settings.jsonc`. If the reason says no microphone is configured
at all, tell the user to run `npm run setup` in the repo folder instead.

## Step 6: no arguments

1. Call `mcp__voice__voice_status`. It returns one line:
   `listening=<bool> paused=<bool> stopped=<bool> input=<device> output=<device> locale=<code> profile=<name> outputRule=<rule> devices=[...]`.
2. If `listening=false`, call `mcp__voice__voice_start` with no arguments. It returns
   `listening input=<name> output=<name>` or `refused: <reason>`. A refusal is the
   device guard: the input must match `allowedInputs` and the output `allowedOutputs`.
   A refusal can also mean no microphone has been configured at all (`allowedInputs`
   is empty); then the reply should tell the user to run `npm run setup`.
3. Reply in one line in text, not through `speak`: the state and both device names.
   If `voice_start` refused, say the reason, then list the devices from `voice_status`
   so the user can pick one with `/handsfree input <name>` or `/handsfree devices`.

Examples of the whole reply:

```
Listening. Input Headset, output Headset.
```

```
Refused: input is Built-in Microphone, not Headset. Put the headset on and run /handsfree again.
```

```
Already listening (paused). Say "resume session" to unpause. Input and output Headset.
```

Outside step 3, do not call `speak` in this skill. The answer belongs on screen, because
the user may be reading the terminal and the microphone may not be on yet.
