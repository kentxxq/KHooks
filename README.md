# KHooks

[变更日志](CHANGELOG.md)

## 工作流 CLI

KHooks 运行时，可以用 CLI 导入 AI 生成的 `{ name, nodes, edges }` 工作流 JSON。默认保存为停用草稿，传入 `--enable` 后立即启用。Windows 安装目录中的 `khooks.cmd` 使用 Electron 内置的 Node.js。

```powershell
$flow = .\khooks.cmd workflow create .\workflow.json --enable | ConvertFrom-Json
.\khooks.cmd workflow get $flow.id
```

在仓库里可用 `vp exec node scripts/khooks.mjs` 运行相同命令。命令默认连接正式版；连接 Windows 开发版时，加上 `--profile-path "$env:APPDATA\KHooks Dev"`。
