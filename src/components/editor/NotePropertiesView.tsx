/**
 * 笔记属性区：内嵌于编辑器内容区顶部，可视化展示 + 内联编辑
 * `.md` 开头 YAML Frontmatter（渲染/实时预览编辑模式显示；源码模式由 textarea 显示 YAML 原文）。
 *
 * 纯受控展示组件，无持久化逻辑：data 由 NoteEditor 解析传入，onUpdate 提交新 data（NoteEditor 拼回完整
 * content 走既有 debounce 保存链路）。类型化渲染：
 * - tags/aliases/cssclasses → `#` 徽章；其余数组 → Clock 垂直列表；
 * - string → 键值对行；未知类型（数字/布尔/嵌套）→ 只读键值对行 String(value)（编辑会破坏 YAML 类型，不做）。
 * 内联编辑：点击值 → input（自动聚焦全选），Enter/失焦提交、Esc 取消；条目 hover 显示 X 删除；
 * 数组行尾 `+` 新增项；底部「+ 添加属性」内联表单（Value 含逗号自动转数组）。
 */
import { ChevronDown, ChevronRight, Clock, Plus, X } from "lucide-react";
import { useRef, useState } from "react";
import { isBadgeKey } from "@/utils/frontmatter";

interface Props {
  /** 解析后的 frontmatter（宽类型：未知类型值只读展示，防序列化破坏类型）。 */
  data: Record<string, unknown>;
  /** YAML 格式错误：显示红条并禁用编辑，防 stringify 丢弃格式错误的旧数据。 */
  parseError: boolean;
  /** 提交新 data（NoteEditor 负责拼回完整 content）。 */
  onUpdate: (next: Record<string, unknown>) => void;
  /** 切到源码模式（格式错误时用户可查看/修复原始 YAML）。 */
  onOpenSource: () => void;
}

/** 正在编辑的位置：index 存在 = 数组第 index 项，否则 = 单值字段。 */
interface Editing {
  key: string;
  index?: number;
  initial: string;
}

/**
 * 内联编辑输入框：Enter/失焦提交，Esc 取消；doneRef 防 Enter 提交后 blur 重复提交。
 * 自动聚焦并全选当前文本（编辑态需自动聚焦并选中）。
 */
function ValueInput({
  initial,
  autoWidth,
  onCommit,
  onCancel,
}: {
  initial: string;
  /** true = 按内容自适应宽度（徽章/列表项）；false = flex-1 撑满（单值行）。 */
  autoWidth?: boolean;
  onCommit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const doneRef = useRef(false);
  const done = (fn: () => void) => {
    if (doneRef.current) return;
    doneRef.current = true;
    fn();
  };
  return (
    <input
      autoFocus
      spellCheck={false}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => done(() => onCommit(text))}
      onKeyDown={(e) => {
        if (e.key === "Enter") done(() => onCommit(text));
        else if (e.key === "Escape") done(onCancel);
      }}
      className={autoWidth ? "" : "flex-1 min-w-0"}
      style={autoWidth ? { width: `calc(${Math.max(text.length, 2)}ch + 2rem)` } : undefined}
    />
  );
}

