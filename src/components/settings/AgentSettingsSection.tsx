/**
 * 设置 → Agent 面板：Agent 配置列表 + 编辑器。
 *
 * Agent = 可复用的对话预设（名称 + 系统提示词 + 工具），对话节点 / AI 对话面板
 * 按 id 引用、发送时实时解析（改 Agent 即改行为，无需改引用处）。
 * 系统提示词 = 引用已注册提示词笔记（右键笔记「注册为提示词」，发送时实时读正文、
 * 外部编辑即时生效）；可配置工具勾选决定 Agent 可自主调用的能力，
 * 只读基础工具恒可用、不占用开关。
 *
 * 预置 Agent（builtin 标记）默认随仓库出现、
 * 可编辑但不可删除（列表不显示删除按钮，store 侧另有兜底）；副本为普通 Agent 可删除。
 *
 * 表单为本地草稿 + 显式「保存」提交（避免每键一次 agents.json 原子写）；
 * 切换选中 Agent 未保存改动丢弃。删除走 ConfirmDialog（同设置页惯例）。
 */
import { Copy, Plus, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useSettingsStore } from "@/stores/settingsStore";
import { DropdownSelect } from "@/components/common/DropdownSelect";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { AGENT_TOOLS_META } from "@/constants/tools";
import { noteTitleFromFile } from "@/utils/filename";
import type { AgentConfig } from "@/types";

