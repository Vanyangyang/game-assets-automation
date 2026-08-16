---
name: grok-imagine-operations
description: Operate the dedicated local Grok Imagine Chrome profile through the Game Assets Automation plugin. Use when the user asks to check Grok CDP or MCP status, start or stop the dedicated browser, inspect visible Grok page state, take a review screenshot, execute a bounded workflow, or archive Grok candidate metadata. Always require a fresh explicit user confirmation immediately before any action that can submit generation or consume quota. Do not use for host-native image APIs, ordinary web browsing, engine-asset acceptance, or reading browser cookies, passwords, session databases, or authentication headers.
---

# Grok Imagine Operations

Use this skill for the browser/tool execution layer only. A host game project may load its own visual-grammar or asset-pipeline skill for presets, candidate judgment, output paths, and engine delivery. Never let this plugin promote a Grok result to a formal project asset.

## Paths

Resolve the plugin root two directories above this skill folder. Use:

- Worker: `scripts/grok-cdp-worker.mjs`
- Start: `scripts/Start-GrokChrome.ps1`
- Stop: `scripts/Stop-GrokChrome.ps1`
- Read-only smoke workflow: `scripts/workflows/smoke-readonly.json`
- State root: existing `%LOCALAPPDATA%\VESPERIX\GrokCdp` if present, otherwise `%LOCALAPPDATA%\GameAssetsAutomation\GrokCdp`

Do not create another browser profile or reuse the user's daily Chrome profile.

## Host defaults

| Host | Port | Profile directory name |
|---|---|---|
| Cursor | `9334` | `ChromeProfileCursor` |
| Codex / Claude / Grok | `9333` | `ChromeProfile` |

Default agent is `cursor` unless `GAA_GROK_AGENT=codex` is set. Pass `-Agent cursor|codex` to the start/stop scripts, and `--port` to the worker when the environment is unset.

## Operating sequence

1. Run `node.exe <worker> status` before any Grok operation. From Cursor, that is port `9334` by default.
2. If status succeeds, reuse the existing browser. If it fails and the requested task needs Grok, run the bundled start script once and recheck status.
3. Determine the operation risk before invoking a workflow:
   - `READ_ONLY`: status, targets, snapshot, assertions, and non-writing page inspection.
   - `LOCAL_STATE`: browser start/stop, navigation, screenshots, and local artifact writes.
   - `QUOTA_RISK`: fill, click, key press, arbitrary page evaluation, generation, editing, variants, resize, or any action that might submit work.
4. For `QUOTA_RISK`, stop immediately before execution and obtain a fresh explicit user confirmation that names the workflow or intended submission. Then pass the workflow `confirmationId` with `--confirm-quota=<same-id>`. Prior general authorization or an earlier confirmation does not satisfy this gate.
5. Run the workflow, inspect its terminal result, and report the manifest path. A submitted prompt is not a generated result.
6. Keep every output classified as a candidate until the owning project pipeline accepts it and downstream runtime verification is complete.

Read [workflow-contract.md](references/workflow-contract.md) before authoring or changing a workflow. Read [artifact-provenance.md](references/artifact-provenance.md) when results or downloads must be archived. Read [page-guide.md](references/page-guide.md) when Grok controls or visible account state must be inspected.

## Safety boundaries

- Use only visible page state to infer login or subscription status.
- Never read cookies, credential stores, password databases, browser profile databases, authentication headers, local storage tokens, or session secrets.
- Keep Cursor CDP on `127.0.0.1:9334` and Codex CDP on `127.0.0.1:9333`; do not expose either to the LAN.
- Do not browse unrelated sensitive sites in the dedicated profile while CDP is open.
- Prefer the Worker for any state-changing workflow. Use the slim MCP tools for read-only inspection and bounded troubleshooting; direct MCP evaluation must not bypass the quota confirmation contract.
- Do not auto-download, rename, move into a project, modify engine assets, or commit Git unless the user explicitly requests that separate action.
- Stop after the declared workflow. Do not retry quota-consuming work beyond the user's confirmed batch.

## Validation boundary

Successful status, snapshot, screenshot, workflow completion, or file download proves only that the covered tool action worked. It does not prove image quality, alpha correctness, crop, frame alignment, species-defining features, engine import correctness, or runtime appearance.
