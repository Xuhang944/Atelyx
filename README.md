<div align="center" style="padding:4px 0 12px">

[English version →](docs/README_EN.md)

</div>

<div align="center" style="background:#17171a;border:1px solid #2a2a2e;border-radius:16px;padding:48px 24px 40px;margin:0 0 32px">

<img src="src-tauri/icons/icon.png" alt="Atelyx" width="92">

<h1 style="color:#E5E0D5;font-weight:700;letter-spacing:3px;margin:16px 0 10px">ATELYX</h1>

<p style="color:#D4AF37;font-size:17px;font-weight:600;margin:0 0 14px">把对话、笔记、表格、知识库放进同一张工作台，AI 贯穿、多人可协作</p>

<p style="color:#8b8b8b;max-width:660px;margin:0 auto 30px;font-size:15px;line-height:1.8">
以人为中心的桌面创作工作台：可停靠的多视图工作台与多窗口，让 AI 对话、笔记、知识库、搜索、表格随手可连——多人实时协作，AI 贯穿全程。思考，不该被打断。
</p>

<span style="background:#D4AF37;color:#1C1C1E;border-radius:999px;padding:4px 18px;font-size:13px;font-weight:700;margin:0 4px">Windows</span>
<span style="border:1px solid #5a5a5e;color:#9a9a9e;border-radius:999px;padding:3px 17px;font-size:13px;font-weight:600;margin:0 4px">Linux · Wayland</span>
<span style="border:1px solid #5a5a5e;color:#9a9a9e;border-radius:999px;padding:3px 17px;font-size:13px;font-weight:600;margin:0 4px">Apache-2.0</span>

</div>

## 设计理念

创作最怕的不是没灵感，而是思路被打断。写剧本时，素材在写作软件里，分镜在表格软件里，沟通又要切回聊天工具——每个环节单看都顺手，可每切换一次，思路就断一次。Atelyx 想做的，是让这些不再需要切换：

<div style="border:1px solid #2a2a2e;border-left:3px solid #D4AF37;border-radius:8px;padding:14px 20px;margin:14px 0">

**01 · 一个工作台，安放所有创作** — 对话、笔记、表格、文件、搜索都能在同一工作台并排打开。标签可停靠，面板可撕裂成独立窗口，视图随意组合，各就各位。

**02 · AI 贯穿全程** — 从对话、笔记划词、表格填行，到读取改写仓库文件、联网搜索，AI 是创作流程的一环，而不是一个需要切过去用的独立聊天工具。

**03 · 资产随手可复用** — 素材、搜索结果、提炼的段落都自动沉淀为可复用资产，随时接入任意对话，上下文不再是一次性。

**04 · 知识可以协作** — 局域网内多人实时互见：同编一篇笔记、同改一块画布、同看一张表格。谁在看什么、选中在哪里，一目了然。

**05 · 文件即仓库** — 没有数据库。画布、笔记、附件都是普通文件，可积累、可备份、可 Git 同步，也可被外部编辑器打开并实时同步回来。

</div>

## 特色：无限画布 · 有向图

画布仍是核心特性之一：一场与 AI 的对话，不该是一条只能前进的时间线。分支多了就再也看不清对比；Atelyx 把它变成画布上的节点——每个分支继承父链完整状态、独立演化，再多也能并排摆放、横向对比。

- **对话是有向图，不是聊天记录** — 分支即画布上的新节点；连线表达数据流（产出方 → 消费方）
- **连线即数据流** — 在输入框输入 `@` 提及，与从节点边框拉出一条线，是同一条边的两种操作；实线 = 已被消费、虚线 = 待消费
- **产物即节点** — 联网搜索的结果、粘贴的素材、对话中提炼的段落，都会自动沉淀为画布上的可复用资产

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

## 核心能力

