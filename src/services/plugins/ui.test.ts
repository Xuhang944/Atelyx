/**
 * 主线程 UI 平面注册逻辑测试（services/plugins/ui）。
 *
 * 覆盖：facade 挂载、注册收集（panel/setting/command）、按插件撤销、视图候选合并与显示名兜底。
 * 仅测注册逻辑（无 DOM）：用最小 window stub；loadUiPlugin 的脚本注入路径不在本测试覆盖。
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  exposePluginFacade,
  getPluginCommands,
  getPluginPanel,
  getPluginPanels,
  getPluginSetting,
  getPluginSettings,
  pluginViewKinds,
  pluginViewLabel,
  unregisterPluginUi,
} from "./ui";

// node 环境无 window：模块顶层不触 window（仅 exposePluginFacade 在调用时访问），stub 即可。
(globalThis as { window?: unknown }).window = {};

const Comp = () => null;

beforeEach(() => {
  unregisterPluginUi("com.test.any");
  unregisterPluginUi("com.test.hello");
  unregisterPluginUi("com.test.a");
  unregisterPluginUi("com.test.b");
  window.__atelyxPlugin__ = undefined;
});

describe("主线程平面 facade 与注册", () => {
  it("exposePluginFacade 幂等挂载", () => {
    exposePluginFacade();
    expect(window.__atelyxPlugin__).toBeDefined();
    exposePluginFacade();
    expect(window.__atelyxPlugin__).toBeDefined();
  });

  it("registerPanel/registerSetting/registerCommand 收集与读取", () => {
    exposePluginFacade();
    const bridge = window.__atelyxPlugin__!.forPlugin("com.test.hello");
    bridge.registerPanel({ kind: "com.test.hello.dashboard", label: "仪表盘", component: Comp });
    bridge.registerSetting({ key: "config", label: "配置", component: Comp });
    bridge.registerCommand({ id: "run", label: "运行", run: () => 1 });

    expect(getPluginPanel("com.test.hello.dashboard")?.label).toBe("仪表盘");
    expect(getPluginPanels().map((p) => p.kind)).toContain("com.test.hello.dashboard");
    expect(getPluginSettings().map((s) => s.key)).toContain("com.test.hello:config");
    expect(getPluginSetting("com.test.hello:config")?.label).toBe("配置");
    expect(getPluginCommands().map((c) => `${c.pluginId}:${c.id}`)).toContain("com.test.hello:run");
  });

  it("unregisterPluginUi 撤销某插件全部贡献", () => {
    exposePluginFacade();
    const a = window.__atelyxPlugin__!.forPlugin("com.test.a");
    const b = window.__atelyxPlugin__!.forPlugin("com.test.b");
    a.registerPanel({ kind: "com.test.a.p1", label: "A1", component: Comp });
    a.registerPanel({ kind: "com.test.a.p2", label: "A2", component: Comp });
    b.registerPanel({ kind: "com.test.b.p1", label: "B1", component: Comp });
    unregisterPluginUi("com.test.a");
    expect(getPluginPanel("com.test.a.p1")).toBeUndefined();
    expect(getPluginPanel("com.test.a.p2")).toBeUndefined();
    expect(getPluginPanel("com.test.b.p1")?.label).toBe("B1");
  });

  it("视图候选合并与显示名兜底", () => {
    exposePluginFacade();
    expect(pluginViewKinds()).toContain("canvas"); // 内建保留
    window.__atelyxPlugin__!.forPlugin("com.test.hello").registerPanel({
      kind: "com.test.hello.panel",
      label: "我的面板",
      component: Comp,
    });
    expect(pluginViewKinds()).toContain("com.test.hello.panel");
    expect(pluginViewLabel("com.test.hello.panel")).toBe("我的面板");
    expect(pluginViewLabel("canvas")).toBe("画布");
    expect(pluginViewLabel("未知视图")).toBe("未知视图"); // 未知视图原样兜底
  });
});
