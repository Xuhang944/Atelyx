# 桥 API：插件与 App 的通信接口

插件按运行平面通过两类接口与 App 通信：

## worker 平面（tool / background / command）

入口在独立 Web Worker 中执行，全局有一个 `bridge` 对象。**worker 内没有 `window`，
没有系统命令访问，插件只能经 `bridge` 触达 App 能力。**

### 注册 AI 工具

```js
bridge.registerTool({
  name: "hello",                 // 工具名（发给模型的 id）
  description: "打招呼",          // 工具描述
  parameters: {                  // JSON Schema 参数
    type: "object",
    properties: { name: { type: "string", description: "称呼" } }
  },
  execute: async (args) => {
    // args = 模型生成的参数对象
    return { ok: true, summary: `你好，${args.name ?? "世界"}！` };
    // 失败返回 { ok: false, summary: "原因" }；content 字段可作为详细结果文本
  },
  parallelSafe: true             // 可选：只读/无副作用工具标 true，可并行执行
});
```

注册后工具出现在设置页 Agent 的「插件」分组，勾选后即可被模型调用。

### 注册命令

```js
bridge.registerCommand({
  id: "greet",
  label: "打招呼",
  run: async () => { /* 执行逻辑 */ }
});
```

### 读写自身状态（持久化）

```js
const state = await bridge.stateRead();      // 读插件自持数据（JSON 对象）
await bridge.stateWrite({ lastRun: Date.now() }); // 写（原子落盘）
```

### 订阅应用事件

```js
bridge.on("vault:switch", (payload) => {
  // payload = { root, id }：仓库切换
});
bridge.on("vault:clear", () => { /* 回到仓库选择页 */ });
```

### 初始化完成

```js
bridge.ready(); // 顶层逻辑跑完时调用（可选；首个任意 bridge 调用即视为已激活）
```

## 主线程平面（panel / setting / app / node）

入口在主线程执行，可渲染 React 界面。代码经 `window.__atelyxPlugin__.forPlugin(插件id)`
取得 facade。**主线程插件与 App 同上下文**——这是「声明 + 提醒」信任模型：请只经 facade
注册贡献，不要绕过它访问 App 内部。

```js
const { React, h, registerPanel } = window.__atelyxPlugin__.forPlugin("com.example.hello");

function MyPanel() {
  return h("div", { style: { padding: 12 } }, "面板内容");
}
registerPanel({ kind: "com.example.hello.panel", label: "我的面板", component: MyPanel });
```

> 主线程 UI 代码运行在浏览器环境、不经过构建编译：**用 `React.createElement`（或 `h` 简写）而非 JSX**。

facade 提供：

- `registerPanel({ kind, label, component })` — 注册工作区面板视图（kind 即视图类型，出现在「添加视图」菜单）
- `registerSetting({ key, label, component })` — 注册设置页条目（出现在设置左侧栏）
- `registerAppPage({ id, label, component })` — 注册应用级页面（插件命令可经 App 能力打开，全页接管）
- `registerNode({ type, component })` — 注册画布节点类型
- `registerCommand({ id, label, run })` — 注册全局命令（直接持有 run 函数）
- `React` / `h` — 构建组件所用

## 事件一览

| 事件 | payload | 说明 |
| --- | --- | --- |
| `vault:switch` | `{ root, id }` | 进入/切换仓库 |
| `vault:clear` | — | 回到仓库选择页 |

## 能力声明与敏感能力

桥的调用以清单 `uses` 为准：**敏感能力（`keychain:read` / `shell` / `vault:delete`）未声明即拒绝**；
非敏感能力放行并计入审计（详情页可对照声明 vs 实际）。请如实声明插件用到的能力。
