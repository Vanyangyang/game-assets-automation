# game-assets-automation

[中文说明](./README.zh-CN.md) · [Issues](https://github.com/Vanyangyang/game-assets-automation/issues)

Guarded **Grok Imagine** browser automation for game-asset production. The plugin talks to a dedicated local Chrome profile over CDP. It does not replace a host project's visual grammar, asset acceptance, or engine import checks.

This repository is the shared source for **Cursor**, **Codex**, **Claude Code**, and **Grok Build**. Cursor and Codex keep separate Chrome profiles so both agents can stay logged in at the same time.

## Host isolation

| Host | CDP | Profile directory | MCP config |
|---|---|---|---|
| Cursor | `127.0.0.1:9334` | `ChromeProfileCursor` | `mcp.json` |
| Codex / Claude / Grok | `127.0.0.1:9333` | `ChromeProfile` | `.mcp.json` |

State lives outside the repo. If `%LOCALAPPDATA%\VESPERIX\GrokCdp` already exists, the worker reuses it so an existing login is not thrown away. New machines use `%LOCALAPPDATA%\GameAssetsAutomation\GrokCdp`.

## Cursor

Local development install:

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.cursor\plugins\local\game-assets-automation" `
  -Target "C:\Users\Administrator\plugins\game-assets-automation"
```

Then reload Cursor (`Developer: Reload Window`). The plugin contributes:

- skill `grok-imagine-operations`
- commands `/grok-imagine-status` and `/grok-imagine-start`
- slim MCP server `grok-imagine-browser` attached to `127.0.0.1:9334`

Start the dedicated browser before using MCP:

```powershell
powershell.exe -NoProfile -File scripts/Start-GrokChrome.ps1 -Agent cursor
node.exe scripts/grok-cdp-worker.mjs status --port 9334
```

If the page is a login screen, sign in inside that dedicated window. Do not reuse your daily Chrome profile.

## Codex / Claude / Grok

```bash
# Codex
codex plugin marketplace add Vanyangyang/game-assets-automation --ref master
codex plugin add game-assets-automation@vanyangyang

# Claude Code
claude plugin marketplace add Vanyangyang/game-assets-automation
claude plugin install game-assets-automation@vanyangyang

# Grok Build
grok plugin marketplace add Vanyangyang/game-assets-automation
grok plugin install Vanyangyang/game-assets-automation --trust
grok plugin enable game-assets-automation
```

Those hosts default to `-Agent codex` / port `9333`.

## Safety

- `READ_ONLY`: status, snapshot, wait, assert.
- `LOCAL_STATE`: start/stop, navigate, screenshot.
- `QUOTA_RISK`: fill, click, generate, upload, download. Requires a fresh user confirmation and `--confirm-quota=<confirmationId>`.
- Never read cookies, password stores, profile databases, or auth headers.
- A completed workflow is only a candidate. It is not a Unity / engine acceptance.

## Tests

```bash
npm test
```

The tests cover CLI parsing, host allowlists, workflow risk gates, upload/download bounds, and Cursor/Codex port isolation. They do not start Chrome or submit generation.
