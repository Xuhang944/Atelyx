/**
 * 插件运行时（桥宿主）：Worker 生命周期 + 桥消息处理 + 能力门槛 + 审计 + 事件分发。
 *
 * 桥是插件触达 App 能力的唯一通道（worker 内无 window/invoke）。每个插件一个独立 Worker，
 * 故障隔离：单个插件崩溃只影响自身（标记 failed、终止、清注册），不拖垮 App。
 *
 * 能力门槛（与「声明 + 提醒」模型一致）：敏感能力必须已声明（声明了就能用，不额外弹窗），
 * 未声明即拒绝；非敏感能力放行但计入内存审计（详情页可对照声明 vs 实际）。未知方法忽略
 * （前向兼容：新方法由新宿主处理，旧宿主不报错）。
 *
 * 已知边界：worker 自带 fetch（页面 CSP 的 connect-src 对 worker 同样生效），插件可直接联网；
 * 真正的硬门槛是敏感能力（keychain/shell/删除仓库文件）——它们只经桥可达。
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  PluginCapability,
  PluginFiberPhase,
  PluginManifest,
  ToolDefinition,
  ToolResult,
} from "@/types";
import { checkPluginCapability } from "@/utils/pluginManifest";
import { registerPluginTools, unregisterPluginTools } from "@/services/ai/tools";
import {
  createPluginWorker,
  type PluginCommandSpec,
  type PluginToolSpec,
  type WorkerCallMessage,
} from "./worker";

/** 审计上限（内存，防无限增长）。 */
const MAX_AUDIT = 64;

/** 插件运行时条目（桥持有，store 只读快照）。 */
export interface PluginRuntimeEntry {
  id: string;
  manifest: PluginManifest;
  phase: PluginFiberPhase;
  error?: string;
  /** 桥实际调用过的能力（内存审计，上限截断）。 */
  used: string[];
}

interface Runtime {
  entry: PluginRuntimeEntry;
  worker: Worker;
  disposeWorker: () => void;
  disposed: boolean;
  toolDefs: ToolDefinition[];
  commandDefs: PluginCommandSpec[];
  subscriptions: Set<string>;
  invokeSeq: number;
  invokePending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
}

const runtimes = new Map<string, Runtime>();

/** 加载插件：创建独立 Worker 并接入桥；返回运行时条目（失败由事件置 failed）。 */
export function loadPlugin(manifest: PluginManifest, code: string): PluginRuntimeEntry {
  unloadPlugin(manifest.id);
  const { worker, dispose } = createPluginWorker(code);
  const runtime: Runtime = {
    entry: { id: manifest.id, manifest, phase: "loading", used: [] },
    worker,
    disposeWorker: dispose,
    disposed: false,
    toolDefs: [],
    commandDefs: [],
    subscriptions: new Set(),
    invokeSeq: 0,
    invokePending: new Map(),
  };
  worker.onmessage = (e: MessageEvent<unknown>) => handleWorkerMessage(runtime, e.data);
  worker.onerror = (e) => failPlugin(runtime, e.message || "插件执行出错");
  worker.onmessageerror = () => failPlugin(runtime, "插件消息解析失败");
  runtimes.set(manifest.id, runtime);
  notifyChange();
  return runtime.entry;
}

/** 卸载插件：终止 worker + 撤销贡献（工具从注册表移除），失败不影响其他插件。 */
export function unloadPlugin(id: string): void {
  const runtime = runtimes.get(id);
  if (!runtime) return;
  runtime.disposed = true;
  // 在飞 invoke 必须 reject：worker 已终止不会再回包，若不 reject，AI 工具轮会永久挂起。
  rejectPending(runtime, "插件已卸载");
  runtime.disposeWorker();
  if (runtime.toolDefs.length > 0) unregisterPluginTools(runtime.toolDefs);
  runtime.toolDefs = [];
  runtime.commandDefs = [];
  runtimes.delete(id);
  notifyChange();
}

/** 运行时快照（pluginStore 用）。 */
export function runtimeSnapshot(): PluginRuntimeEntry[] {
  return [...runtimes.values()].map((r) => r.entry);
}

