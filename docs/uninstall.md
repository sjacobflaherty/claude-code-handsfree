# Uninstall

This page lists every place an install of claude-code-handsfree touches, plus the backups its removal creates. `claude-code-handsfree --remove` cleans the two places outside the folder that setup itself wrote and prints the command for the folder. The rest take one command or one System Settings visit each.

## What `--remove` does

`claude-code-handsfree --remove` runs `src/remove.mjs` in the install folder. `npm run remove` in that folder runs the same script, which matters after the shell function is gone. It asks before each change, `--yes` answers yes to everything, and `--dry-run` prints what it would do and writes nothing.

It reports a running voice session (`state/active.json` names a live server process) and leaves it alone. Stop the session before uninstalling, or the server keeps writing into `state/` until it exits.

It removes the shell rc block. Setup writes the `claude-code-handsfree` shell function between two marker lines:

```
# >>> claude-code-handsfree >>>
# <<< claude-code-handsfree <<<
```

The script cuts every block with those markers, together with the blank line above it, from `~/.zshrc`, or from `~/.bashrc` when `$SHELL` is bash. `--rc <path>` names another file, which a fish install needs (`--rc ~/.config/fish/config.fish`). The script keeps a copy of the file as `<rc>.bak-<timestamp>` first. The function stays defined in the terminal that is already open; the script prints the `unset -f` for it, and a new terminal starts without it. A function added with `--name` still sits between the same markers, so the script finds it. The script does not find a function that an older setup wrote without the markers, and leaves it in the file.

It removes what older versions put in `~/.claude`, each after a question: the `mcp__voice__*` entry in `permissions.allow` and the `speak-reply.py` Stop hook in `settings.json` (a copy is kept as `settings.json.bak-<timestamp>`), `hooks/speak-reply.py`, `speak-on`, `voice-channel-active`, `voice-next-model`, and the `skills/handsfree` symlink when it points into the install folder. A current install writes none of these, so a fresh clone has nothing there. `CLAUDE_CONFIG_DIR` replaces `~/.claude` when set.

It ends by printing `rm -rf` with the install folder's path. It never runs that command, never uninstalls `hear`, and never touches the log file, the macOS permissions, or a downloaded voice.

## Every location

Run `claude-code-handsfree --remove` first. Then work down this list.

### The shell rc block

Removed by `--remove`. To check afterwards:

```
grep -n 'claude-code-handsfree' ~/.zshrc
```

No line should match. A match means the function sits there without the markers; delete it and the comment line above it from the file.

### The install folder

Not removed by `--remove`; it prints the command. The folder holds the code, `node_modules/`, `bin/audiodev`, `bin/disclaim`, `settings.jsonc`, `phrases.jsonc`, `profiles/`, and `state/`:

```
rm -rf /path/to/claude-code-handsfree
```

`--remove` prints the real path. Stop any voice session first, because the server writes `state/active.json` while it runs.

### The state folder

`state/` inside the install folder. The server creates it on demand and writes `active.json` (the flag both hooks read) and `next-model` (the model switch marker). Deleting the folder deletes it. To clear it and keep the install:

```
rm -rf /path/to/claude-code-handsfree/state
```

### The log file

Not removed by `--remove`. The server appends to the file named by `log.file` in `settings.jsonc`, `~/Library/Logs/claude-code-handsfree.log` by default, and renames it to `<file>.1` once it passes `log.rotateBytes`:

```
rm -f ~/Library/Logs/claude-code-handsfree.log ~/Library/Logs/claude-code-handsfree.log.1
```

A `log.file` set to another path means those two paths instead.

### hear

Setup places `hear` in `bin/` inside the install folder, so it goes when the folder goes. Nothing to do.

A `hear` you installed yourself on PATH is not touched, because another tool may use it. From its Homebrew tap:

```
brew uninstall hear
brew untap sveinbjornt/hear
```

From the signed download's `sudo bash install.sh`:

```
sudo rm /usr/local/bin/hear /usr/local/share/man/man1/hear.1
```

Setup never installs Node or the Xcode command line tools. It stops and names the missing one, so neither is part of this uninstall.

### The Microphone permission

Not removed by `--remove`. `bin/disclaim` starts `hear` as its own process, so macOS granted the permission to `hear` and the entry carries the name `hear`. Turning it off affects only `hear`. An install made before `bin/disclaim` existed granted the terminal app instead, so an entry with the terminal app's name may also be there; turning that one off also stops every other tool in that terminal app from using the microphone.

System Settings > Privacy & Security > Microphone, then turn off `hear`.

### The Speech Recognition permission

Not removed by `--remove`. Same entry name, same note.

System Settings > Privacy & Security > Speech Recognition, then turn off `hear`.

### A downloaded voice

Not removed by `--remove`. Setup suggests an Enhanced or Premium voice and writes its name into `phrases.jsonc`; the voice itself is a macOS download.

System Settings > Accessibility > Spoken Content, then the Info button next to System Voice. Select the voice, swipe left on it with two fingers, and click Delete.

### The backups `--remove` made

Each file `--remove` rewrote has a copy next to it: `~/.zshrc.bak-<timestamp>` (or the rc file named with `--rc`) and `~/.claude/settings.json.bak-<timestamp>`. They are the only files `--remove` creates. Delete them once the rewritten files work:

```
ls ~/.zshrc.bak-* ~/.claude/settings.json.bak-*
```

## Check

`claude-code-handsfree --check` runs before the rc block is gone; `node /path/to/claude-code-handsfree/src/check.mjs` runs after. Its "Outside this folder" section lists the rc block and every `~/.claude` leftover it can see. Once the folder itself is deleted, the check is gone with it. The traces that can remain are the rc block, the log file, `hear`, the two permissions, a voice, and the backups, and each has its command above.
