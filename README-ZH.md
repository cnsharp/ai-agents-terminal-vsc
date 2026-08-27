# AI Agents Terminal（演示版）

一个极简的演示扩展：在 VS Code 清单里以**静态终端 profile** 的方式声明两个 AI CLI 编程助手 ——
**Claude Code** 和 **Codex**。VS Code 会内置终端中展示它们；**没有状态栏**、**没有运行时目录**、
**也没有自定义 UI**。Agent 列表完全写在 `package.json` 里。

## 功能

- 在 `package.json` 的 `contributes.terminal.profiles` 中声明 `claude` 与 `codex`。
- VS Code 会在 **Terminal: Select Default Profile（选择默认终端）** 和新建终端下拉里展示它们，
  选中即可在终端标签页中打开。
- 仅此而已：没有 YOLO 模式、没有 Resume 模式、没有设置页、没有安装检测。

## 安装

### 从源码运行（试用）

1. `npm install`
2. `npm run compile`
3. 按 **F5** 打开扩展开发宿主窗口；然后打开 **Terminal: Select Default Profile**，
   即可看到 *Claude Code* 和 *Codex*。

### 打包为 VSIX

- `npx @vscode/vsce package` → 生成 `*.vsix`
- 通过 **Extensions: Install from VSIX...** 安装

## 使用

打开终端下拉 / **Terminal: Select Default Profile**，选择 **Claude Code** 或 **Codex**，
Agent 会在新的终端标签页中启动。

## 不用装插件（直接改 settings.json 即可）

本演示只是贡献了两个静态终端 profile —— 而这本是 VS Code 原生就支持的能力。
你完全不必安装这个扩展，只需在自己的 `settings.json` 里加上这两个 profile 即可：

```jsonc
// settings.json（用户或工作区作用域）
"terminal.integrated.profiles.osx": {
  "Claude Code": { "path": "claude", "icon": "$(sparkle)" },
  "Codex":       { "path": "codex",  "icon": "$(sparkle)" }
}
// 其他平台请用 terminal.integrated.profiles.linux / .windows
```

它们会出现在 **Terminal: Select Default Profile** / 新建终端下拉里，与贡献的 profile 效果完全一致。
这个扩展唯一的好处是“一键分发”（一个 VSIX），省去手改 JSON —— 除此之外没有任何额外行为。

**`settings.json` 在哪里？**

- **macOS**：`~/Library/Application Support/Code/User/settings.json`
- **Windows**：`%APPDATA%\Code\User\settings.json`
- **Linux**：`~/.config/Code/User/settings.json`
- 工作区级（按项目）：`<project>/.vscode/settings.json`

也可以从命令面板打开： **Preferences: Open User Settings (JSON)**（全局）或
**Preferences: Open Workspace Settings (JSON)**（项目级）。

## 新增或修改 Agent

因为配置是静态写在 `package.json` 里的，直接编辑 `contributes.terminal.profiles` 数组即可：

```json
"contributes": {
  "terminal": {
    "profiles": [
      { "id": "claude", "title": "Claude Code", "icon": "$(sparkle)", "shellPath": "claude" },
      { "id": "codex", "title": "Codex", "icon": "$(sparkle)", "shellPath": "codex" }
    ]
  }
}
```

然后 `npm run compile` 并重新加载窗口。每个 profile 支持常用字段
（`id`、`title`、`icon`、`shellPath`、`shellArgs`、`args`、`env`、`cwd`）。

> `shellPath` 会按 `PATH` 解析，因此直接写 `claude` 这样的命令名即可。

## 项目结构

```
ai-agents-vsc/
├── package.json     # 清单：name=ai-agents-terminal
│                    #   contributes.terminal.profiles：claude / codex（静态）
├── tsconfig.json    # TS 配置（outDir=out, rootDir=src）
├── src/
│   └── extension.ts # 极简入口（activate 为空）
└── out/             # 构建产物（tsc）
```

## 平台限制（非代码问题）

在某些 VS Code 版本中，贡献的终端 profile 可能**不会**出现在终端 `+` 号下拉或标题栏菜单里 ——
它们可靠地出现在 **Terminal: Select Default Profile** 中。这是 VS Code 的行为，本演示无法控制。