/** 插件贡献的全部 AI 工具（Agent 名册组装用）。 */
export function contributedPluginTools(): ToolDefinition[] {
  return [...runtimes.values()].flatMap((r) => r.toolDefs);
}

/** 插件贡献的命令（全局 id = `<pluginId>:<命令 id>`；供命令面板/管理 UI 展示与执行）。 */
export interface PluginCommandContribution {
  globalId: string;
  pluginId: string;
  id: string;
  label: string;
}

export function contributedCommands(): PluginCommandContribution[] {
  const out: PluginCommandContribution[] = [];
  for (const [pluginId, r] of runtimes) {
    for (const def of r.commandDefs) {
      out.push({ globalId: `${pluginId}:${def.id}`, pluginId, id: def.id, label: def.label });
    }
  }
  return out.sort((a, b) => (a.globalId < b.globalId ? -1 : 1));
}

/** 执行插件命令（经桥 RPC 回 worker 的 run 函数）。 */
export async function runContributedCommand(globalId: string): Promise<unknown> {
  const sep = globalId.indexOf(":");
  if (sep <= 0) throw new Error("非法命令 id");
  const pluginId = globalId.slice(0, sep);
  const cmdId = globalId.slice(sep + 1);
  const runtime = runtimes.get(pluginId);
  const def = runtime?.commandDefs.find((d) => d.id === cmdId);
  if (!runtime || !def) throw new Error("命令不存在");
  return invokeFn(runtime, def.runId, []);
}

type RuntimeChangeListener = (entries: PluginRuntimeEntry[]) => void;
const changeListeners = new Set<RuntimeChangeListener>();

/** 订阅运行时变更（加载/激活/失败/卸载）；返回退订函数。 */
export function onRuntimeChange(listener: RuntimeChangeListener): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

function notifyChange(): void {
  if (changeListeners.size === 0) return;
  const snap = runtimeSnapshot();
  for (const listener of changeListeners) listener(snap);
}

/** 事件投递：发给订阅了该事件的全部插件。 */
export function emitPluginEvent(event: string, payload: unknown): void {
  for (const runtime of runtimes.values()) {
    if (runtime.disposed || !runtime.subscriptions.has(event)) continue;
    try {
      runtime.worker.postMessage({ kind: "event", event, payload });
    } catch {
      // worker 已失效：忽略该插件
    }
  }
}

// ===== 消息处理 =====

function handleWorkerMessage(runtime: Runtime, data: unknown): void {
  if (runtime.disposed || typeof data !== "object" || data === null) return;
  const msg = data as { kind?: string };
  if (msg.kind === "call") {
    void handleCall(runtime, data as WorkerCallMessage);
  } else if (msg.kind === "reply") {
    // 主线程发起 invoke（如工具 execute）的回包。
    const m = data as { seq?: number; ok?: boolean; result?: unknown; error?: string };
    const pending = typeof m.seq === "number" ? runtime.invokePending.get(m.seq) : undefined;
    if (!pending) return;
    runtime.invokePending.delete(m.seq as number);
    if (m.ok) pending.resolve(m.result);
    else pending.reject(new Error(m.error || "插件执行失败"));
  }
  // 首个任意消息 = 顶层代码已跑完，标记 active。
  if (runtime.entry.phase === "loading") {
    runtime.entry.phase = "active";
    notifyChange();
  }
}

async function handleCall(runtime: Runtime, msg: WorkerCallMessage): Promise<void> {
  const reply = (result?: unknown): void => {
    if (!runtime.disposed) runtime.worker.postMessage({ kind: "reply", seq: msg.seq, ok: true, result });
  };
  const replyError = (error: string): void => {
    if (!runtime.disposed) runtime.worker.postMessage({ kind: "reply", seq: msg.seq, ok: false, error });
  };
  try {
    reply(await dispatchMethod(runtime, msg.method, msg.args ?? []));
  } catch (e) {
    replyError(e instanceof Error ? e.message : String(e));
  }
}

