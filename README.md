# Atelyx

> AI 创作工作台：对话、笔记、知识库统一成一张有向图，连线即数据流——拉线创建分支、复用产物、横向对比不同走向。AI 贯穿全程：多模型流式对话、联网搜索、产物自动沉淀为画布节点；文件化仓库让画布、笔记、附件以文件形式沉淀为可积累的个人知识库。

## 技术栈

- **桌面壳**：Tauri 2.x（Rust 后端，Wayland 原生支持）
- **前端**：React 18 + TypeScript + Vite
- **画布**：React Flow
- **状态**：Zustand
- **样式**：TailwindCSS + lucide-react 图标
- **Markdown**：react-markdown（GFM / 代码高亮 / KaTeX 数学公式 / 防 XSS）；笔记实时预览编辑用 CodeMirror 6（文本即真相 + 渲染装饰层）
- **存储**：文件化仓库（`.atlx` 画布 / `.md` 笔记 / 附件任意文件夹存放，无数据库），`notify` 实时监听外部编辑
- **AI 接入**：OpenAI 兼容多供应商，前端直连 SSE 流式；API key 存 OS keychain
- **搜索**：Tavily API + SearXNG 自建实例

## 平台

- Windows 10/11（x64）
- Linux（Wayland 原生，亦兼容 X11）

## 开发环境

前置：Node.js 18+、Rust（stable）、Tauri 2 系统依赖（见官方文档）。

```bash
npm install         # 安装前端依赖
npm run tauri:dev   # 启动开发（自动开 Vite + Tauri 窗口）
npm run tauri:build # 打包
npm run check       # 类型检查 + ESLint
```
