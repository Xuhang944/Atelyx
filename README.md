<div align="center" style="padding:4px 0 12px">

[English version →](docs/README_EN.md)

</div>

<div align="center" style="background:#17171a;border:1px solid #2a2a2e;border-radius:16px;padding:48px 24px 40px;margin:0 0 32px">

<img src="src-tauri/icons/icon.png" alt="Atelyx" width="92">

<h1 style="color:#E5E0D5;font-weight:700;letter-spacing:3px;margin:16px 0 10px">ATELYX</h1>

<p style="color:#D4AF37;font-size:17px;font-weight:600;margin:0 0 14px">对话不再是线性的，而是画布上的有向图</p>

<p style="color:#8b8b8b;max-width:660px;margin:0 auto 30px;font-size:15px;line-height:1.8">
以人为中心的桌面创作工作台：把AI对话、笔记、知识库、搜索、表格等统一成一张有向图。连线即数据流，节点即资产——思考，不该被打断。
</p>

<span style="background:#D4AF37;color:#1C1C1E;border-radius:999px;padding:4px 18px;font-size:13px;font-weight:700;margin:0 4px">Windows</span>
<span style="border:1px solid #5a5a5e;color:#9a9a9e;border-radius:999px;padding:3px 17px;font-size:13px;font-weight:600;margin:0 4px">Linux · 目标平台</span>
<span style="border:1px solid #5a5a5e;color:#9a9a9e;border-radius:999px;padding:3px 17px;font-size:13px;font-weight:600;margin:0 4px">Apache-2.0</span>

</div>

## 设计哲学

一场与 AI 的对话，不该是一条只能前进的时间线——分支多了就再也看不清对比；上下文无法跨对话复用；素材用完即弃。Atelyx 用一张无限画布重新组织这一切：

<div style="border:1px solid #2a2a2e;border-left:3px solid #D4AF37;border-radius:8px;padding:14px 20px;margin:14px 0">

**01 · 对话是有向图，不是聊天记录** — 每次分支都是画布上的一个新节点，继承父链完整状态、独立演化。分支再多，也可以并排摆放、横向对比，看清每条路的来龙去脉。

**02 · 连线即数据流** — 箭头从产出方指向消费方；实线表示已被消费、虚线表示待消费。数据流边不可手动断开——引用语义即数据语义。

**03 · 引用即边，边即引用** — 在输入框输入 `@` 提及，与从节点边框拉出一条线，是同一条边的两种操作方式。

**04 · 产物即节点** — 联网搜索的结果、粘贴的素材、对话中提炼的段落，都会自动沉淀为画布上的可复用资产，接入任意对话。

**05 · 文件即仓库** — 没有数据库。画布、笔记、附件都是普通文件，可积累、可备份、可 Git 同步，也可被外部编辑器打开并实时同步回来。

</div>

## 缘起

创作最怕的不是没灵感，而是思路被打断。写剧本时，素材在写作软件里，分镜在表格软件里，沟通又要切回聊天工具——每个环节单看都顺手，可每切换一次，思路就断一次。

Atelyx 的起点正是这样的「切来切去」。我们想：如果对话、笔记、素材、表格都摊在同一张画布上，随手可取、随手可连，思路是不是就不用断了？于是有了 Atelyx——它未必给你更多灵感，但至少，思考不再被工具打断。

## 核心概念

```
+------------+           +------------+
| 对话节点 A | --分支-->  | 对话节点 B |
+------+-----+           +------------+
       | 提取：段落拉出为文本节点
       v
+------------+
|  文本节点  |
+------+-----+
       | @ 提及 / 拉线引用（虚线 -> 实线）
       v
+------------+                 +-------------+
| 对话节点 C | --AI 自主联网--> | 搜索结果节点 |
+------+-----+                 +-------------+
       | 接入：媒体节点 / 表格节点
       v
  继续对话 / 再分支……
```

- **对话节点**：与 AI 的多轮对话，可流式输出、分支、拉线引用资产
- **文本节点**：从对话中提炼的段落，可编辑、可再接入任意对话作为提示词
- **媒体节点**：粘贴/拖拽的图片与文件，作为多模态附件注入对话
- **搜索结果节点**：AI 在对话中自主联网搜索的产物
- **表格节点**：仓库多维表格的引用，按字段名组装快照注入对话
- **分组 / 链接节点**：画布组织与外部 URL 卡片

## 核心特性

