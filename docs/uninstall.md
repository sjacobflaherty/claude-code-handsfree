# Uninstall

Run `--remove`, then clear what it leaves. Every place an install touches is listed here with its command.

## Running `--remove`

```sh
claude-code-handsfree --remove
```

It asks before each change. It removes the shell command from your rc file, keeping a backup beside it, and anything an older version put in `~/.claude`. It ends by printing the `rm -rf` for the install folder without running it. `--dry-run` shows what it would do, and `--yes` skips the questions. Once the shell command is gone, `npm run remove` inside the folder runs the same script.

Stop any voice session first. `--remove` reports one but does not stop it.

A terminal that is already open keeps the shell command until you close it; the script prints the `unset -f` line that clears it.

## Clearing everything else

### Deleting the install folder

Holds the code, hear, your two config files, profiles, and state. `--remove` prints this with the real path:

```sh
rm -rf /path/to/claude-code-handsfree
```

Setup never installs Node or the Xcode command line tools, so they are not part of this.

### Deleting the log file

```sh
rm -f ~/Library/Logs/claude-code-handsfree.log ~/Library/Logs/claude-code-handsfree.log.1
```

If you set `log.file` to another path, delete that path and its `.1` instead.

### Removing a hear you installed yourself

Setup's own hear lives in the install folder and goes with it. A hear you installed before is left alone, because another tool may use it. From Homebrew:

```sh
brew uninstall hear
brew untap sveinbjornt/hear
```

From the signed download's `install.sh`:

```sh
sudo rm /usr/local/bin/hear /usr/local/share/man/man1/hear.1
```

### Turning off the two macOS permissions

System Settings > Privacy & Security, then turn off `hear` under Microphone and under Speech Recognition. An older install may show your terminal app's name there instead. Turning that one off also stops every other tool in that terminal from using the microphone.

### Deleting a downloaded voice

If you downloaded a voice during setup, it is a macOS download and stays. System Settings > Accessibility > Spoken Content > System Voice > Manage Voices, then delete it.

### Deleting the backups

Each file `--remove` rewrote has a copy beside it. Delete them once the rewritten files work:

```sh
rm ~/.zshrc.bak-* ~/.claude/settings.json.bak-*
```

## Checking what is left

Before the folder is gone, the check lists what is still outside it: `claude-code-handsfree --check`, or `node /path/to/claude-code-handsfree/src/check.mjs` once the shell command is removed. After the folder is gone, what can remain is the log file, a hear you installed yourself, the two permissions, a voice, and the backups. Each has its command above.
