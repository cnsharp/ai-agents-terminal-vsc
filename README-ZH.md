# AI Agents Terminal

在 VS Code 状态栏一键启动本机已安装的 AI CLI 编程助手（Claude Code / Codex / Cursor / …），并在带 logo 的终端标签页中打开。支持 YOLO（自动放行）模式，按安装情况过滤，并可自由增删配置——无需改代码即可定制。

## 功能

- **状态栏启动器**：右下角 `✨ AI Agents` 按钮 → 弹出 Quick Pick，只列出 PATH 上**已安装**的 agent（带 logo），点选即在终端标签页打开。
- **YOLO 模式**：状态栏 `Y` 按钮或快捷键 `Ctrl/Cmd+Alt+Y` 切换；开启后启动 agent 时自动附加各自的自动放行参数（如 Claude 的 `--dangerously-skip-permissions`）。
- **Resume 模式**：状态栏历史按钮 `$(history)` 或快捷键 `Ctrl/Cmd+Alt+R` 切换；开启后启动 agent 时自动附加各自的 `resumeFlag`（如 Claude 的 `-r`），继续最近的会话。
- **数据驱动**：内置 18 个 agent（定义在仓库根 `agents.json`），可在设置里覆盖参数 / 隐藏 / 添加自定义 agent，无需改代码。
- **终端 profile**：已安装的 agent 会注册为 Terminal profile，出现在 `Terminal: Select Default Profile`（可按安装过滤，用作默认终端）。

## 安装

### 从源码运行（开发 / 试用）

1. 安装依赖：`npm install`
2. 编译：`npm run compile`（或 `npm run watch` 监听改动）
3. 按 **F5** 打开“扩展开发宿主”窗口（Extension Development Host），新窗口状态栏即出现 `✨ AI Agents`。

### 打包 / 安装 VSIX

- 打包：`npx @vscode/vsce package`（生成 `*.vsix`）
- 安装：VS Code 中 `Extensions: Install from VSIX...` 选择生成的文件。

## 使用

### 启动一个 agent

- 点击状态栏右下角 `✨ AI Agents`，在 Quick Pick 中选择（只列出本机已安装的），即在新终端标签页打开。
- 或命令面板运行 `AI Agents`（命令 id `ai-agents-terminal.openMenu`）。
- Quick Pick 底部固定一个 `Settings` 项，可直接打开本扩展的设置页。

### YOLO 模式（自动放行）

- 点击状态栏 `Y` 按钮，或快捷键 `Ctrl+Alt+Y`（macOS `Cmd+Alt+Y`）。
- 开启后按钮高亮；启动 agent 时自动附加该 agent 的 `yoloArgs`。

### Resume 模式（继续会话）

- 点击状态栏历史按钮 `$(history)`，或快捷键 `Ctrl+Alt+R`（macOS `Cmd+Alt+R`）。
- 开启后按钮高亮；启动 agent 时自动附加该 agent 在 `agents.json` 里定义的 `resumeFlag`（例如 Claude `-r`、Codex `--resume`、Cursor `--resume`），从而继续上一次会话。没有 `resumeFlag` 的 agent（如 Continue、Kimi、Qoder）即使开启也不会附加任何参数。
- YOLO 与 Resume 可同时开启，参数顺序为 `baseArgs` → `yoloArgs` → `resumeFlag`。

### 配置 agent（无需改代码）

设置项 **`aiAgentsTerminal.agents`** 是与 `agents.json` 内置目录**合并**的覆盖 / 新增列表：按 `command` 匹配内置项进行覆盖（只改你填的字段）；把 `enabled` 设为 `false` 可隐藏某内置项；用一个不在 `agents.json` 里的 `command` 即可新增自定义 agent。

- **编辑**：内置项都在仓库根 `agents.json` 里；要改某内置项，在设置里追加一条同 `command` 的覆盖条目（只写要改的字段即可）。
- **覆盖参数**：只改要改的字段，例如把 `claude` 的 `yoloArgs` 改成 `["--new-flag"]`。
- **隐藏**：删除该条目，或保留条目并把 `enabled` 设为 `false`。
- **添加自定义 agent**：追加一条 `command` 不在内置列表里的条目，例如：

  ```json
  { "command": "myagent", "displayName": "My Agent", "baseArgs": ["run"], "iconFile": "myagent.png" }
  ```

  （省略 `iconFile` 则使用默认终端图标。）
