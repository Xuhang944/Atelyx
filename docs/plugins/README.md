# Atelyx 插件开发指南

Atelyx 是一个插件化平台：插件 = 一个 GitHub 仓库，含一份 `atelyx.json` 清单 + 入口脚本 + 资源。
给仓库打上 `atelyx-plugin` topic，即可被市场自动收录，任何 Atelyx 用户都可在内置市场中找到并安装。

插件可扩展八类能力，按运行平面分两组：

## 插件类型

| 类型 | 说明 | 运行平面 |
| --- | --- | --- |
| `tool` | AI 工具/命令（模型可调用） | worker（隔离上下文） |
| `background` | 后台常驻服务（无界面，订阅事件） | worker（隔离上下文） |
| `command` | 全局命令（菜单/快捷键等执行入口） | worker（逻辑经桥 RPC） |
| `panel` | 工作区面板视图 | 主线程（React UI） |
| `setting` | 设置页条目 | 主线程（React UI） |
| `app` | 应用级页面/模式（可全页接管） | 主线程（React UI） |
| `node` | 画布节点 | 主线程（React UI） |
| `theme` | UI 皮肤（CSS 变量，声明式，无需代码） | 声明式（仅清单） |

> 一个插件可同时属于多类：清单 `type` 为主分类，`types` 可列出附加分类；同时含 worker 逻辑与 UI 时，
> worker 逻辑写进 `main`，UI 入口写进 `mainUi`，两个平面都会加载。

## 两个运行平面

- **worker 平面**（`tool`/`background`/`command`）：入口 `main` 在独立的 Web Worker 中执行。
  与 App 隔离：没有 `window`、没有系统命令访问，只能通过 `bridge` 对象与 App 通信（注册工具/命令、读写自身状态、订阅事件）。单个插件崩溃不影响 App。
- **主线程平面**（`panel`/`setting`/`app`/`node`）：入口 `mainUi` 在主线程执行，可渲染 React 界面；
  未声明 `mainUi` 时，仅**无 worker 平面**（不属 tool/background/command）的插件才缺省用 `main` 作为 UI 入口。
  与 App 同上下文，经 `window.__atelyxPlugin__` 的 facade 注册贡献。

详见 [清单格式](manifest.md) 与 [桥 API](bridge-api.md)。

## 快速开始

1. 复制 `docs/plugins/example/hello-tool/` 到你自己的 GitHub 仓库（或从零按[清单格式](manifest.md)写）。
2. 开发工具/命令逻辑，用 `bridge.registerTool(...)` / `bridge.registerCommand(...)` 注册。
3. 打包：把 `atelyx.json` 与入口脚本打成 zip（zip 根含 `atelyx.json`，或置于唯一顶层目录）。
4. 在 GitHub Release 上传 zip 资产。
5. 给仓库打 `atelyx-plugin` topic。
6. 市场聚合每 6 小时刷新一次，之后即可在 Atelyx 的市场中搜到并安装。

[打包与发布检查清单 →](publishing.md)