| | |
| --- | --- |
| **无限画布 · 分支演化** | 对话不是时间线，而是画布上的节点；分支继承父链完整状态独立演化，思路再多也能并排对比 |
| **连线即数据流** | 引用即边：`@` 提及与拉线是同一操作；实线 = 已消费、虚线 = 待消费，产物可跨对话复用 |
| **产物自动沉淀** | 联网搜索的结果、粘贴的素材、提炼的段落自动成为可复用节点，随时接入任意对话 |
| **笔记编辑器** | 实时预览编辑；frontmatter 属性内联编辑；双链 + 缺失链接快捷新建；反链自动发现 |
| **多维表格** | 类型化字段与多图单元格；时间线视图 + 预演播放；AI 辅助填行；xlsx 导出 |
| **文件化仓库** | 无数据库、全文件存储；笔记可被外部编辑器打开并实时同步；重命名联动全仓库引用与内部链接 |

## 界面示意

<div align="center">

<img src="docs/screenshots/canvas.svg" alt="无限画布：对话分支与数据流" width="100%">

<img src="docs/screenshots/table.svg" alt="多维表格：时间线与预演" width="100%">

<img src="docs/screenshots/note.svg" alt="笔记编辑器：实时预览与反链" width="100%">

<img src="docs/screenshots/workspace.svg" alt="工作区：面积网格布局" width="100%">

</div>

## 安装

从 [GitHub Releases](https://github.com/Xuhang944/Atelyx/releases) 下载对应平台安装包：

| 平台 | 安装包 |
| --- | --- |
| Windows 10/11（x64） | `.msi` / `.exe` |
| Linux（Wayland 原生，兼容 X11） | 目标平台——构建验证后发布安装包 |

或从源码构建：

```bash
pnpm install         # 安装前端依赖
pnpm run tauri:dev   # 启动开发（自动开 Vite + Tauri 窗口）
pnpm run tauri:build # 打包
```

前置要求：Node.js 18+、pnpm、Rust（stable）、Tauri 2 系统依赖（见 [Tauri 官方文档](https://v2.tauri.app/start/prerequisites/)）。

## 仓库文件一览

仓库 = 你自选的本地文件夹，没有数据库，一切以文件沉淀：

```
我的仓库/
├── .atelyx/        仓库级配置（隐藏目录；API key 不落盘，走系统 keychain）
├── 项目A/
│   ├── 画布.atlx   画布文件（一个画布一个 JSON）
│   ├── 表格.atb    多维表格文件
│   ├── 提示词.md   笔记（可被外部编辑器打开）
│   └── 素材/       附件（图片 / 文件）
└── 直接放根目录.md  根目录文件同样支持
```

- `.atlx` / `.md` / 附件按扩展名识别，可位于任意文件夹（含根目录）
- 文本与媒体节点只存路径引用，内容在独立文件——可跨画布共享、删画布不删文件
- 外部编辑 `.md` / 附件 / 画布，实时同步回应用

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面壳 | Tauri 2（Rust 后端，Wayland 原生） |
| 前端 | React 18 + TypeScript + Vite |
| 画布 | React Flow |
| 状态 | Zustand |
| 样式 | TailwindCSS + lucide-react |
| Markdown | react-markdown（GFM / 代码高亮 / KaTeX 数学公式 / 防 XSS）；CodeMirror 6 实时预览编辑 |
| 存储 | 文件化仓库（无数据库）+ `notify` 实时监听外部编辑 |
| AI | OpenAI 兼容多供应商，前端直连 SSE 流式；API key 存 OS keychain |
| 搜索 | Tavily API + SearXNG 自建实例 |

## 开发命令

```bash
pnpm run dev        # Vite 开发服务器
pnpm run check      # 类型检查 + ESLint
pnpm run format     # Prettier 格式化
pnpm run tauri:dev  # 启动开发（自动开 Vite + Tauri 窗口）
pnpm run tauri:build # 打包
```

## 隐私与安全

- **API key 默认仅存系统 keychain**（按仓库隔离），不落仓库文件、不进日志；可选「随仓库保存」以支持多设备同步
- 自动更新安装包带签名校验，校验失败拒绝安装

## 参与贡献

- 提 Bug / 需求：[Issues](https://github.com/Xuhang944/Atelyx/issues)
- 提交 Pull Request：请先阅读 [贡献准则](docs/CONTRIBUTING.md)

## License

[Apache-2.0](LICENSE)
