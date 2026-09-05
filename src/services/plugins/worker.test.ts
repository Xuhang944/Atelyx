/**
 * 插件桥代理源测试（services/plugins/worker）。
 *
 * 代理源是无依赖的经典 worker 脚本字符串：验证其语法合法、暴露白名单入口，
 * 防止拼接进插件 blob 后整段失效。
 */
import { describe, it, expect } from "vitest";
import { buildProxySource } from "./worker";

describe("buildProxySource", () => {
  it("产出语法合法的脚本", () => {
    const src = buildProxySource();
    // 只解析不执行（node 环境无 worker 全局）。
    expect(() => new Function(src)).not.toThrow();
  });

  it("暴露 registerTool 与白名单方法入口", () => {
    const src = buildProxySource();
    expect(src).toContain("bridge.registerTool");
    expect(src).toContain("bridge.registerCommand");
    // 白名单方法以括号属性形式生成。
    expect(src).toContain('bridge["stateRead"]');
    expect(src).toContain('bridge["stateWrite"]');
    expect(src).toContain('bridge["ready"]');
    expect(src).toContain("bridge.on");
    // UI 类注册不在 worker 平面（主线程平面承载）。
    expect(src).not.toContain("registerPanel");
    expect(src).not.toContain("applyTheme");
  });

  it("协议常量：工具/命令函数以 fnId 序列化", () => {
    const src = buildProxySource();
    expect(src).toContain("executeId");
    expect(src).toContain("parallelSafe");
    expect(src).toContain("runId");
  });
});
