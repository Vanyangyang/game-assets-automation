---
name: grok-imagine-status
description: Check the dedicated Cursor Grok Imagine Chrome CDP on 127.0.0.1:9334 without submitting generation
---

# Grok Imagine status

Run a read-only status check for the Cursor Grok Imagine browser.

1. Resolve the plugin root for `game-assets-automation`.
2. Run `node.exe scripts/grok-cdp-worker.mjs status --port 9334`.
3. If CDP is down, report that the dedicated browser is not running and stop. Do not start it unless the user asked to start it.
4. Report browser version, page count, titles, and URLs only. Do not read cookies, headers, or profile databases.
5. Do not click, fill, generate, or consume quota.
