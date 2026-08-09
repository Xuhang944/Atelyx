/**
 * 右侧边栏属性面板。
 *
 * 单击画布节点 → 显示其属性：
 * - 对话节点：系统提示词设置（已标记笔记，与 ConversationNode header 同源）+ 被消费/产出的资产列表
 * - 文本/媒体节点：基本信息 + 来源/消费方列表
 * 资产列表项点击 → setCenter 定位到对应节点（与 @chip 点击定位一致）。
 * 分层：走 canvasStore / vaultStore，不直调 service。
 */
import { BookMarked, FileText, GitBranch, Image, Info, LayoutDashboard, Link2, MessageSquare, Network, Table as TableIcon } from "lucide-react";
import { useReactFlow, type Node as FlowNode } from "@xyflow/react";
import { useShallow } from "zustand/react/shallow";
import { useCanvasStore } from "@/stores/canvasStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useVaultStore } from "@/stores/vaultStore";
import { mentionTextOf, prefix } from "@/utils/text";
import type { ConversationData, MediaData, Message, TableData, TextData } from "@/types";

const NODE_TYPE_LABEL: Record<string, string> = {
  conversation: "对话",
  text: "文本",
  media: "媒体",
  search: "搜索",
  group: "分组",
  link: "链接",
  table: "表格",
};

/** 无入边/出边时的空派生（模块级常量，useShallow 数组比较依赖元素引用稳定）。 */
const EMPTY_NODES: FlowNode[] = [];

/**
 * 对话节点显示名：优先 LLM 自动命名的话题标题（data.title，首轮对话完成后自动命名），
 * 未命名时回退首条 user 消息前缀，无消息时「对话节点」。
 */
function conversationDisplayName(node: FlowNode, msgs: Message[] | undefined): string {
  const data = node.data as Partial<ConversationData>;
  if (data.title) return data.title;
  const firstUser = msgs?.find((m) => m.role === "user")?.content;
  return firstUser ? prefix(firstUser, 16) : "对话节点";
}

/**
 * 无入边时的来源降级文案：笔记节点显示仓库路径，画布内文本/媒体显示「手动创建」，
 * 搜索节点保持「暂无」（其来源必为对话自动建边，孤立仅因源节点被删）。
 */
function sourceFallback(node: FlowNode): string {
  if (node.type === "text") {
    return (node.data as unknown as TextData).file ?? "手动创建";
  }
  if (node.type === "table") {
    return (node.data as unknown as TableData).file ?? "手动创建";
  }
  if (node.type === "media") return "手动创建";
  return "暂无";
}

/** 资产列表行：节点类型图标 + 显示名（对话行标注「分支」血缘）。 */
function AssetRow({ node, onLocate }: { node: FlowNode; onLocate: (id: string) => void }) {
  const icon =
    node.type === "conversation" ? (
      <MessageSquare size={13} className="flex-shrink-0" />
    ) : node.type === "text" ? (
      <FileText size={13} className="flex-shrink-0" />
    ) : node.type === "table" ? (
      <TableIcon size={13} className="flex-shrink-0" />
    ) : node.type === "group" ? (
      <LayoutDashboard size={13} className="flex-shrink-0" />
    ) : node.type === "link" ? (
      <Link2 size={13} className="flex-shrink-0" />
    ) : (
      <Image size={13} className="flex-shrink-0" />
    );
  return (
    <button
      onClick={() => onLocate(node.id)}
      className="w-full text-left px-2 py-1.5 rounded flex items-center gap-2 hover:opacity-80"
      style={{ background: "var(--bg-tertiary)", color: "var(--text-primary)" }}
      title="点击定位到节点"
    >
      {icon}
      <span className="truncate text-xs">{node.type === "conversation" ? "对话" : mentionTextOf(node)}</span>
      {node.type === "conversation" && (
        <span className="ml-auto text-[10px] flex-shrink-0" style={{ color: "var(--text-muted)" }}>
          分支
        </span>
      )}
    </button>
  );
}

/** 分组小标题。 */
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] mb-1 flex items-center gap-1" style={{ color: "var(--text-muted)" }}>
      {children}
    </h3>
  );
}