async function dispatchMethod(runtime: Runtime, method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case "registerTool": {
      requireCapability(runtime, "ai:tool");
      const spec = args[0] as PluginToolSpec;
      if (typeof spec?.name !== "string" || typeof spec.executeId !== "string") {
        throw new Error("registerTool 参数不完整（需要 name/description/parameters/execute）");
      }
      const def = wrapPluginTool(runtime, spec);
      runtime.toolDefs.push(def);
      registerPluginTools([def]);
      // 注册即贡献变化：通知 store（异步/延迟注册也能驱动 Agent 名册等消费方刷新）。
      notifyChange();
      return true;
    }
    case "registerCommand": {
      const spec = args[0] as PluginCommandSpec;
      if (
        typeof spec?.id !== "string" ||
        spec.id.length === 0 ||
        spec.id.includes(":") ||
        typeof spec.label !== "string" ||
        typeof spec.runId !== "string"
      ) {
        throw new Error("registerCommand 参数不完整（需要非空 id/label/run）");
      }
      runtime.commandDefs.push(spec);
      notifyChange();
      return true;
    }
    case "stateRead": {
      requireCapability(runtime, "state:persist");
      return invoke<unknown>("plugin_read_state", { id: runtime.entry.id });
    }
    case "stateWrite": {
      requireCapability(runtime, "state:persist");
      return invoke("plugin_write_state", { id: runtime.entry.id, data: args[0] ?? {} });
    }
    case "ready":
      return true;
    case "subscribe": {
      requireCapability(runtime, "events:subscribe");
      if (typeof args[0] === "string") runtime.subscriptions.add(args[0]);
      return true;
    }
    default:
      // 未知方法：旧宿主忽略新插件的新方法（前向兼容）。
      return null;
  }
}

/** 插件工具包装：execute 经桥 RPC 回 worker 执行；validate 透传（参数已由注册表 JSON.parse，插件在 execute 内自校验）。 */
function wrapPluginTool(runtime: Runtime, spec: PluginToolSpec): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    validate: (args) => args as Record<string, unknown>,
    summarize: (args) => `${spec.name} ${safeSummary(args)}`,
    execute: async (args): Promise<ToolResult> => {
      const raw = await invokeFn(runtime, spec.executeId, [args, { aborted: false }]);
      return raw as ToolResult;
    },
    parallelSafe: spec.parallelSafe,
  };
}

function safeSummary(args: unknown): string {
  try {
    const text = JSON.stringify(args);
    return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  } catch {
    return "参数不可序列化";
  }
}

function invokeFn(runtime: Runtime, fnId: string, args: unknown[]): Promise<unknown> {
  if (runtime.disposed) return Promise.reject(new Error("插件已卸载"));
  const seq = ++runtime.invokeSeq;
  return new Promise((resolve, reject) => {
    runtime.invokePending.set(seq, { resolve, reject });
    try {
      runtime.worker.postMessage({ kind: "invoke", seq, fnId, args });
    } catch (e) {
      runtime.invokePending.delete(seq);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/** 在飞 invoke 统一 reject + 清空（卸载/失败时 worker 已终止、永不会回包）。 */
function rejectPending(runtime: Runtime, reason: string): void {
  for (const pending of runtime.invokePending.values()) {
    pending.reject(new Error(reason));
  }
  runtime.invokePending.clear();
}

/** 能力门槛 + 审计（敏感能力未声明即拒绝，详见文件头）。 */
function requireCapability(runtime: Runtime, cap: PluginCapability): void {
  const gate = checkPluginCapability(runtime.entry.manifest, cap);
  if (!gate.ok) throw new Error(gate.reason);
  if (runtime.entry.used.length < MAX_AUDIT && !runtime.entry.used.includes(cap)) {
    runtime.entry.used.push(cap);
  }
}

function failPlugin(runtime: Runtime, error: string): void {
  if (runtime.disposed) return;
  runtime.disposed = true;
  // 在飞 invoke 必须 reject（同 unloadPlugin：worker 已终止不再回包）。
  rejectPending(runtime, `插件已停止：${error}`);
  runtime.disposeWorker();
  if (runtime.toolDefs.length > 0) unregisterPluginTools(runtime.toolDefs);
  runtime.toolDefs = [];
  runtime.commandDefs = [];
  runtime.entry.phase = "failed";
  runtime.entry.error = error;
  notifyChange();
  // 保留条目（failed 状态供管理 UI 展示）；disposed 已拦截后续事件/消息投递。
}
