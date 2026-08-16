---
name: grok-imagine-start
description: Start the dedicated Cursor Grok Imagine Chrome profile on 127.0.0.1:9334
---

# Start Grok Imagine browser

Start or reuse the dedicated Cursor Chrome profile. This is `LOCAL_STATE`, not quota consumption.

1. Resolve the plugin root for `game-assets-automation`.
2. Run `powershell.exe -NoProfile -File scripts/Start-GrokChrome.ps1 -Agent cursor`.
3. Then run `node.exe scripts/grok-cdp-worker.mjs status --port 9334`.
4. Report the port, profile directory, and visible page URL.
5. If the page is a login screen, tell the user to sign in inside that dedicated window. Do not read cookies or session storage.
6. Do not submit generation.
