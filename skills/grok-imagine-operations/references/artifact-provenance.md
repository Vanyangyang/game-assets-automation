# Artifact provenance

Every Worker workflow writes a compact manifest under:

```text
<state-root>\runs\<run-id>\run.json
```

The state root is the existing `%LOCALAPPDATA%\VESPERIX\GrokCdp` directory when present, otherwise `%LOCALAPPDATA%\GameAssetsAutomation\GrokCdp`.

The manifest records the workflow name, risk, source path, SHA-256, action types, selected target, timestamps, terminal status, and any screenshot paths. It must not record cookies, passwords, authentication headers, browser databases, or raw session secrets.

## Result states

- `tool_completed`: the declared browser actions completed.
- `candidate`: a result exists but has not passed the owning asset contract.
- `rejected`: the candidate failed a recorded project or technical requirement.
- `approved_for_local_review`: suitable for local review only; not an engine-asset verdict.

Do not write `approved`, `formal`, `Unity-ready`, `Verified`, or `EXPERIENCE_READY` from Grok workflow success alone.

When the user separately authorizes download or project intake, record the downloaded file path, byte size, and SHA-256. Preserve the original before resize, crop, recolor, alpha cleanup, or other derivative work.
