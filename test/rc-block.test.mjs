import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  addRcBlock,
  defaultRcFile,
  findRcBlock,
  findRcBlocks,
  RC_BLOCK_BEGIN,
  RC_BLOCK_END,
  RC_BLOCK_KEY,
  removeRcBlock,
} from '../src/rc-block.mjs'

const BODY = 'claude-voice() {\n  node "/repo/src/launch.mjs" "$@"\n}'
const OLD_BODY = 'claude-voice() {\n  node "/old/src/launch.mjs" "$@"\n}'

describe('defaultRcFile', () => {
  it('selects the conventional rc file for bash, zsh, and fish', () => {
    expect(defaultRcFile({ SHELL: '/bin/bash' })).toBe(join(homedir(), '.bashrc'))
    expect(defaultRcFile({ SHELL: '/bin/zsh' })).toBe(join(homedir(), '.zshrc'))
    expect(defaultRcFile({ SHELL: '/opt/homebrew/bin/fish' })).toBe(join(homedir(), '.config', 'fish', 'config.fish'))
  })
})

describe('the markers', () => {
  it('name the repository once and are a comment in zsh, bash, and fish', () => {
    expect(RC_BLOCK_KEY).toBe('claude-code-handsfree')
    expect(RC_BLOCK_BEGIN).toBe('# >>> claude-code-handsfree >>>')
    expect(RC_BLOCK_END).toBe('# <<< claude-code-handsfree <<<')
  })
})

describe('addRcBlock', () => {
  it('writes the block on its own into an empty file', () => {
    expect(addRcBlock('', BODY)).toBe(
      '# >>> claude-code-handsfree >>>\nclaude-voice() {\n  node "/repo/src/launch.mjs" "$@"\n}\n# <<< claude-code-handsfree <<<\n',
    )
  })

  it('appends the block after a blank line when the file has other lines', () => {
    expect(addRcBlock('export PATH=/usr/local/bin:$PATH\n', BODY)).toBe(
      'export PATH=/usr/local/bin:$PATH\n\n# >>> claude-code-handsfree >>>\nclaude-voice() {\n  node "/repo/src/launch.mjs" "$@"\n}\n# <<< claude-code-handsfree <<<\n',
    )
  })

  it('replaces the block that is already there instead of adding a second one', () => {
    const before = [
      'export PATH=/usr/local/bin:$PATH',
      '',
      '# >>> claude-code-handsfree >>>',
      'claude-voice() {',
      '  node "/old/src/launch.mjs" "$@"',
      '}',
      '# <<< claude-code-handsfree <<<',
      '',
      "alias ll='ls -la'",
      '',
    ].join('\n')
    expect(before).toContain(OLD_BODY)
    expect(addRcBlock(before, BODY)).toBe(
      [
        'export PATH=/usr/local/bin:$PATH',
        '',
        '# >>> claude-code-handsfree >>>',
        'claude-voice() {',
        '  node "/repo/src/launch.mjs" "$@"',
        '}',
        '# <<< claude-code-handsfree <<<',
        '',
        "alias ll='ls -la'",
        '',
      ].join('\n'),
    )
  })

  it('replaces the first block and drops a second one, so a rerun leaves exactly one', () => {
    const before = [
      '# >>> claude-code-handsfree >>>',
      'claude-voice() {',
      '  node "/old/src/launch.mjs" "$@"',
      '}',
      '# <<< claude-code-handsfree <<<',
      '',
      'unrelated line',
      '',
      '# >>> claude-code-handsfree >>>',
      'claude-voice() {',
      '  node "/older/src/launch.mjs" "$@"',
      '}',
      '# <<< claude-code-handsfree <<<',
      '',
    ].join('\n')
    expect(addRcBlock(before, BODY)).toBe(
      [
        '# >>> claude-code-handsfree >>>',
        'claude-voice() {',
        '  node "/repo/src/launch.mjs" "$@"',
        '}',
        '# <<< claude-code-handsfree <<<',
        '',
        'unrelated line',
        '',
      ].join('\n'),
    )
  })

  it('wraps a fish function body unchanged, whatever the shell', () => {
    const fish = 'function claude-voice\n  node "/repo/src/launch.mjs" $argv\nend'
    expect(findRcBlock(addRcBlock('', fish)).body).toBe(fish)
  })
})

