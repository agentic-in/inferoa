---
title: CLI Reference
sidebar_label: CLI
---

## Usage

```bash
inferoa
inferoa "prompt"
inferoa setup
inferoa --print "prompt"
inferoa debug <command>
```

## Options

| Option | Description |
| --- | --- |
| `--config <path>` | Load a specific config YAML file |
| `--workspace <path>` | Set the workspace root |
| `--state-dir <path>` | Set the state directory, defaulting to `~/.inferoa` |
| `--json` | Print JSON for supported debug commands |
| `--print`, `-p` | Run non-interactive print mode |
| `--no-animation` | Disable the TUI intro animation |
| `--help`, `-h` | Show help |

## Debug Commands

```bash
inferoa debug init
inferoa debug setup
inferoa debug status
inferoa debug sessions
inferoa debug tools list
inferoa debug events <session> <limit>
inferoa debug archive <session>
inferoa debug daemon status
inferoa debug acceptance --daemon
```

Use debug commands for automation, inspection, and validation. Use the TUI for
normal work.
