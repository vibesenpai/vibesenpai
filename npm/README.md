# vibesenpai

**Discover how your agents failed you.** vibesenpai reads the sessions already on your disk and
shows you where they went wrong: the exact turns, in your own words, and a fix you can apply.

It is a Claude Code plugin. This package only installs it, through Claude Code's own installer.

## Install

From a terminal:

```
npx vibesenpai install
```

It checks for Node 22.13+ and Claude Code 2.1.299+, shows the command it will run, and asks
before running it:

```
claude plugin install vibesenpai --marketplace vibesenpai/vibesenpai
```

`--scope user|project|local` picks where Claude Code installs it (default: user). With no terminal
attached, add `--yes`, or run that command yourself.

Or, in Claude Code:

```
/plugin marketplace add vibesenpai/vibesenpai
/plugin install vibesenpai@vibesenpai
```

This package has no install script, no dependencies and no network calls of its own, and it writes
no files. Claude Code does the install. The plugin's model reads stay off until you say yes, after
seeing exactly what they would send.

## Links

- [Documentation](https://vibesenpai.github.io/vibesenpai/)
- [Source](https://github.com/vibesenpai/vibesenpai)
- [Releases](https://github.com/vibesenpai/vibesenpai/releases)

MIT licensed.
