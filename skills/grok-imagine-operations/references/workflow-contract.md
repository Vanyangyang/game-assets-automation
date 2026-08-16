# Workflow contract

Workflow files are JSON objects with `schemaVersion`, `name`, `risk`, optional `confirmationId`, and `actions`.

```json
{
  "schemaVersion": 1,
  "name": "readonly-smoke",
  "risk": "READ_ONLY",
  "actions": [
    { "type": "wait", "selector": "body", "state": "visible", "timeoutMs": 30000 },
    { "type": "snapshot", "maxText": 2000 }
  ]
}
```

## Risk rules

- `READ_ONLY` permits `wait`, `assert`, `sleep`, and `snapshot`.
- `LOCAL_STATE` additionally permits `navigate` and `screenshot`.
- `QUOTA_RISK` additionally permits `fill`, `click`, `press`, `upload`, `download`, `media-download`, and `evaluate`.
- A workflow may declare a higher risk than required, never a lower one.
- `QUOTA_RISK` requires a non-empty `confirmationId` and a matching CLI `--confirm-quota` value.

## Limits

- Maximum 100 actions.
- Maximum workflow duration: 300 seconds unless a lower `timeoutMs` is declared.
- Wait timeout: at most 120 seconds; polling interval: 50-5000 ms.
- Sleep: at most 60 seconds.
- Snapshot text: at most 20000 characters.
- Evaluate expression: at most 20000 characters.
- Navigation is restricted to configured Grok/X login hosts.
- Workflow screenshot paths must remain under the local state root.
- `upload` requires an absolute `filePath`, accepts only GIF/JPEG/PNG/WebP images, and rejects empty files or files larger than 25 MiB at execution time. It defaults to `input[type="file"]`; use `selector` only when the page has more than one file input.
- `download` clicks one explicit element, waits for a completed browser download, and stores the untouched file under the local Grok state root. Its result records path, filename, byte size, and SHA-256.
- Unlabeled icon controls may use an inspected `iconPathPrefix` instead of coordinates. Use a sufficiently specific prefix and re-inspect it after page drift.
- `media-download` selects one unique visible-page IMG/VIDEO source by exact natural dimensions and optional source extension, downloads it without exposing the source URL, and records the same provenance fields. The destination remains under the local state root.

Use `node.exe scripts/grok-cdp-worker.mjs run <workflow.json>` for read-only or local-state workflows. For a confirmed quota workflow, add `--confirm-quota=<confirmationId>`. From Cursor, pass `--port 9334` or set `GAA_GROK_AGENT=cursor`.
