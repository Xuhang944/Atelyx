/**
 * 表格类型化单元格（按字段类型分派编辑器）。
 *
 * - text：单击 = 进入隐藏编辑态（视觉不显露：无光标、无边框无背景，编辑即单元格本身），
 *   打字直达输入框——首个字符/IME 组合开始覆盖原值（清空旧内容直接写入）；
 *   双击 = 显示光标 + 取消覆盖（保留原值光标插入）；
 *   选中态键盘：Backspace/Delete = 直接清空（一步撤销，空值无操作）、方向键/Home/End/Enter
 *   = 移动选中、Esc 取消并清选中；编辑态：Enter = 提交并下移一行、Shift+Enter = 换行、
 *   失焦提交、Esc 取消并清选中
 * - number：数字输入（编辑态 Enter 提交并下移，空 = 清空）；选中态键盘语义同 text
 * - singleSelect：选项下拉（含空项）
 * - image：多图单元格——缩略图 + 左右切换（>1 张）+ n/m 角标 + 追加/移除；点击缩略图 → 放大预览
 *
 * 覆盖编辑实现（见 useCellEditor）：选中即聚焦**常驻隐形输入框**——打字/粘贴/IME 组合的
 * 首个字符直接落入真实输入元素，组合开始即绑定该元素、焦点全程不换元素，首字符（含中文
 * 拼音首字母）不丢失。IME 组合必须起始于真实输入元素：组合在无输入元素的文档上开始，
 * 首键会被当纯字母提交、后续才正常。
 *
 * 纯 UI：值读写经 store（updateCell/addImageToCell/removeImageAt）；
 * 单元格选中（selectCell）由 TableEditor 的 td 层 pointer 手势统一处理。
 */
import { ChevronLeft, ChevronRight, ImagePlus, Plus, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent, MouseEvent } from "react";
import { useTableStore } from "@/stores/tableStore";
import { ImageLightbox } from "@/components/table/ImageLightbox";
import { DropdownSelect } from "@/components/common/DropdownSelect";
import type { TableField, TableRow } from "@/types";

/**
 * 撤销回退本单元格的编辑会话后，把草稿同步为撤销后的 store 值（防失焦提交把已撤销内容写回）。
 * 用布尔 selector 订阅：仅当「本次撤销弹掉的是本单元格会话入口」时由 false→true 触发，
 * 其余单元格 selector 恒为 false（原始值比较稳定，zustand 不通知）——避免撤销时全表 effect 风暴。
 */
function useDraftSyncOnUndo(
  rowId: string,
  fieldId: string,
  setDraft: (v: string) => void,
): void {
  const isResetTarget = useTableStore(
    (s) => s.undoResetCell?.rowId === rowId && s.undoResetCell?.fieldId === fieldId,
  );
  useEffect(() => {
    if (!isResetTarget) return;
    const v = useTableStore.getState().rows.find((r) => r.id === rowId)?.values[fieldId];
    setDraft(typeof v === "string" ? v : "");
  }, [isResetTarget, rowId, fieldId, setDraft]);
}

/**
 * 单元格编辑状态机（覆盖编辑核心）：
 * - 选中（隐藏编辑态）：常驻隐形输入框聚焦，value 空，td 仍显示原值；打字/IME 组合/粘贴
 *   的首个字符 → startEdit(首字符) 覆盖原值；双击 → startEdit(原值) 取消覆盖。
 * - 编辑（可见输入框，即单元格本身）：失焦提交、Esc 取消并清选中（组件各自处理）。
 *
 * 关键约束：选中态与编辑态是**同一个输入框元素**切换显隐（焦点与 IME 组合不换元素）；
 * 聚焦只在「未选中 → 选中」时发生（失焦提交后不抢回焦点）。
 */