export function InspectorPanel() {
  // 窄化订阅：节点引用（未变时稳定）+ 入边源/出边目标数组。
  // 注意用 useShallow 返回「数组」（元素是稳定节点引用，浅比较逐元素有效）；
  // 不能返回含新建数组字段的对象——useShallow 按字段 Object.is 比较会判定不等、
  // 缓存永远失效，触发 React「getSnapshot should be cached」+ 无限重渲染。
  const nodeId = useCanvasStore((s) => s.selectedNodeId);
  const node = useCanvasStore((s) => (nodeId ? s.nodes.find((x) => x.id === nodeId) : undefined));
  const sources = useCanvasStore(
    useShallow((s) => {
      const n = nodeId ? s.nodes.find((x) => x.id === nodeId) : undefined;
      if (!n) return EMPTY_NODES;
      // 只含有向数据流边：无向关联边不表达消费/来源（独立「关联」分区展示）
      return s.edges
        .filter((e) => e.target === n.id && e.source !== n.id && e.directed !== false)
        .map((e) => s.nodes.find((x) => x.id === e.source))
        .filter((x): x is FlowNode => !!x);
    })
  );
  const targets = useCanvasStore(
    useShallow((s) => {
      const n = nodeId ? s.nodes.find((x) => x.id === nodeId) : undefined;
      if (!n) return EMPTY_NODES;
      return s.edges
        .filter((e) => e.source === n.id && e.target !== n.id && e.directed !== false)
        .map((e) => s.nodes.find((x) => x.id === e.target))
        .filter((x): x is FlowNode => !!x);
    })
  );
  // 无向关联边端点（去重）：关联是自由线，不记入消费/来源列表
  const associations = useCanvasStore(
    useShallow((s) => {
      const n = nodeId ? s.nodes.find((x) => x.id === nodeId) : undefined;
      if (!n) return EMPTY_NODES;
      const ids = new Set<string>();
      for (const e of s.edges) {
        if (e.directed !== false) continue;
        if (e.source === n.id) ids.add(e.target);
        else if (e.target === n.id) ids.add(e.source);
      }
      return [...ids]
        .map((id) => s.nodes.find((x) => x.id === id))
        .filter((x): x is FlowNode => !!x);
    })
  );
  // 只订阅选中对话的消息数（number，流式期间长度不变不重渲染；全量 messagesByConv 会每帧刷新面板）
  const msgCount = useCanvasStore((s) => (nodeId ? (s.messagesByConv[nodeId]?.length ?? 0) : 0));
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const noteList = useVaultStore((s) => s.noteList);
  // 候选 = 实际存在的笔记 ∩ 已标记列表（文件面板右键注册/注销，独立落盘 .atelyx/prompt-notes.json；hook 须在 early return 前调用）
  const promptFiles = useSettingsStore((s) => s.promptNotes);
  // 分支来源：入边中 type 为 conversation 的父节点（血缘边对话→对话），无则手动创建。
  // 订阅父对话消息：父节点继续对话后来源显示名响应式刷新
  const parentConv = sources.find((n) => n.type === "conversation");
  const parentMsgs = useCanvasStore((s) => (parentConv ? s.messagesByConv[parentConv.id] : undefined));
  const { setCenter } = useReactFlow();

  const locateNode = (id: string) => {
    // 点击定位时读最新位置（不订阅，避免位置变化触发面板重渲染）
    const n = useCanvasStore.getState().nodes.find((x) => x.id === id);
    if (!n) return;
    const w = n.measured?.width ?? n.width ?? 200;
    const h = n.measured?.height ?? n.height ?? 100;
    setCenter(n.position.x + w / 2, n.position.y + h / 2, { zoom: 1, duration: 300 });
  };

  if (!node) {
    return (
      <div
        className="h-full flex items-center justify-center"
        style={{ background: "var(--bg-secondary)", color: "var(--text-muted)" }}
      >
        <div className="flex flex-col items-center gap-2 text-xs px-4 text-center select-none">
          <Info size={22} strokeWidth={1.5} />
          点击画布中的节点查看属性
        </div>
      </div>
    );
  }

  const isConv = node.type === "conversation";

  let title = NODE_TYPE_LABEL[node.type ?? ""] ?? node.type ?? "节点";
  let sub: string | undefined;
  if (isConv) {
    sub = `${msgCount} 条消息`;
  } else if (node.type === "text") {
    const d = node.data as unknown as TextData;
    title = d.title || "未命名文本";
    // 无 file = 画布内文本节点（未落盘），与笔记节点（显示仓库路径）区分
    sub = d.file ?? "画布内文本（未保存为笔记）";
  } else if (node.type === "media") {
    const d = node.data as unknown as MediaData;
    title = d.name || "未命名媒体";
    sub = [d.file, d.kind].filter(Boolean).join(" · ");
  } else if (node.type === "group") {
    const d = node.data as unknown as { label?: string };
    title = d.label || "未命名分组";
    sub = "分组容器（节点放入 = 坐标重叠，颜色可切换）";
  } else if (node.type === "link") {
    const d = node.data as unknown as { url?: string };
    title = d.url || "未命名链接";
    sub = "链接节点（单击在浏览器打开）";
  } else if (node.type === "table") {
    const d = node.data as unknown as TableData;
    title = d.title || "未命名表格";
    sub = d.file ?? "表格";
  }

  const sysPromptFile = isConv
    ? (node.data as unknown as Partial<ConversationData>).systemPromptFile
    : undefined;
  const promptNotes = noteList.filter((n) => promptFiles.includes(n.file));

  return (
    <div
      className="h-full flex flex-col overflow-hidden"
      style={{ background: "var(--bg-secondary)", color: "var(--text-primary)" }}
    >
      <div
        className="px-3 py-2 border-b flex items-center gap-2 flex-shrink-0"
        style={{ borderColor: "var(--border)" }}
        data-tauri-drag-region
      >
        <span className="font-medium text-xs">属性</span>
        <span
          className="ml-auto text-xs px-1.5 py-0.5 rounded flex-shrink-0"
          style={{ background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}
        >
          {NODE_TYPE_LABEL[node.type ?? ""] ?? node.type ?? "节点"}
        </span>
      </div>

      <div className="flex-1 overflow-auto px-3 py-2 flex flex-col gap-3">
        <div>
          <div className="text-sm font-medium truncate">{title}</div>
          {sub && (
            <div className="text-[11px] truncate" style={{ color: "var(--text-muted)" }} title={sub}>
              {sub}
            </div>
          )}
        </div>

        {isConv && (
          <>
          <section>
            <SectionTitle>
              <GitBranch size={12} /> 来源
            </SectionTitle>
            {/* 分支血缘边（对话→对话）的父节点 = 分支来源；无则手动创建 */}
            <div className="text-xs" style={{ color: "var(--text-secondary)" }}>
              {parentConv ? conversationDisplayName(parentConv, parentMsgs) : "手动创建"}
            </div>
          </section>

          <section>
            <SectionTitle>
              <BookMarked size={12} /> 系统提示词
            </SectionTitle>
            {promptNotes.length === 0 ? (
              <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                暂无提示词笔记（在文件面板右键笔记 → 注册为提示词）
              </p>
            ) : (
              <select
                value={sysPromptFile ?? ""}
                onChange={(e) =>
                  updateNodeData(node.id, { systemPromptFile: e.target.value || undefined })
                }
                className="w-full text-xs rounded px-1.5 py-1 outline-none focus:ring-1 focus:ring-[var(--accent)]"
                style={{
                  color: "var(--text-secondary)",
                  background: "var(--input-bg)",
                  border: "1px solid var(--input-border)",
                }}
                title="发送时实时读笔记正文作为首条 system 消息注入"
              >
                <option value="">不使用</option>
                {promptNotes.map((n) => (
                  <option key={n.file} value={n.file}>
                    {n.name.replace(/\.md$/i, "")}
                  </option>
                ))}
              </select>
            )}
          </section>
          </>
        )}

        <section>
          <SectionTitle>{isConv ? "被消费的资产" : "来源"}</SectionTitle>
          {sources.length === 0 ? (
            <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              {sourceFallback(node)}
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {sources.map((src) => (
                <AssetRow key={src.id} node={src} onLocate={locateNode} />
              ))}
            </div>
          )}
        </section>

        <section>
          <SectionTitle>{isConv ? "产出的资产" : "消费方"}</SectionTitle>
          {targets.length === 0 ? (
            <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              暂无
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {targets.map((tgt) => (
                <AssetRow key={tgt.id} node={tgt} onLocate={locateNode} />
              ))}
            </div>
          )}
        </section>

        {/* 无向关联边端点：自由线不表达数据流，独立分区展示（不记入消费/产出） */}
        {associations.length > 0 && (
          <section>
            <SectionTitle>
              <Network size={12} /> 关联
            </SectionTitle>
            <div className="flex flex-col gap-1">
              {associations.map((assoc) => (
                <AssetRow key={assoc.id} node={assoc} onLocate={locateNode} />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