export function NotePropertiesView({ data, parseError, onUpdate, onOpenSource }: Props) {
  const [editing, setEditing] = useState<Editing | null>(null);
  /** 折叠状态（默认展开；点击标题栏切换，仅内存态不持久化）。 */
  const [collapsed, setCollapsed] = useState(false);
  /** 正在编辑属性名的 key（null = 未编辑；与值编辑互斥）。 */
  const [editingKey, setEditingKey] = useState<string | null>(null);
  /** 数组行尾「+ 新增项」的 key（非空时显示输入框）。 */
  const [addingItem, setAddingItem] = useState<string | null>(null);
  const [addingField, setAddingField] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");

  const entries = Object.entries(data);

  const startEdit = (key: string, index: number | undefined, initial: string) => {
    setAddingItem(null);
    setEditingKey(null);
    setEditing({ key, index, initial });
  };

  /** 数组项/单值提交：空值删除（数组删该项、单值删整行）。 */
  const commitEdit = (key: string, index: number | undefined, text: string) => {
    const raw = data[key];
    if (Array.isArray(raw) && index !== undefined) {
      const next = raw.slice();
      if (text.trim() === "") next.splice(index, 1);
      else next[index] = text.trim();
      onUpdate({ ...data, [key]: next });
    } else if (text.trim() === "") {
      const next = { ...data };
      delete next[key];
      onUpdate(next);
    } else {
      onUpdate({ ...data, [key]: text });
    }
    setEditing(null);
  };

  const removeArrayItem = (key: string, index: number) => {
    const raw = data[key];
    if (!Array.isArray(raw)) return;
    const next = raw.slice();
    next.splice(index, 1);
    onUpdate({ ...data, [key]: next });
  };

  const addArrayItem = (key: string, text: string) => {
    const base = Array.isArray(data[key]) ? data[key].slice() : [];
    onUpdate({ ...data, [key]: [...base, text.trim()] });
    setAddingItem(null);
  };

  const removeField = (key: string) => {
    const next = { ...data };
    delete next[key];
    onUpdate(next);
  };

  /** 添加新属性：Value 含逗号（中英文）自动转数组。 */
  const addField = () => {
    const key = newKey.trim();
    if (!key) return;
    const parts = newValue
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean);
    onUpdate({ ...data, [key]: parts.length > 1 ? parts : newValue.trim() });
    setAddingField(false);
    setNewKey("");
    setNewValue("");
  };

  /** 重命名属性：空提交 = 删除该属性（与值空提交一致）；同名 = 无操作；不同名 = 值原样迁移 + 删旧 key。 */
  const renameField = (oldKey: string, newKeyRaw: string) => {
    const newKey = newKeyRaw.trim();
    if (!newKey) {
      const next = { ...data };
      delete next[oldKey];
      onUpdate(next);
    } else if (newKey !== oldKey) {
      const next = { ...data };
      next[newKey] = data[oldKey];
      delete next[oldKey];
      onUpdate(next);
    }
    setEditingKey(null);
  };

  /** 属性名列（w-24 灰色小字）：点击进入属性名编辑（ValueInput 自动聚焦全选，Enter/失焦提交重命名）。 */
  const keyCol = (key: string) =>
    editingKey === key ? (
      <ValueInput
        initial={key}
        autoWidth
        onCommit={(t) => renameField(key, t)}
        onCancel={() => setEditingKey(null)}
      />
    ) : (
      <button
        className="w-24 flex-shrink-0 truncate text-xs text-left cursor-pointer hover:opacity-80"
        style={{ color: "var(--text-muted)" }}
        onClick={() => {
          setEditing(null);
          setEditingKey(key);
        }}
        title="点击编辑属性名"
      >
        {key}
      </button>
    );

  /** 徽章（tags/aliases/cssclasses）：`#` 前缀胶囊，点击编辑、hover 删除、行尾 + 新增。 */
  const renderBadges = (key: string, arr: unknown[]) => (
    <div className="flex-1 flex flex-wrap items-center gap-1 min-w-0">
      {arr.map((item, i) =>
        typeof item !== "string" ? (
          <span
            key={i}
            className="px-1.5 py-0.5 rounded-full text-xs"
            style={{ background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}
          >
            #{String(item)}
          </span>
        ) : editing?.key === key && editing.index === i ? (
          <ValueInput
            key={i}
            initial={item}
            autoWidth
            onCommit={(t) => commitEdit(key, i, t)}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <span
            key={i}
            className="group px-1.5 py-0.5 rounded-full text-xs cursor-pointer hover:opacity-90"
            style={{ background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}
            onClick={() => startEdit(key, i, item)}
            title="点击编辑"
          >
            <span className="opacity-60 mr-0.5">#</span>
            {item}
            <button
              className="ml-1 align-middle opacity-0 group-hover:opacity-100 hover:text-red-400"
              onClick={(e) => {
                e.stopPropagation();
                removeArrayItem(key, i);
              }}
              title="删除"
            >
              <X size={10} />
            </button>
          </span>
        )
      )}
      {addingItem === key ? (
        <ValueInput
          initial=""
          autoWidth
          onCommit={(t) => t.trim() !== "" && addArrayItem(key, t)}
          onCancel={() => setAddingItem(null)}
        />
      ) : (
        <button
          className="w-4 h-4 rounded-full flex items-center justify-center hover:opacity-80"
          style={{ color: "var(--text-muted)" }}
          onClick={() => setAddingItem(key)}
          title="添加标签"
        >
          <Plus size={11} />
        </button>
      )}
    </div>
  );

  /** 列表（其余数组，如 timeline）：Clock 图标垂直列表，点击编辑、hover 删除、底部 + 新增。 */
  const renderList = (key: string, arr: unknown[]) => (
    <div className="flex-1 flex flex-col gap-1 min-w-0">
      {arr.map((item, i) =>
        editing?.key === key && editing.index === i ? (
          <ValueInput
            key={i}
            initial={typeof item === "string" ? item : String(item)}
            autoWidth
            onCommit={(t) => commitEdit(key, i, t)}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <div
            key={i}
            className="group flex items-center gap-1.5 text-sm cursor-pointer"
            onClick={() => typeof item === "string" && startEdit(key, i, item)}
          >
            <Clock size={12} style={{ color: "var(--text-muted)" }} className="flex-shrink-0" />
            <span className="truncate">{String(item)}</span>
            {typeof item === "string" && (
              <button
                className="ml-auto opacity-0 group-hover:opacity-100 hover:text-red-400 flex-shrink-0"
                onClick={(e) => {
                  e.stopPropagation();
                  removeArrayItem(key, i);
                }}
                title="删除"
              >
                <X size={12} />
              </button>
            )}
          </div>
        )
      )}
      {addingItem === key ? (
        <ValueInput
          initial=""
          autoWidth
          onCommit={(t) => t.trim() !== "" && addArrayItem(key, t)}
          onCancel={() => setAddingItem(null)}
        />
      ) : (
        <button
          className="flex items-center gap-0.5 text-xs hover:opacity-80"
          style={{ color: "var(--text-muted)" }}
          onClick={() => setAddingItem(key)}
        >
          <Plus size={11} /> 添加
        </button>
      )}
    </div>
  );

  return (
    <div
      className="flex-shrink-0 px-3 py-2 select-none"
      style={{
        background: "var(--bg-secondary)",
        borderLeft: "3px solid var(--accent)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      {/* 标题栏：点击整行折叠/展开（Chevron 指示），默认展开 */}
      <button
        className="w-full flex items-center gap-1 text-xs mb-1.5 rounded hover:opacity-80 cursor-pointer"
        style={{ color: "var(--text-muted)" }}
        onClick={() => setCollapsed((v) => !v)}
        title={collapsed ? "展开笔记属性" : "折叠笔记属性"}
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        <span>笔记属性</span>
      </button>

      {/* 内容区：grid-rows 过渡动画（0fr↔1fr，WebView2 支持；折叠时状态保留） */}
      <div
        className="grid transition-[grid-template-rows] duration-200"
        style={{ gridTemplateRows: collapsed ? "0fr" : "1fr" }}
      >
        <div className="overflow-hidden">

      {parseError ? (
        <div className="text-xs py-1 flex items-center gap-2" style={{ color: "#f87171" }}>
          <span>YAML 格式错误，请检查（属性面板暂不可编辑）</span>
          <button
            className="px-1.5 py-0.5 rounded border hover:opacity-80 flex-shrink-0"
            style={{ borderColor: "#f87171" }}
            onClick={onOpenSource}
            title="切换到源码模式查看并修复 YAML"
          >
            打开源码模式
          </button>
        </div>
      ) : entries.length === 0 ? (
        <div className="text-xs py-1" style={{ color: "var(--text-muted)" }}>
          暂无笔记属性
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 max-h-48 overflow-auto">
          {entries.map(([key, value]) =>
            Array.isArray(value) ? (
              <div key={key} className="flex items-start gap-2">
                {keyCol(key)}
                {isBadgeKey(key) ? renderBadges(key, value) : renderList(key, value)}
              </div>
            ) : (
              <div key={key} className="flex items-center gap-2 group">
                {keyCol(key)}
                {editing?.key === key && editing.index === undefined ? (
                  <ValueInput
                    initial={editing.initial}
                    onCommit={(t) => commitEdit(key, undefined, t)}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <button
                    className="flex-1 min-w-0 text-left truncate"
                    onClick={() => typeof value === "string" && startEdit(key, undefined, value)}
                    title={typeof value === "string" ? "点击编辑" : undefined}
                  >
                    {value === null || value === undefined ? "" : String(value)}
                  </button>
                )}
                <button
                  className="opacity-0 group-hover:opacity-100 hover:text-red-400 flex-shrink-0"
                  onClick={() => removeField(key)}
                  title="删除属性"
                >
                  <X size={12} />
                </button>
              </div>
            )
          )}
        </div>
      )}

      {/* 底部：添加属性（parseError 时禁用，防 stringify 覆盖格式错误的旧数据） */}
      {!parseError &&
        (addingField ? (
          /* 优雅表单：容器底色 + 透明无边框输入 + 金色确认 / 取消按钮 */
          <div
            className="mt-2 flex items-center gap-1.5 rounded-lg px-1.5 py-1"
            style={{ background: "var(--bg-tertiary)" }}
          >
            <input
              autoFocus
              spellCheck={false}
              placeholder="属性名"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addField();
                else if (e.key === "Escape") setAddingField(false);
              }}
              className="w-24 flex-shrink-0 bg-transparent text-xs outline-none"
              style={{ border: "none", background: "transparent" }}
            />
            <span className="flex-shrink-0 text-xs" style={{ color: "var(--text-muted)" }}>
              =
            </span>
            <input
              spellCheck={false}
              placeholder="属性值（逗号分隔为数组）"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addField();
                else if (e.key === "Escape") setAddingField(false);
              }}
              className="flex-1 min-w-0 bg-transparent text-xs outline-none"
              style={{ border: "none", background: "transparent" }}
            />
            {/* 无确认/取消按钮：Enter 确认、Esc 取消（表单聚焦时） */}
          </div>
        ) : (
          <button
            className="mt-2 flex items-center gap-1 text-xs rounded px-1.5 py-0.5"
            style={{ color: "var(--text-muted)" }}
            onClick={() => setAddingField(true)}
          >
            <Plus size={12} /> 添加属性
          </button>
        ))}
        </div>
      </div>
    </div>
  );
}