function useCellEditor<T extends HTMLTextAreaElement | HTMLInputElement>(
  rowId: string,
  fieldId: string,
  editing: boolean,
  setEditing: (v: boolean) => void,
  setDraft: (v: string) => void,
) {
  const ref = useRef<T>(null);
  /** 进入编辑后要放置的光标位（打字覆盖路径为 null：不动光标，防打断进行中的 IME 组合）。 */
  const pendingCaretRef = useRef<number | null>(null);
  const selected = useTableStore(
    (s) =>
      s.selection?.kind === "cell" && s.selection.rowId === rowId && s.selection.fieldId === fieldId,
  );
  // 仅「未选中 → 选中」时聚焦隐形输入框（打字直达；失焦提交后 editing 回落不抢回焦点）
  const wasSelectedRef = useRef(false);
  useLayoutEffect(() => {
    const becameSelected = selected && !wasSelectedRef.current;
    wasSelectedRef.current = selected;
    if (becameSelected && !editing) ref.current?.focus();
  }, [selected, editing]);
  // 进入编辑 → 聚焦 + 按 pendingCaret 放置光标（双击/取消覆盖键指定；打字路径跳过）
  useEffect(() => {
    if (!editing) return;
    ref.current?.focus();
    const caret = pendingCaretRef.current;
    if (caret !== null && ref.current) {
      ref.current.setSelectionRange(caret, caret);
    }
  }, [editing]);

  /** 开始编辑会话（入栈点在会话入口；提交时才确认撤销单元，Esc/无改动不产生空撤销）。 */
  const startEdit = (value: string, caret?: number) => {
    pendingCaretRef.current = caret ?? null;
    useTableStore.getState().beginCellEdit(rowId, fieldId);
    setDraft(value);
    setEditing(true);
  };
  return { ref, selected, startEdit };
}

interface Props {
  field: TableField;
  row: TableRow;
}

export function TableCell({ field, row }: Props) {
  const value = row.values[field.id];
  const updateCell = useTableStore((s) => s.updateCell);

  if (field.type === "image") return <ImageCell field={field} row={row} />;
  if (field.type === "singleSelect") {
    const options = field.options ?? [];
    return (
      <DropdownSelect
        value={typeof value === "string" ? value : ""}
        onChange={(v) => {
          const next = v || undefined;
          // 未变化不提交（防无意义写盘 + 空撤销单元）；单次选择 = 一步撤销
          if (next === value) return;
          useTableStore.getState().pushUndo();
          updateCell(row.id, field.id, next);
        }}
        options={[{ value: "", label: "未选择" }, ...options.map((o) => ({ value: o, label: o }))]}
        className="w-full h-8 px-1.5 text-xs"
        style={{ color: value ? "var(--text-primary)" : "var(--text-muted)" }}
        title={typeof value === "string" && value ? value : "未选择"}
      />
    );
  }
  // number / duration：数字输入
  if (field.type === "number" || field.type === "duration") {
    return <NumberCell field={field} row={row} value={typeof value === "number" ? value : undefined} />;
  }
  // text（含未知类型前向兼容：只读文本展示）
  return <TextCell field={field} row={row} value={typeof value === "string" ? value : ""} />;
}

/**
 * 选中态导航键 → 方向（移动单元格选中用；Enter = 下移一行）。
 * 其余可打印键/IME 组合由输入框默认行为承接（首个 input 事件触发覆盖）。
 * 导出供 TableEditor 焦点兜底导航复用（导航撞上非文本字段单元格时输入框不在场）。
 */
export function navDirection(
  key: string,
): "up" | "down" | "left" | "right" | "home" | "end" | null {
  switch (key) {
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    case "Home":
      return "home";
    case "End":
      return "end";
    case "Enter":
      return "down";
    default:
      return null;
  }
}

/** 选中态导航：按方向移动单元格选中（高亮 + 隐藏输入框随 selection 切换聚焦）；边界停住。
 *  导出供 TableEditor 焦点兜底导航复用。 */
export function navigateCell(
  rowId: string,
  fieldId: string,
  dir: "up" | "down" | "left" | "right" | "home" | "end",
): void {
  const st = useTableStore.getState();
  const rowIdx = st.rows.findIndex((r) => r.id === rowId);
  const colIdx = st.fields.findIndex((f) => f.id === fieldId);
  if (rowIdx < 0 || colIdx < 0) return;
  let nextRow = rowIdx;
  let nextCol = colIdx;
  if (dir === "up") nextRow = Math.max(0, rowIdx - 1);
  else if (dir === "down") nextRow = Math.min(st.rows.length - 1, rowIdx + 1);
  else if (dir === "left") nextCol = Math.max(0, colIdx - 1);
  else if (dir === "right") nextCol = Math.min(st.fields.length - 1, colIdx + 1);
  else if (dir === "home") nextCol = 0;
  else nextCol = st.fields.length - 1;
  if (nextRow === rowIdx && nextCol === colIdx) return;
  st.selectCell(st.rows[nextRow].id, st.fields[nextCol].id);
}