| | |
| --- | --- |
| **可停靠工作区 · 多窗口** | 标签组停靠 + 面板撕裂成独立窗口 + 跨面板拖拽组合；内置画布/笔记/表格三套布局；布局可命名保存、重启恢复；标签可锁定防止误触 |
| **多人实时协作** | 局域网中转，在线成员实时互见（昵称/颜色/选中处高亮）；笔记 Yjs 实时协同 + 远端光标；画布节点/消息即时同步 + 对话独占锁 + 生成中指示灯；表格选中与内容实时互见 |
| **AI 对话与 Agent** | 流式输出、随时分支、思考过程折叠；推理等级与模型两级选择；仓库级 Agent 配置（系统提示词 + 工具）；模型供应商多模型管理、测试连通性、模型昵称 |
| **AI 读写与联网** | Agent 工具：联网搜索、抓取网页、读取/查找/搜索内容/写入/编辑仓库文件 |
| **笔记编辑器** | 实时预览编辑；frontmatter 属性内联编辑；双链 + 缺失链接快捷新建；反链自动发现；划词 AI 改写；多人协作 |
| **多维表格** | 类型化字段与多图单元格；时间线视图 + 预演播放；AI 辅助填行；列宽/行高自适应；撤销/重做；xlsx 导出 |
| **历史记录与回滚** | 画布/笔记/表格版本列表、人话摘要、变更 diff、一键回滚 |
| **文件化仓库** | 无数据库、全文件存储；笔记可被外部编辑器打开并实时同步；重命名联动全仓库引用与内部链接；排除文件夹/附件文件夹可配置 |
| **联网 + 仓库搜索** | 联网搜索（Tavily / 自建 SearXNG）；仓库内文件查找 + 全文搜索；搜索结果沉淀为节点 |

## 界面示意

<div align="center">

<img src="docs/screenshots/canvas.svg" alt="无限画布：对话分支与数据流" width="100%">

<img src="docs/screenshots/table.svg" alt="多维表格：时间线与预演" width="100%">

<img src="docs/screenshots/note.svg" alt="笔记编辑器：实时预览与反链" width="100%">

<img src="docs/screenshots/workspace.svg" alt="工作区：可停靠标签组与多窗口" width="100%">

</div>

## 安装

从 [GitHub Releases](https://github.com/Xuhang944/Atelyx/releases) 下载对应平台安装包：

| 平台 | 安装包 |
| --- | --- |
| Windows 10/11（x64） | `.msi` / `.exe` |
| Linux（Wayland 原生，兼容 X11） | 源码构建 |

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
├── .atelyx/        仓库级配置（隐藏目录：config / agents / prompt-notes / 对话历史 / history；API key 不落盘）
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
| 工作区 | 可停靠标签组 + 多窗口撕裂；面板布局树 |
| 画布 | React Flow |
| 状态 | Zustand |
| 样式 | TailwindCSS + lucide-react |
| Markdown | react-markdown；CodeMirror 6 实时预览编辑 |
| 协作 | Yjs/CRDT 笔记协同 + 自建 WebSocket 中转（Docker 部署，局域网） |
| 存储 | 文件化仓库（无数据库）+ `notify` 实时监听外部编辑 |
| AI | OpenAI 兼容多供应商（含推理等级）；Agent 工具可读写文件、联网；API key 存 OS keychain |
| 搜索 | Tavily API + SearXNG 自建实例 |
| 更新 | 自动更新，安装包签名校验 |

## 开发命令

```bash
pnpm run dev        # Vite 开发服务器
pnpm run check      # 类型检查 + ESLint + 测试
pnpm run format     # Prettier 格式化
pnpm run tauri:dev  # 启动开发（自动开 Vite + Tauri 窗口）
pnpm run tauri:build # 打包
```

## 隐私与安全

- **API key 默认仅存系统 keychain**（按仓库隔离），不落仓库文件、不进日志；可选「随仓库保存」以支持多设备同步
- **多人协作仅限局域网中转**：经自建中转服务实时互见，无云端同步；中转地址与身份（昵称/颜色）由用户配置
- Markdown 渲染禁用原始 HTML（防 XSS）；仓库文件读写做路径校验（限制在仓库根内）
- 自动更新安装包带签名校验，校验失败拒绝安装

## 参与贡献

- 提 Bug / 需求：[Issues](https://github.com/Xuhang944/Atelyx/issues)
- 提交 Pull Request：请先阅读 [贡献准则](docs/CONTRIBUTING.md)

## License

[Apache-2.0](LICENSE)