- **生效时机**：改动在下次打开下拉时生效（运行时实时读取，无需重载窗口）。

字段：`command`（必填）/ `displayName` / `baseArgs` / `yoloArgs` / `resumeFlag` / `iconFile` / `enabled` / `id`。

> 唯一性：`command`、`displayName`、`id` 三者各自必须唯一；发现重复时扩展会提示并丢弃重复项（保留首次出现）。

### 内置 agent 列表（18）

| id | 显示名 | 命令 (PATH 探测) | logo |
|---|---|---|---|
| claude | Claude Code | `claude` | claude.png |
| codex | Codex | `codex` | codex.png |
| cline | Cline | `cline` | cline.png |
| codebuddy | CodeBuddy | `codebuddy` | codebuddy.png |
| continue | Continue | `cn` | continue.png |
| copilot | Copilot | `copilot` | copilot.png |
| cursor | Cursor | `cursor-agent` | cursor.png |
| gemini | Gemini | `gemini` | gemini.png |
| goose | Goose | `goose` | goose.png |
| hermes | Hermes | `hermes` | hermes.png |
| kilo | Kilo Code | `kilo` | kilo.png |
| kimi | Kimi | `kimi` | kimi.png |
| openclaw | OpenClaw | `openclaw` | openclaw.png |
| opencode | OpenCode | `opencode` | opencode.png |
| pi | Pi | `pi` | pi.png |
| qoder | Qoder | `qoder` | qoder.png |
| trae | TraeCode | `traecli` | trae.png |
| zcode | ZCode | `zcode` | zcode.png |

> logo 位于 `media/agents/`（PNG）。下拉只显示 displayName，不显示 command / id。

### 终端 profile（Terminal: Select Default Profile）

每个**已安装**的 agent 会在运行时通过 `registerTerminalProfileProvider` 注册为 Terminal profile，出现在命令面板的 `Terminal: Select Default Profile` 中，可用作默认终端；终端图标为 agent logo。

> 平台限制：在此 VS Code 构建中，扩展 profile **不会**出现在终端 `+` 号下拉或标题栏菜单，只出现在 `Select Default Profile`（见下方“平台限制”）。

## 设置参考

| 设置 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `aiAgentsTerminal.yoloMode` | boolean | `false` | YOLO 总开关；开启后启动 agent 附加各自 `yoloArgs` |
| `aiAgentsTerminal.resumeMode` | boolean | `false` | Resume 总开关；开启后启动 agent 附加各自 `resumeFlag` |
| `aiAgentsTerminal.agents` | array | `[]` | 与 agents.json 合并的覆盖 / 新增（见上） |
| `aiAgentsTerminal.installedAgents` | array（隐藏） | `[]` | 已探测到的 agent 命令缓存，自动维护，**勿手动修改** |

命令：

| 命令 id | 标题 | 触发 |
|---|---|---|
| `ai-agents-terminal.openMenu` | AI Agents | 状态栏按钮 / 命令面板 |
| `ai-agents-terminal.toggleYoloMode` | AI Agents: Toggle YOLO Mode | `Y` 按钮 / `Ctrl+Alt+Y`（macOS `Cmd+Alt+Y`） |
| `ai-agents-terminal.toggleResumeMode` | AI Agents: Toggle Resume Mode | `$(history)` 按钮 / `Ctrl+Alt+R`（macOS `Cmd+Alt+R`） |

## 二次开发

### 环境

- Node.js + npm
- VS Code `^1.85.0`
- TypeScript `^5.4.0`

### 构建与调试

- `npm install` 安装 devDependencies（`typescript` / `@types/node` / `@types/vscode`）。
- `npm run compile` 编译 `src/*.ts` → `out/`（tsc 直接编译，无打包步骤）。
- `npm run watch` 监听改动热编译。
- **F5** 启动扩展开发宿主，在 `src/extension.ts` 中打断点调试。