/** 清空单元格值（一步撤销；空值无操作）。选中态 Backspace/Delete 与表格层焦点兜底共用。 */
export function clearCell(rowId: string, fieldId: string): void {
  const st = useTableStore.getState();
  const v = st.rows.find((r) => r.id === rowId)?.values[fieldId];
  if (typeof v === "string" ? v === "" : v === undefined) return;
  st.beginCellEdit(rowId, fieldId);
  st.updateCell(rowId, fieldId, undefined);
  st.commitCellEdit();
}

/**
 * 选中态键盘统一处理（Text/Number 共用）：Esc 清选中、Tab 不动、Backspace/Delete 清空、
 * Shift+Enter 无操作、导航键移动选中。返回 true = 已处理。
 */
function handleSelectionKey(
  e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>,
  rowId: string,
  fieldId: string,
): boolean {
  if (e.key === "Escape") {
    e.preventDefault();
    useTableStore.getState().selectRow(null); // 取消并清选中
    return true;
  }
  if (e.key === "Tab") {
    e.preventDefault(); // 选中态不离开输入框焦点
    return true;
  }
  if (e.key === "Backspace" || e.key === "Delete") {
    e.preventDefault();
    clearCell(rowId, fieldId);
    return true;
  }
  if (e.key === "Enter" && e.shiftKey) {
    e.preventDefault(); // 选中态 Shift+Enter 无操作
    return true;
  }
  const dir = navDirection(e.key);
  if (dir) {
    e.preventDefault();
    navigateCell(rowId, fieldId, dir); // 移动选中（高亮 + 隐藏输入框跟随）
    return true;
  }
  return false;
}

/** 文本单元格：单击进入隐藏编辑态（常驻隐形输入框），首字符覆盖；双击取消覆盖（保留原值）。 */
function TextCell({
  field,
  row,
  value,
}: {
  field: TableField;
  row: TableRow;
  value: string;
}) {
  const updateCell = useTableStore((s) => s.updateCell);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const { ref, selected, startEdit } = useCellEditor<HTMLTextAreaElement>(
    row.id,
    field.id,
    editing,
    setEditing,
    setDraft,
  );
  useDraftSyncOnUndo(row.id, field.id, setDraft);

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    if (!editing) {
      // 选中态首个输入（打字/IME 组合/粘贴）→ 覆盖原值；组合文本走同一路径（不置光标，防打断组合）
      if (e.target.value === "") return;
      startEdit(e.target.value);
      return;
    }
    setDraft(e.target.value);
  };
  const commit = () => {
    setEditing(false);
    // diff 后才写：失焦未改动不置脏（避免无谓写盘，同 TextNode 惯例）；
    // 保留原文首尾空白（文本即真相，不 trim）；有改动提交会话（撤销单元保留），无改动丢弃
    if (draft !== value) {
      useTableStore.getState().commitCellEdit();
      updateCell(row.id, field.id, draft || undefined);
    } else {
      useTableStore.getState().abortCellEdit();
    }
  };
  const handleBlur = () => {
    // 选中态失焦（点了别处/别的单元格）：无编辑会话，直接忽略
    if (!editing) return;
    commit();
  };
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (editing) {
      if (e.key === "Escape") {
        // 取消并清选中
        useTableStore.getState().abortCellEdit();
        setDraft(value);
        setEditing(false);
        useTableStore.getState().selectRow(null);
        return;
      }
      // Enter（非 Shift、非 IME 组合确认）= 提交并下移一行；Shift+Enter = 换行（默认行为）；
      // 组合确认 Enter 走默认（nativeEvent.isComposing：React 合成事件不透传该字段）
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        commit();
        navigateCell(row.id, field.id, "down");
      }
      return; // 编辑态其余键交给输入框默认行为
    }
    // —— 选中（隐藏编辑）态 ——
    if (handleSelectionKey(e, row.id, field.id)) return;
  };
  const handleDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    // 编辑态双击（选词替换等手势）落在输入框内并冒泡到此处：不得重置草稿回原值
    if (editing) return;
    e.preventDefault(); // 阻止双击默认选词选区闪现
    // 取消覆盖：保留原值，光标末尾（text 换行 = 编辑态 Shift+Enter）
    startEdit(value, value.length);
  };

  return (
    <div
      // 编辑态/隐藏编辑态共用同一输入框元素（绝对铺满 td）：编辑态显示即单元格本身，
      // 隐藏态 opacity-0 + pointer-events-none（点击穿透到 td 手势层），td 显示原值
      className="w-full h-full min-h-8 px-1.5 py-1 text-xs whitespace-pre-wrap break-words"
      style={{
        color: "var(--text-primary)",
        ...(editing
          ? {}
          : {
              // 隐藏编辑态按显示态限高截断（编辑态溢出显示，随内容撑开）
              maxHeight: row.height ?? undefined,
              overflow: "hidden",
              cursor: "default",
            }),
      }}
      onDoubleClick={handleDoubleClick}
    >
      {editing ? (
        // 占位（不可见）：与显示态同结构撑起 td 高度（编辑框 absolute 不参与布局）。
        // 未固定行高 = 内容高（随 draft 增长）；固定行高 = td 高由行高决定。
        <div className="invisible">{draft}</div>
      ) : (
        <div>{value}</div>
      )}
      {(selected || editing) && (
        <textarea
          ref={ref}
          data-cell-editor
          value={editing ? draft : ""}
          onChange={handleChange}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          tabIndex={-1}
          className={
            editing
              ? "absolute inset-0 w-full h-full resize-none overflow-auto border-none bg-transparent outline-none text-xs px-1.5 py-1 cursor-text"
              : "absolute inset-0 w-full h-full resize-none border-none bg-transparent outline-none text-xs px-1.5 py-1 opacity-0 pointer-events-none cursor-default"
          }
          style={{ color: "var(--text-primary)" }}
        />
      )}
    </div>
  );
}

