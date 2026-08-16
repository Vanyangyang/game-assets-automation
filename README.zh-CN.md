# game-assets-automation

[English](./README.md) · [Issues](https://github.com/Vanyangyang/game-assets-automation/issues)

给游戏资产生产用的 **Grok Imagine** 浏览器自动化。插件只连本机专用 Chrome 配置，走 CDP；不替代宿主项目的视觉语法、资产验收或引擎导入检查。

这个仓库是 **Cursor / Codex / Claude Code / Grok Build** 的共用真源。Cursor 和 Codex 用两套独立 Chrome 配置，可以同时保持登录。

## 宿主隔离

| 宿主 | CDP | 配置目录名 | MCP 配置 |
|---|---|---|---|
| Cursor | `127.0.0.1:9334` | `ChromeProfileCursor` | `mcp.json` |
| Codex / Claude / Grok | `127.0.0.1:9333` | `ChromeProfile` | `.mcp.json` |

状态不进仓库。如果已经有 `%LOCALAPPDATA%\VESPERIX\GrokCdp`，worker 会复用它，避免丢掉现有登录。新机器用 `%LOCALAPPDATA%\GameAssetsAutomation\GrokCdp`。

## Cursor

本地开发安装：

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.cursor\plugins\local\game-assets-automation" `
  -Target "C:\Users\Administrator\plugins\game-assets-automation"
```

然后重载 Cursor（`Developer: Reload Window`）。插件会提供：

- skill `grok-imagine-operations`
- 命令 `/grok-imagine-status` 和 `/grok-imagine-start`
- 瘦身 MCP `grok-imagine-browser`，挂到 `127.0.0.1:9334`

先启动专用浏览器，再使用 MCP：

```powershell
powershell.exe -NoProfile -File scripts/Start-GrokChrome.ps1 -Agent cursor
node.exe scripts/grok-cdp-worker.mjs status --port 9334
```

如果页面是登录页，在这个专用窗口里登录。不要复用日常 Chrome 配置。

## 安全

- `READ_ONLY`：status / snapshot / wait / assert。
- `LOCAL_STATE`：启停、导航、截图。
- `QUOTA_RISK`：填写、点击、生成、上传、下载。每次提交前都要新的明确确认，并带 `--confirm-quota=<confirmationId>`。
- 禁止读 cookie、密码库、配置数据库或鉴权头。
- 工作流跑完只证明工具动作完成，产物仍是候选，不是 Unity / 引擎验收。

## 测试

```bash
npm test
```

覆盖 CLI、域名白名单、风险门、上传下载边界，以及 Cursor/Codex 端口隔离。不会启动 Chrome，也不会提交生成。
