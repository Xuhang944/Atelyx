# 打包与发布

## 插件仓库结构

```
你的插件仓库/
├── atelyx.json        # 清单（见 manifest.md）
├── plugin.js          # worker 平面入口（main）
├── ui.js              # 主线程 UI 入口（mainUi，可选）
└── README.md          # 建议附使用说明
```

## 打包成 zip

- zip 根含 `atelyx.json`，或把全部文件置于**唯一一个顶层目录**（两种都支持）。
- 大小上限 64 MB；不要打包 `.git`、`node_modules`、嵌套 zip。
- 入口 JS 单文件上限 2 MB。

## 发布到 GitHub Release

1. 在仓库创建 Release（可打版本 tag，如 `v1.0.0`）。
2. 上传插件 zip 作为 Release 资产。
3. GitHub 会为资产生成 sha256 digest —— Atelyx 安装时若有 digest 会自动校验；
   建议上传自己的校验摘要以防万一，但没有也不阻塞（下载经 HTTPS，仓库即信任根）。

## 进入市场

给仓库打 GitHub topic：`atelyx-plugin`。

市场聚合（官方索引 CI）每 6 小时扫描一次该 topic 的仓库，校验清单与 Release 后收录进
市场索引。收录后，所有 Atelyx 用户都可在内置市场搜到你的插件。

> 打上 topic 即自动收录、零申请零审核。发布者对插件质量、安全与合规负全部责任。

## 发布检查清单

- [ ] `atelyx.json` 齐全：schemaVersion / id（反向域名、不可变）/ name / version / type / main
- [ ] `uses` 如实声明（敏感能力如读 key/删文件/执行外部程序务必声明）
- [ ] 功能类型正确（tool/panel/node/…），双平面入口（main/mainUi）指向正确文件
- [ ] `atelyxVersionMin` 与目标宿主版本匹配
- [ ] zip 可被解压出 `atelyx.json`，入口文件在 zip 内
- [ ] Release 已上传 zip，仓库已打 `atelyx-plugin` topic
- [ ] 自测：在 Atelyx 市场安装 → 启用 → 对应位置生效（工具可被模型调用、面板可打开等）

## 徽标

- **官方出品**：`atelyx` 官方账号下的仓库自动带此徽标。
- **官方认可**：优质第三方插件可被官方授予认可徽标（提交到 `atelyx/plugin-index` 的
  `endorsed.json`）。徽标是信任信号，不设上架门槛——任何插件都可以靠 topic 上架。