/** 数字/时长单元格：数字输入（失焦/Enter 提交，空 = 清空）；覆盖/取消覆盖语义同 text。 */
function NumberCell({
  field,
  row,
  value,
}: {
  field: TableField;
  row: TableRow;
  value: number | undefined;
}) {
  const updateCell = useTableStore((s) => s.updateCell);
  const valueStr = value !== undefined ? String(value) : "";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(valueStr);
  const { ref, selected, startEdit } = useCellEditor<HTMLInputElement>(
    row.id,
    field.id,
    editing,
    setEditing,
    setDraft,
  );
  useDraftSyncOnUndo(row.id, field.id, setDraft);

  const commit = () => {
    // 选中态失焦（点了别处/别的单元格）：无编辑会话，直接忽略
    if (!editing) return;
    setEditing(false);
    const v = draft.trim();
    if (v === "") {
      // 空 = 清空；已是空则不提交（无意义写盘 + 误清 redo），中止会话丢弃空撤销单元
      if (value !== undefined) {
        useTableStore.getState().commitCellEdit();
        updateCell(row.id, field.id, undefined);
      } else {
        useTableStore.getState().abortCellEdit();
      }
    } else {
      const n = Number(v);
      if (!Number.isNaN(n)) {
        if (n !== value) {
          useTableStore.getState().commitCellEdit();
          updateCell(row.id, field.id, n);
        } else {
          useTableStore.getState().abortCellEdit();
        }
      } else {
        // 非法输入：恢复原值，视为放弃编辑
        useTableStore.getState().abortCellEdit();
        setDraft(valueStr);
      }
    }
  };
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (!editing) {
      // 选中态首个输入 → 覆盖原值
      if (e.target.value === "") return;
      startEdit(e.target.value);
      return;
    }
    setDraft(e.target.value);
  };
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (editing) {
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        commit();
        navigateCell(row.id, field.id, "down"); // 提交并下移一行
        return;
      }
      if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault(); // number 无换行，无操作
        return;
      }
      if (e.key === "Escape") {
        // 取消并清选中
        useTableStore.getState().abortCellEdit();
        setDraft(valueStr);
        setEditing(false);
        useTableStore.getState().selectRow(null);
      }
      return;
    }
    // —— 选中（隐藏编辑）态 ——
    if (handleSelectionKey(e, row.id, field.id)) return;
  };
  const handleDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    // 编辑态双击（选词替换等手势）落在输入框内并冒泡到此处：不得重置草稿回原值
    if (editing) return;
    e.preventDefault(); // 阻止双击默认选词选区闪现
    // 取消覆盖：保留原值进入编辑（Enter 提交并下移由编辑态承接）
    startEdit(valueStr);
  };

  return (
    <div className="w-full h-full min-h-8" onDoubleClick={handleDoubleClick}>
      {!editing && (
        <div
          className="flex items-center w-full min-h-8 px-1.5 text-xs cursor-default"
          style={{ color: "var(--text-primary)" }}
        >
          <span className="truncate">
            {value !== undefined ? (field.type === "duration" ? `${value} 秒` : String(value)) : ""}
          </span>
        </div>
      )}
      {(selected || editing) && (
        <input
          ref={ref}
          data-cell-editor
          type="number"
          step={field.type === "duration" ? 0.1 : 1}
          value={editing ? draft : ""}
          onChange={handleChange}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          tabIndex={-1}
          className={
            editing
              ? "absolute inset-0 w-full h-full bg-transparent outline-none border-none text-xs px-1.5 cursor-text"
              : "absolute inset-0 w-full h-full bg-transparent outline-none border-none text-xs px-1.5 opacity-0 pointer-events-none cursor-default"
          }
          style={{ color: "var(--text-primary)" }}
        />
      )}
      {editing && field.type === "duration" && (
        <span
          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] pointer-events-none"
          style={{ color: "var(--text-muted)" }}
        >
          秒
        </span>
      )}
    </div>
  );
}