export function AgentSettingsSection() {
  const agents = useSettingsStore((s) => s.agents);
  const addAgent = useSettingsStore((s) => s.addAgent);
  const updateAgent = useSettingsStore((s) => s.updateAgent);
  const removeAgent = useSettingsStore((s) => s.removeAgent);
  const duplicateAgent = useSettingsStore((s) => s.duplicateAgent);
  const promptNotes = useSettingsStore((s) => s.promptNotes);
  // 搜索源就绪状态（订阅字段而非 isSearchConfigured 函数引用，配置变化即时刷新提示）
  const searchConfig = useSettingsStore((s) => s.searchConfig);
  const tavilyKey = useSettingsStore((s) => s.tavilyKey);
  const searchReady =
    searchConfig.provider === "tavily"
      ? !!tavilyKey
      : !!searchConfig.searxngUrl;
  // 当前选中 Agent id（null = 未选；列表为空时自动清空）
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AgentConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const selected = agents.find((a) => a.id === selectedId) ?? null;

  // 选中变化/外部删除 → 载入草稿（未保存改动丢弃）
  useEffect(() => {
    if (selected) {
      setDraft({ ...selected });
      setDirty(false);
    } else if (selectedId !== null) {
      // 选中项已被删除/不存在：清空选择
      setSelectedId(null);
      setDraft(null);
      setDirty(false);
    }
  }, [selected?.id, selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const patchDraft = (patch: Partial<AgentConfig>) => {
    if (!draft) return;
    setDraft({ ...draft, ...patch });
    setDirty(true);
  };

  const handleSave = () => {
    if (!draft || !dirty) return;
    const trimmedName = draft.name.trim();
    if (!trimmedName) return;
    void updateAgent(draft.id, {
      name: trimmedName,
      systemPromptFile: draft.systemPromptFile,
      tools: draft.tools,
    });
    setDirty(false);
  };

  const handleAdd = async () => {
    const id = await addAgent();
    setSelectedId(id);
  };

  const summary = (a: AgentConfig): string =>
    a.systemPromptFile
      ? `已注册提示词：${noteTitleFromFile(a.systemPromptFile)}`
      : "无提示词";

  return (
    <section className="flex-1 min-h-0 p-5 flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div
            className="text-sm font-medium flex items-center gap-1.5"
            style={{ color: "var(--text-primary)" }}
          >
            <Sparkles size={14} style={{ color: "var(--accent)" }} />
            Agent
          </div>
        </div>
        <button
          onClick={() => void handleAdd()}
          className="flex items-center gap-1 text-xs rounded px-2.5 py-1.5 flex-shrink-0 hover:opacity-80"
          style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
        >
          <Plus size={12} />
          新建 Agent
        </button>
      </div>

      {/* 列表恒非空：预置 Agent 在进仓库时种子补齐（settingsStore.loadVaultConfig），无需空态 */}
      <div className="flex-1 min-h-0 flex gap-3">
        {/* 左侧：Agent 列表（预置 Agent 不显示删除按钮） */}
        <div
          className="w-52 shrink-0 rounded-lg border overflow-auto"
          style={{
            borderColor: "var(--border)",
            background: "var(--bg-primary)",
          }}
        >
          {agents.map((a) => (
            <div
              key={a.id}
              className={`group flex items-center gap-1 px-2.5 py-2 cursor-pointer border-b last:border-b-0 ${
                selectedId === a.id ? "" : "hover:bg-[var(--hover)]"
              }`}
              style={{
                background:
                  selectedId === a.id ? "var(--bg-tertiary)" : undefined,
                borderColor: "var(--border)",
              }}
              onClick={() => setSelectedId(a.id)}
            >
              <div className="flex-1 min-w-0">
                <div
                  className="text-xs font-medium truncate flex items-center gap-1"
                  style={{ color: "var(--text-primary)" }}
                  title={a.name}
                >
                  {a.name}
                  {a.builtin && (
                    <span
                      className="text-[9px] px-1 rounded flex-shrink-0"
                      style={{
                        color: "var(--text-muted)",
                        background: "var(--bg-tertiary)",
                        border: "1px solid var(--border)",
                      }}
                    >
                      预置
                    </span>
                  )}
                </div>
                <div
                  className="text-[11px] truncate mt-0.5"
                  style={{ color: "var(--text-muted)" }}
                  title={summary(a)}
                >
                  {summary(a)}
                </div>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void duplicateAgent(a.id);
                }}
                title="复制 Agent"
                className="p-1 rounded hover:opacity-70 flex-shrink-0 opacity-0 group-hover:opacity-100"
                style={{ color: "var(--text-muted)" }}
              >
                <Copy size={12} />
              </button>
              {!a.builtin && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedId(a.id);
                    setConfirmDelete(true);
                  }}
                  title="删除 Agent"
                  className="p-1 rounded hover:opacity-70 flex-shrink-0 opacity-0 group-hover:opacity-100"
                  style={{ color: "#f87171" }}
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          ))}
        </div>

        {/* 右侧：编辑器（本地草稿 + 显式保存） */}
        {draft && (
          <div
            className="flex-1 min-w-0 rounded-lg border p-4 overflow-auto"
            style={{
              borderColor: "var(--border)",
              background: "var(--bg-primary)",
            }}
          >
            {/* 名称 */}
            <div className="mb-4">
              <div
                className="text-xs mb-1.5"
                style={{ color: "var(--text-secondary)" }}
              >
                名称
              </div>
              <input
                value={draft.name}
                onChange={(e) => patchDraft({ name: e.target.value })}
                placeholder="如：写作助手"
                className="w-full max-w-[280px] text-sm rounded px-2 py-1 outline-none"
                style={{
                  color: "var(--text-primary)",
                  background: "var(--input-bg)",
                  border: "1px solid var(--input-border)",
                }}
              />
            </div>

            {/* 系统提示词：一级下拉直接选择已注册提示词笔记（发送时实时读正文注入，外部编辑即时生效） */}
            <div className="mb-4">
              <div
                className="text-xs mb-1.5"
                style={{ color: "var(--text-secondary)" }}
              >
                系统提示词
              </div>
              <DropdownSelect
                value={draft?.systemPromptFile ?? ""}
                onChange={(v) =>
                  patchDraft({ systemPromptFile: v || undefined })
                }
                options={[
                  { value: "", label: "不使用" },
                  ...promptNotes.map((f) => ({
                    value: f,
                    label: noteTitleFromFile(f),
                  })),
                ]}
                emptyText="暂无已注册提示词（在文件面板右键笔记 → 注册为提示词）"
                placeholder="选择提示词笔记"
                className="w-full text-sm rounded px-2 py-1"
                style={{
                  color: "var(--text-secondary)",
                  background: "var(--input-bg)",
                  border: "1px solid var(--input-border)",
                }}
              />
              <p
                className="text-[11px] mt-1"
                style={{ color: "var(--text-muted)" }}
              >
                实时读正文注入；文件面板右键 .md 可注册为提示词
              </p>
            </div>

            {/* 工具：可配置能力勾选（只读基础工具恒可用，不显示开关） */}
            <div className="mb-4">
              <div
                className="text-xs mb-1.5"
                style={{ color: "var(--text-secondary)" }}
              >
                工具
              </div>
              <div className="flex flex-col gap-1">
                {AGENT_TOOLS_META.filter((t) => !t.readOnly).map((t) => {
                  const on = (draft?.tools ?? []).includes(t.id);
                  return (
                    // 行用 label 承载点击（整行命中切换单一 onChange；原生 checkbox 内嵌 button 会双触发）
                    <label
                      key={t.id}
                      className="flex items-center gap-2 px-1 py-0.5 text-xs rounded hover:bg-[var(--hover)]"
                      style={{
                        color: on
                          ? "var(--text-primary)"
                          : "var(--text-secondary)",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => {
                          const cur = draft?.tools ?? [];
                          patchDraft({
                            tools: on
                              ? cur.filter((x) => x !== t.id)
                              : [...cur, t.id],
                          });
                        }}
                        className="w-3.5 h-3.5 flex-shrink-0 accent-[var(--accent)]"
                      />
                      <span className="flex items-center gap-1.5">
                        {t.label}
                        {t.needsSearch && !searchReady && (
                          <span
                            className="text-[10px]"
                            style={{ color: "var(--text-muted)" }}
                          >
                            （未配置搜索源，发送时自动降级）
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* 保存 */}
            <div className="flex items-center gap-2">
              <button
                onClick={handleSave}
                disabled={!dirty || !draft.name.trim()}
                className="px-3 py-1.5 text-xs rounded disabled:opacity-40"
                style={{
                  background: "var(--accent)",
                  color: "var(--accent-fg)",
                }}
              >
                保存
              </button>
              {dirty && (
                <span
                  className="text-[11px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  有未保存的修改
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title="删除 Agent"
          confirmText="删除"
          onConfirm={() => {
            if (selectedId) void removeAgent(selectedId);
            setSelectedId(null);
            setConfirmDelete(false);
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </section>
  );
}
