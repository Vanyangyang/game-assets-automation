# Grok Imagine page guide

Use page-visible text, roles, labels, and screenshots only. Do not inspect authentication storage or network headers.

## Preflight

1. Confirm the selected page title and URL belong to `grok.com`.
2. Confirm `document.readyState` is `complete` or wait for the required visible control.
3. Record the page title, URL, and target ID before state-changing actions.
4. Treat missing or renamed controls as page drift; stop and refresh the workflow selectors instead of clicking approximate coordinates.

## Game-asset operating defaults

These are execution defaults, not permission to submit. A host project pipeline remains authoritative.

- Formal candidates use `质量 (v2.0)` when that control is visible.
- Use an explicit image count; default to x2 for formal editing and x4 only for deliberate direction comparison.
- Do not use automatic quantity for a reproducible batch.
- Use 16:9 for backgrounds, battle scenes, full-screen UI, and title art.
- Use 1:1 for item, skill, location, and icon grids.
- Character or pet portraits target 3:4. When Grok only offers 2:3, preserve safe margins and crop locally only through an approved path.

## Drift handling

- Prefer stable labels, roles, and explicit text over positional indexes.
- Assert the intended panel and control are visible immediately before interaction.
- After any click, assert the expected state transition before continuing.
- If two page targets match, require an explicit target ID.