/** 图片单元格：多图缩略图 + 左右切换 + 角标 + 追加/移除 + 点击放大预览。 */
function ImageCell({ field, row }: { field: TableField; row: TableRow }) {
  const value = row.values[field.id];
  const images = Array.isArray(value) ? value : [];
  const addImageToCell = useTableStore((s) => s.addImageToCell);
  const removeImageAt = useTableStore((s) => s.removeImageAt);
  const [idx, setIdx] = useState(0);
  const [lightbox, setLightbox] = useState(false);
  // 图片数变化（增删）时钳制当前下标
  const cur = images.length === 0 ? 0 : Math.min(idx, images.length - 1);

  if (images.length === 0) {
    return (
      // 占位（流内 min-h-8）撑起 td 最小高度；按钮 absolute 铺满 td（td relative）垂直居中，
      // 行高更高时按钮随单元格整体居中
      <div className="group min-h-8 p-1">
        <button
          onClick={() => void addImageToCell(row.id, field.id)}
          className="absolute inset-0 w-full h-full flex items-center justify-center rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-[var(--hover)]"
          style={{ color: "var(--text-muted)" }}
          title="添加图片"
        >
          <ImagePlus size={14} />
        </button>
      </div>
    );
  }

  return (
    // overflow-hidden + maxHeight：行高固定时缩略图超行高部分被裁剪（与文本单元格截断一致）
    <div className="relative p-1 group overflow-hidden" style={{ maxHeight: row.height ?? undefined }}>
      <img
        src={images[cur]}
        alt={`${field.name} ${cur + 1}`}
        className="h-16 rounded object-cover cursor-zoom-in block"
        onClick={() => setLightbox(true)}
        draggable={false}
      />
      {/* 多图：左右切换 + 角标 */}
      {images.length > 1 && (
        <>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setIdx((i) => (i - 1 + images.length) % images.length);
            }}
            className="absolute left-1 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ background: "rgba(0,0,0,0.6)", color: "#fff" }}
            title="上一张"
          >
            <ChevronLeft size={12} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setIdx((i) => (i + 1) % images.length);
            }}
            className="absolute right-1 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ background: "rgba(0,0,0,0.6)", color: "#fff" }}
            title="下一张"
          >
            <ChevronRight size={12} />
          </button>
          <span
            className="absolute bottom-1 right-1 px-1 rounded text-[9px] leading-3"
            style={{ background: "rgba(0,0,0,0.6)", color: "#fff" }}
          >
            {cur + 1}/{images.length}
          </span>
        </>
      )}
      {/* 追加 / 移除当前图（hover 显示） */}
      <div className="absolute top-1 right-1 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={(e) => {
            e.stopPropagation();
            void addImageToCell(row.id, field.id);
          }}
          className="w-5 h-5 flex items-center justify-center rounded-full"
          style={{ background: "rgba(0,0,0,0.6)", color: "#fff" }}
          title="追加图片"
        >
          <Plus size={11} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            removeImageAt(row.id, field.id, cur);
            setIdx((i) => Math.max(0, i - 1));
          }}
          className="w-5 h-5 flex items-center justify-center rounded-full"
          style={{ background: "rgba(0,0,0,0.6)", color: "#f87171" }}
          title="移除当前图片"
        >
          <X size={11} />
        </button>
      </div>
      {lightbox && (
        <ImageLightbox
          images={images}
          index={cur}
          onIndexChange={(i) => setIdx(i)}
          onClose={() => setLightbox(false)}
        />
      )}
    </div>
  );
}