describe('removeRcBlock', () => {
  it('removes the only block, and the blank line addRcBlock put above it', () => {
    const before =
      'export PATH=/usr/local/bin:$PATH\n\n# >>> claude-code-handsfree >>>\nclaude-voice() {\n  node "/repo/src/launch.mjs" "$@"\n}\n# <<< claude-code-handsfree <<<\n'
    expect(removeRcBlock(before)).toBe('export PATH=/usr/local/bin:$PATH\n')
  })

  it("removes our block and leaves another tool's marked block standing", () => {
    const before = [
      '# >>> conda initialize >>>',
      'eval "$(/opt/conda/bin/conda shell.zsh hook)"',
      '# <<< conda initialize <<<',
      '',
      '# >>> claude-code-handsfree >>>',
      'claude-voice() {',
      '  node "/repo/src/launch.mjs" "$@"',
      '}',
      '# <<< claude-code-handsfree <<<',
      '',
      "alias ll='ls -la'",
      '',
    ].join('\n')
    expect(removeRcBlock(before)).toBe(
      [
        '# >>> conda initialize >>>',
        'eval "$(/opt/conda/bin/conda shell.zsh hook)"',
        '# <<< conda initialize <<<',
        '',
        "alias ll='ls -la'",
        '',
      ].join('\n'),
    )
  })

  it('removes every block of ours when two are in the file', () => {
    const before = [
      '# top of the file',
      '',
      '# >>> claude-code-handsfree >>>',
      'claude-voice() {',
      '  node "/old/src/launch.mjs" "$@"',
      '}',
      '# <<< claude-code-handsfree <<<',
      '',
      'unrelated line',
      '',
      '# >>> claude-code-handsfree >>>',
      'claude-voice() {',
      '  node "/repo/src/launch.mjs" "$@"',
      '}',
      '# <<< claude-code-handsfree <<<',
      '',
    ].join('\n')
    expect(removeRcBlock(before)).toBe('# top of the file\n\nunrelated line\n')
  })

  it('leaves a file without the block exactly as it was', () => {
    const before =
      'export PATH=/usr/local/bin:$PATH\nclaude-voice() {\n  node /repo/src/launch.mjs "$@"\n}\nalias ll=\'ls -la\'\n'
    expect(removeRcBlock(before)).toBe(before)
    expect(findRcBlock(before)).toBe(null)
  })
})

describe('findRcBlock', () => {
  it('returns the body and the whole block, so a caller can show it before writing', () => {
    const text = addRcBlock('export PATH=/usr/local/bin:$PATH\n', BODY)
    expect(findRcBlock(text).body).toBe(BODY)
    expect(findRcBlock(text).block).toBe(`${RC_BLOCK_BEGIN}\n${BODY}\n${RC_BLOCK_END}`)
  })

  it('returns null when the file holds a begin marker with no end marker', () => {
    expect(findRcBlock(`${RC_BLOCK_BEGIN}\n${BODY}\n`)).toBe(null)
  })
})

describe('findRcBlocks', () => {
  it('returns every block, so remove can show all of what it is about to delete', () => {
    const text = [
      '# >>> claude-code-handsfree >>>',
      OLD_BODY,
      '# <<< claude-code-handsfree <<<',
      '',
      '# >>> claude-code-handsfree >>>',
      BODY,
      '# <<< claude-code-handsfree <<<',
      '',
    ].join('\n')
    expect(findRcBlocks(text).map((b) => b.body)).toEqual([OLD_BODY, BODY])
  })

  it('returns an empty list for a file without the markers', () => {
    expect(findRcBlocks("alias ll='ls -la'\n")).toEqual([])
  })
})