### 项目结构

```
ai-agents-vsc/
├── package.json          # 清单：name=ai-agents-terminal, publisher=cnsharpstudio
│                         #   contributes.configuration: yoloMode / agents / installedAgents
│                         #   contributes.commands + keybindings
├── tsconfig.json         # TS 配置 (outDir=out, rootDir=src)
├── src/
│   ├── extension.ts      # 入口：注册命令 + 状态栏按钮；QuickPick 列出已安装 agent；
│   │                     #   动态注册 Terminal profile (registerTerminalProfileProvider)
│   ├── agents.ts         # 从 agents.json 加载内置目录 + resolveAgents()/getAgentConfigWarnings()
│   │                     #   （合并内置与 aiAgentsTerminal.agents 设置，去重校验）
│   └── agentDetector.ts  # isInstalled()：运行 `<command> --version` 探测 PATH
│                         #   （登录 shell -lc，兼容 nvm/fnm/brew/npm-global；win32 用 where）
├── media/agents/         # agent logo（PNG）
├── .vscode/              # launch.json (Run Extension) + tasks.json (npm compile)
└── out/                  # 编译产物 (tsc)
```

### 架构要点

1. **启动器（状态栏）**：`activate()` 先刷新“已安装”缓存（`refreshInstalledCache`，跨窗口只探测一次 PATH），状态栏 `✨ AI Agents` 按钮打开 Quick Pick，只列缓存中已安装的 agent；选取后用 `vscode.window.createTerminal` 以 agent 的 `command` + `baseArgs`（YOLO 时附加 `yoloArgs`）启动，并带上 logo 图标。
2. **已安装探测**：`isInstalled(command)` 在登录交互式 shell 中执行 `<command> --version`，退出码 0 视为已安装；结果缓存进全局设置 `installedAgents`，避免每个窗口重复探测 PATH。`agentDetector.ts` 在 macOS/Linux 用 `$SHELL -lc`、Windows 用 `where`，因此能识别 rc 文件注入的 PATH（nvm / fnm / brew / npm-global 等）。
3. **终端 profile（按安装过滤）**：`registerInstalledTerminalProfiles()` 对**已安装**的 agent 逐个注册 `TerminalProfileProvider`，因此 `Terminal: Select Default Profile` 里只出现装了的，未装的不会列出。这是相对 `contributes.terminal.profiles` 静态声明（无法按安装过滤）的改进。
4. **设置驱动**：`resolveAgents()` 把 `agents.json` 内置目录与 `aiAgentsTerminal.agents` 设置按 `command` 合并，并做 `command` / `displayName` / `id` 唯一性校验（`getAgentConfigWarnings` 输出告警）。

### 如何新增一个 agent

两种方式，按是否要提交代码区分：

**方式 A：仅用设置（推荐，用户侧，免编译）**

在 `settings.json` 的 `aiAgentsTerminal.agents` 追加一条：

```json
{ "command": "myagent", "displayName": "My Agent", "baseArgs": [], "yoloArgs": ["--auto"], "iconFile": "myagent.png" }
```

把 logo 放到 `media/agents/myagent.png` 即可，无需重新编译。

**方式 B：加为内置（代码侧）**

1. 编辑仓库根目录的 `agents.json`，追加一项（`id` / `command` / `displayName` / `baseArgs` / `yoloArgs` / `iconFile`）。
2. 把对应 PNG 放进 `media/agents/`。
3. `npm run compile` 后重载窗口。

> 注意：运行期设置是权威来源。若用户已覆盖 `aiAgentsTerminal.agents`，内置新增项需用户在其设置里也加一条（或删除覆盖以恢复默认 18 个）。

### 平台限制（非代码 bug）

- 扩展的 Terminal profile **不**出现在终端 `+` 号下拉 / 标题栏菜单，只出现在 `Terminal: Select Default Profile`（该 VS Code 构建的行为，已验证）。
- 日常一键启动请用状态栏 `✨ AI Agents` 按钮，最稳定可靠。
