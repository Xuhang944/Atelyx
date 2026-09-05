/**
 * 主线程 UI 平面注册逻辑测试（services/plugins/ui）。
 *
 * 覆盖：facade 挂载、注册收集（panel/setting/command/tableview）、按插件撤销、视图候选合并与显示名兜底、
 * 表格数据访问（subscribeTableData/selectTableRow/resolveTableImage 经 provider 转发 + 未接线降级）。
 * 仅测注册逻辑（无 DOM）：用最小 window stub；loadUiPlugin 的脚本注入路径不在本测试覆盖。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  exposePluginFacade,
  getPluginCommands,
  getPluginPanel,
  getPluginPanels,
  getPluginSetting,
  getPluginSettings,
  getPluginTableView,
  getPluginTableViews,
  pluginViewKinds,
  pluginViewLabel,
  setPluginTableAccess,
  unregisterPluginUi,
} from "./ui";
import type { PluginTableSnapshot } from "@/types";

// node 环境无 window：模块顶层不触 window（仅 exposePluginFacade 在调用时访问），stub 即可。
(globalThis as { window?: unknown }).window = {};

const Comp = () => null;
const EMPTY_SNAP: PluginTableSnapshot = { tableFile: null, fields: [], rows: [], selectedRowId: null, peerColorByRowId: {} };

beforeEach(() => {
  unregisterPluginUi("com.test.any");
  unregisterPluginUi("com.test.hello");
  unregisterPluginUi("com.test.a");
  unregisterPluginUi("com.test.b");
  window.__atelyxPlugin__ = undefined;
  setPluginTableAccess(null);
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

  it("registerTableView 收集/读取/按插件撤销", () => {
    exposePluginFacade();
    window.__atelyxPlugin__!.forPlugin("com.test.a").registerTableView({
      kind: "com.test.a.tl",
      label: "时间线",
      component: Comp,
    });
    expect(getPluginTableView("com.test.a.tl")?.label).toBe("时间线");
    expect(getPluginTableViews().map((t) => t.kind)).toContain("com.test.a.tl");
    unregisterPluginUi("com.test.a");
    expect(getPluginTableView("com.test.a.tl")).toBeUndefined();
    expect(getPluginTableViews()).toHaveLength(0);
  });

  it("subscribeTableData 立即推一次 + 变更推 + 退订生效", () => {
    exposePluginFacade();
    const listeners = new Set<(snap: PluginTableSnapshot) => void>();
    setPluginTableAccess({
      subscribeSnapshot: (cb) => {
        listeners.add(cb);
        cb(EMPTY_SNAP); // 接线后立即推一次（宿主语义）
        return () => {
          listeners.delete(cb);
        };
      },
      selectRow: () => {},
      resolveImage: () => Promise.resolve("data:image/png;base64,x"),
    });
    const bridge = window.__atelyxPlugin__!.forPlugin("com.test.a");
    const calls: PluginTableSnapshot[] = [];
    const unsub = bridge.subscribeTableData((snap) => calls.push(snap));
    expect(calls).toHaveLength(1);
    for (const cb of [...listeners]) cb({ ...EMPTY_SNAP, tableFile: "a.atb", selectedRowId: "r1" });
    expect(calls).toHaveLength(2);
    unsub();
    for (const cb of [...listeners]) cb({ ...EMPTY_SNAP, tableFile: "a.atb", selectedRowId: "r2" });
    expect(calls).toHaveLength(2); // 退订后不再推
  });

  it("selectTableRow/resolveTableImage 委托 provider", async () => {
    exposePluginFacade();
    const selectRow = vi.fn();
    const resolveImage = vi.fn((entry: string) => Promise.resolve(`data:${entry}`));
    setPluginTableAccess({
      subscribeSnapshot: () => () => {},
      selectRow,
      resolveImage,
    });
    const bridge = window.__atelyxPlugin__!.forPlugin("com.test.a");
    bridge.selectTableRow("r1");
    bridge.selectTableRow(null);
    expect(selectRow).toHaveBeenNthCalledWith(1, "r1");
    expect(selectRow).toHaveBeenNthCalledWith(2, null);
    await expect(bridge.resolveTableImage("p.png")).resolves.toBe("data:p.png");
    expect(resolveImage).toHaveBeenCalledWith("p.png");
  });

  it("未接线时安全降级（订阅/选中 no-op、resolve 拒绝）", async () => {
    exposePluginFacade();
    const bridge = window.__atelyxPlugin__!.forPlugin("com.test.a");
    expect(() => bridge.subscribeTableData(() => {})()).not.toThrow();
    expect(() => bridge.selectTableRow("r1")).not.toThrow();
    await expect(bridge.resolveTableImage("x")).rejects.toThrow("插件表格访问未就绪");
  });
});
