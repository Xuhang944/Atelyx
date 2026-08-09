/**
 * 多维表格编辑器（表格视图）。
 *
 * 布局：工具条（保存状态 / 冲突条）→ 表格（列头 ⋮ 字段菜单、行 ⋮ 菜单、
 * 行首拖拽手柄插入排序、表头末尾「+」列添加字段、类型化单元格）→ 行尾「+ 新行」→
 * 底部横向滑动条 → 状态栏（空占位）。
 *
 * 交互要点：
 * - 行拖拽为 pointer 模拟（HTML5 DnD 在 WebView2 不可靠，与文件面板同策略）：
 *   行首手柄按下 → 位移超 5px 激活 → 按行元素中点计算插入位（金色插入线指示）→ 松手 moveRow。
 * - 字段菜单：重命名 / 改类型 / 单选选项管理 / 左·右插入字段 / 删除字段（就地确认）。
 * - 保存状态/冲突提示镜像画布窗口（冲突条「重新加载（丢弃本地）/ 保留本地并保存」）。
 */
import { Check, Columns3, FileOutput, GripVertical, MoreHorizontal, Pencil, Plus, Trash2, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useClampedMenuPosition } from "@/hooks/useClampedMenuPosition";
import { useDismissOnOutside } from "@/hooks/useDismissOnOutside";
import { FIELD_TYPE_LABELS } from "@/constants/table";
import { useTableStore } from "@/stores/tableStore";
import { TableCell } from "@/components/table/TableCell";
import { TableTimeline } from "@/components/table/TableTimeline";
import { fieldDefaultWidth } from "@/utils/table";
import { MAX_COL_WIDTH, MIN_COL_WIDTH, ROW_NUM_COL_WIDTH, ADD_FIELD_COL_WIDTH } from "@/constants/table";
import type { FieldType, TableField } from "@/types";

/** 保存状态文本（镜像画布窗口状态区）。 */
const SAVE_TEXT = { saving: "保存中…", saved: "已自动保存" } as const;

export function TableEditor() {
  const fields = useTableStore((s) => s.fields);
  const rows = useTableStore((s) => s.rows);
  const saving = useTableStore((s) => s.saving);
  const conflictPending = useTableStore((s) => s.conflictPending);
  const error = useTableStore((s) => s.error);
  const selectedRowId = useTableStore((s) => s.selectedRowId);
  const selectRow = useTableStore((s) => s.selectRow);
  const resolveConflict = useTableStore((s) => s.resolveConflict);
  const clearError = useTableStore((s) => s.clearError);
  const addRow = useTableStore((s) => s.addRow);
  const view = useTableStore((s) => s.view);
  const setView = useTableStore((s) => s.setView);
  const exportXlsx = useTableStore((s) => s.exportXlsx);
  const [exported, setExported] = useState(false);
  useEffect(() => {
    if (!exported) return;
    const t = setTimeout(() => setExported(false), 1500);
    return () => clearTimeout(t);
  }, [exported]);

  // 字段菜单 / 行菜单 / 添加字段浮层
  const [fieldMenu, setFieldMenu] = useState<{ fieldId: string; x: number; y: number } | null>(null);
  const [rowMenu, setRowMenu] = useState<{ rowId: string; x: number; y: number } | null>(null);
  const [addFieldMenu, setAddFieldMenu] = useState<{ x: number; y: number } | null>(null);

  // ===== 行拖拽插入排序（pointer 模拟）=====
  const dragRef = useRef<{ rowId: string; startX: number; startY: number; active: boolean } | null>(null);
  const [draggingRowId, setDraggingRowId] = useState<string | null>(null);
  const [dragInsertIndex, setDragInsertIndex] = useState<number | null>(null);
  const dragInsertIndexRef = useRef<number | null>(null);
  const rowsElRef = useRef<HTMLDivElement>(null);
  const moveRow = useTableStore((s) => s.moveRow);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.active && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) <= 5) return;
      dragRef.current = { ...d, active: true };
      setDraggingRowId(d.rowId);
      // 插入位 = 首个「中点低于光标」的行下标（纯几何，防元素遮挡干扰）；全高于 → 行尾
      const container = rowsElRef.current;
      let insertAt = 0;
      if (container) {
        const els = container.querySelectorAll<HTMLElement>("[data-row-id]");
        insertAt = els.length;
        for (let i = 0; i < els.length; i++) {
          const r = els[i].getBoundingClientRect();
          if (e.clientY < r.top + r.height / 2) {
            insertAt = i;
            break;
          }
        }
      }
      dragInsertIndexRef.current = insertAt;
      setDragInsertIndex(insertAt);
    };
    const onUp = () => {
      const d = dragRef.current;
      dragRef.current = null;
      const insertAt = dragInsertIndexRef.current;
      if (d?.active && insertAt !== null) moveRow(d.rowId, insertAt);
      dragInsertIndexRef.current = null;
      setDraggingRowId(null);
      setDragInsertIndex(null);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
  }, [moveRow]);

  const startRowDrag = useCallback((e: React.PointerEvent, rowId: string) => {
    if (e.button !== 0) return;
    e.preventDefault(); // 阻止文本选择干扰
    dragRef.current = { rowId, startX: e.clientX, startY: e.clientY, active: false };
  }, []);

  // ===== 列宽拖拽调整（指针模拟，与行拖拽同策略）=====
  const resizeRef = useRef<{ fieldId: string; startX: number; startWidth: number } | null>(null);
  const setFieldWidth = useTableStore((s) => s.setFieldWidth);
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      const width = Math.round(
        Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, r.startWidth + (e.clientX - r.startX))),
      );
      setFieldWidth(r.fieldId, width);
    };
    const onUp = () => {
      resizeRef.current = null;
      document.body.style.cursor = "";
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
    };
  }, [setFieldWidth]);

  const startColResize = useCallback((e: React.PointerEvent, field: TableField) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = {
      fieldId: field.id,
      startX: e.clientX,
      startWidth: field.width ?? fieldDefaultWidth(field.name),
    };
    document.body.style.cursor = "col-resize";
  }, []);

  /** 列宽：手动调整值优先，缺省按字段名自适应。 */
  const widthOf = (f: TableField): number => f.width ?? fieldDefaultWidth(f.name);
  /** 表格总宽 = 行号列 + 各列宽 + 表头末尾「+」列：显式设给 table，拖宽一列只增总宽、
   *  其他列不挤压（border-collapse + table-fixed 无显式宽度时引擎会撑满容器并重分配）。 */
  const totalWidth = ROW_NUM_COL_WIDTH + fields.reduce((acc, f) => acc + widthOf(f), 0) + ADD_FIELD_COL_WIDTH;

  // ===== 底部横向滑动条：与表格横向滚动双向同步（常显；宽度 = 表格总宽 + 边框余量）=====
  const bottomScrollRef = useRef<HTMLDivElement>(null);
  const syncScroll = (from: HTMLElement, to: HTMLElement) => {
    if (from.scrollLeft !== to.scrollLeft) to.scrollLeft = from.scrollLeft;
  };
  const onTableScroll = () => {
    if (rowsElRef.current && bottomScrollRef.current) {
      syncScroll(rowsElRef.current, bottomScrollRef.current);
    }
  };
  const onBottomScroll = () => {
    if (bottomScrollRef.current && rowsElRef.current) {
      syncScroll(bottomScrollRef.current, rowsElRef.current);
    }
  };

  /** 插入位指示线（表格行之间渲染；colSpan 含行号列 + 字段列 + 表头「+」列）。 */
  const insertIndicator = (i: number) =>
    dragInsertIndex === i && draggingRowId ? (
      <tr className="pointer-events-none">
        <td colSpan={fields.length + 2} className="p-0" style={{ background: "var(--accent)", height: 2 }} />
      </tr>
    ) : null;

  return (
    <div className="h-full flex flex-col" style={{ background: "var(--bg-primary)" }}>
      {/* 工具条 */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 border-b flex-shrink-0 text-xs"
        style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
      >
        <span className="flex-shrink-0">{saving ? SAVE_TEXT.saving : SAVE_TEXT.saved}</span>
        {conflictPending && (
          <span
            className="flex items-center gap-1.5 px-1.5 py-0.5 rounded flex-shrink-0"
            style={{ color: "#f59e0b", background: "rgba(245,158,11,0.1)" }}
          >
            表格与外部修改冲突（本地有未保存改动）
            <button
              onClick={() => void resolveConflict(false)}
              className="px-1 rounded hover:opacity-80"
              style={{ background: "rgba(245,158,11,0.2)", color: "#f59e0b" }}
              title="丢弃本地改动，加载磁盘最新内容"
            >
              重新加载（丢弃本地）
            </button>
            <button
              onClick={() => void resolveConflict(true)}
              className="px-1 rounded hover:opacity-80"
              style={{ background: "rgba(245,158,11,0.2)", color: "#f59e0b" }}
              title="用本地内容覆盖磁盘（外部改动丢失）"
            >
              保留本地并保存
            </button>
          </span>
        )}
        {error && (
          <span
            className="flex items-center gap-1.5 px-1.5 py-0.5 rounded flex-shrink-0"
            style={{ color: "#f87171", background: "rgba(248,113,113,0.1)" }}
          >
            <span className="truncate max-w-[260px]">{error}</span>
            <button
              onClick={() => clearError()}
              className="px-1 rounded hover:opacity-80"
              style={{ background: "rgba(248,113,113,0.2)", color: "#f87171" }}
              aria-label="关闭错误提示"
            >
              <X size={12} />
            </button>
          </span>
        )}
        <span className="flex-1" />
        {/* 视图切换：表格 / 时间线（内存态不持久化） */}
        <div className="flex items-center rounded border flex-shrink-0" style={{ borderColor: "var(--border)" }}>
          <button
            onClick={() => setView("table")}
            className="px-2 py-0.5 text-xs transition-colors"
            style={{
              color: view === "table" ? "var(--accent-fg)" : "var(--text-secondary)",
              background: view === "table" ? "var(--accent)" : undefined,
            }}
            title="表格视图"
          >
            表格
          </button>
          <button
            onClick={() => setView("timeline")}
            className="px-2 py-0.5 text-xs transition-colors"
            style={{
              color: view === "timeline" ? "var(--accent-fg)" : "var(--text-secondary)",
              background: view === "timeline" ? "var(--accent)" : undefined,
            }}
            title="时间线视图（按时长排布，可预演）"
          >
            时间线
          </button>
        </div>
        <span className="flex-shrink-0" style={{ color: "var(--text-muted)" }}>
          {rows.length} 行 · {fields.length} 列
        </span>
        <button
          onClick={() => {
            void exportXlsx().then((ok) => {
              if (ok) setExported(true);
            });
          }}
          className="flex items-center gap-1 px-2 py-1 rounded transition-colors"
          style={{ color: exported ? "var(--accent)" : "var(--text-secondary)", background: exported ? "rgba(212,175,55,0.15)" : undefined }}
          title="导出为 xlsx"
        >
          <FileOutput size={13} /> {exported ? "已导出" : "导出 xlsx"}
        </button>
      </div>

      {/* 时间线视图：整块替换表格主体（保留工具条） */}
      {view === "timeline" ? (
        <TableTimeline />
      ) : (
        <>
          {/* 表格主体（横向溢出滚动；onScroll 同步底部滑动条；原生横向滚动条隐藏避免双条） */}
      <div
        ref={rowsElRef}
        className="flex-1 overflow-auto relative no-horizontal-scrollbar"
        onScroll={onTableScroll}
      >
        <table className="border-collapse table-fixed" style={{ width: totalWidth }}>
          <colgroup>
            <col style={{ width: ROW_NUM_COL_WIDTH }} />
            {fields.map((f) => (
              <col key={f.id} style={{ width: widthOf(f) }} />
            ))}
            <col style={{ width: ADD_FIELD_COL_WIDTH }} />
          </colgroup>
          <thead>
            <tr>
              <th
                className="border-b border-r text-center sticky top-0 z-10"
                style={{ background: "var(--bg-secondary)", borderColor: "var(--border)" }}
              >
                <Columns3 size={12} className="mx-auto" style={{ color: "var(--text-muted)" }} />
              </th>
              {fields.map((f) => (
                <th
                  key={f.id}
                  className="border-b border-r align-middle px-1.5 py-1 sticky top-0 z-10 group relative"
                  style={{ background: "var(--bg-secondary)", borderColor: "var(--border)" }}
                >
                  <div className="flex items-center gap-1 min-w-0">
                    <span className="truncate flex-1 font-normal" title={f.name}>
                      {f.name}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const rect = e.currentTarget.getBoundingClientRect();
                        setFieldMenu({ fieldId: f.id, x: rect.left, y: rect.bottom + 2 });
                      }}
                      className="w-5 h-5 flex items-center justify-center rounded hover:bg-[var(--hover)] flex-shrink-0"
                      style={{ color: "var(--text-muted)" }}
                      title="字段菜单"
                    >
                      <MoreHorizontal size={13} />
                    </button>
                  </div>
                  {/* 列宽拖拽手柄：悬停显示金色分隔线，按下拖拽调整（钳制 MIN/MAX） */}
                  <div
                    onPointerDown={(e) => startColResize(e, f)}
                    className="absolute top-0 bottom-0 right-0 w-2 cursor-col-resize group-hover:bg-[var(--accent)]/25 transition-colors"
                    title="拖拽调整列宽"
                  />
                </th>
              ))}
              {/* 表头末尾「+」列：添加字段入口（点击弹出名称 + 类型浮层） */}
              <th
                className="border-b border-r align-middle px-1.5 py-1 sticky top-0 z-10"
                style={{ background: "var(--bg-secondary)", borderColor: "var(--border)" }}
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    const rect = e.currentTarget.getBoundingClientRect();
                    setAddFieldMenu({ x: rect.left, y: rect.bottom + 2 });
                  }}
                  className="w-6 h-6 flex items-center justify-center rounded hover:bg-[var(--hover)]"
                  style={{ color: "var(--text-muted)" }}
                  title="添加字段"
                >
                  <Plus size={14} />
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <Fragment key={row.id}>
                {insertIndicator(i)}
                <tr
                  data-row-id={row.id}
                  onClick={() => selectRow(row.id)}
                  className="align-top"
                  style={{
                    opacity: draggingRowId === row.id ? 0.45 : 1,
                    background: selectedRowId === row.id ? "rgba(212,175,55,0.08)" : undefined,
                    cursor: draggingRowId === row.id ? "grabbing" : undefined,
                  }}
                >
                  {/* 行首：行号 + 拖拽手柄 + 行菜单 */}
                  <td
                    className="border-b border-r px-1 text-center"
                    style={{ borderColor: "var(--border)" }}
                  >
                    <div className="flex items-center justify-center gap-0.5 h-8">
                      <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                        {i + 1}
                      </span>
                      <button
                        onPointerDown={(e) => startRowDrag(e, row.id)}
                        className="w-4 h-5 flex items-center justify-center rounded cursor-grab hover:bg-[var(--hover)]"
                        style={{ color: "var(--text-muted)" }}
                        title="拖动排序"
                      >
                        <GripVertical size={11} />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const rect = e.currentTarget.getBoundingClientRect();
                          setRowMenu({ rowId: row.id, x: rect.left, y: rect.bottom + 2 });
                        }}
                        className="w-4 h-5 flex items-center justify-center rounded hover:bg-[var(--hover)]"
                        style={{ color: "var(--text-muted)" }}
                        title="行菜单"
                      >
                        <MoreHorizontal size={11} />
                      </button>
                    </div>
                  </td>
                  {fields.map((f) => (
                    <td
                      key={f.id}
                      className="border-b border-r"
                      style={{ borderColor: "var(--border)" }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <TableCell field={f} row={row} />
                    </td>
                  ))}
                  {/* 表头「+」列对应的空单元格：行尾横线延伸与表头对齐（border-r 与表头右缘对称） */}
                  <td className="border-b border-r" style={{ borderColor: "var(--border)" }} />
                </tr>
              </Fragment>
            ))}
            {insertIndicator(rows.length)}
          </tbody>
        </table>
        {/* 行尾「+ 新行」：整行可点击创建，底边线与表头对齐（宽度 = 表格总宽，随表格横向滚动） */}
        <div
          className="border-b cursor-pointer transition-colors hover:bg-[var(--hover)]"
          style={{ borderColor: "var(--border)", width: totalWidth }}
          onClick={addRow}
          title="添加新行"
        >
          <div className="flex items-center gap-1 px-2 py-1.5 text-xs" style={{ color: "var(--text-muted)" }}>
            <Plus size={13} /> 新行
          </div>
        </div>
        </div>

        {/* 底部横向滑动条：与表格横向滚动双向同步（常显，防视图切换后消失）。
            高度 = border 1px + 轨道 6px + 内容余量 1px——轨道紧贴横隔线且内容高度 ≥ 1px，
            否则 Chromium 水平滚动条内容区为 0 时 scrollWidth 塌陷、滚动失效 */}
        <div
          ref={bottomScrollRef}
          onScroll={onBottomScroll}
          className="overflow-x-auto flex-shrink-0 border-t"
          style={{ borderColor: "var(--border)", height: 8 }}
        >
          <div style={{ width: totalWidth + 8, height: "100%" }} />
        </div>

        {/* 状态栏（空占位） */}
        <div
          className="flex-shrink-0 border-t px-3 h-6 flex items-center"
          style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
        />
        </>
      )}

      {/* 字段菜单 */}
      {fieldMenu && (
        <FieldMenu
          field={fields.find((f) => f.id === fieldMenu.fieldId)}
          x={fieldMenu.x}
          y={fieldMenu.y}
          onClose={() => setFieldMenu(null)}
        />
      )}
      {/* 行菜单 */}
      {rowMenu && (
        <RowMenu
          rowId={rowMenu.rowId}
          x={rowMenu.x}
          y={rowMenu.y}
          onClose={() => setRowMenu(null)}
        />
      )}
      {/* 添加字段浮层 */}
      {addFieldMenu && (
        <AddFieldMenu x={addFieldMenu.x} y={addFieldMenu.y} onClose={() => setAddFieldMenu(null)} />
      )}
    </div>
  );
}

/** 字段菜单：重命名 / 改类型 / 单选选项管理 / 左·右插入 / 删除（就地确认）。 */
function FieldMenu({
  field,
  x,
  y,
  onClose,
}: {
  field: TableField | undefined;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const renameField = useTableStore((s) => s.renameField);
  const retypeField = useTableStore((s) => s.retypeField);
  const setFieldOptions = useTableStore((s) => s.setFieldOptions);
  const insertField = useTableStore((s) => s.insertField);
  const removeField = useTableStore((s) => s.removeField);
  const fieldIndex = useTableStore((s) => (field ? s.fields.findIndex((f) => f.id === field.id) : -1));

  const [mode, setMode] = useState<"menu" | "rename" | "options" | "insertLeft" | "insertRight">("menu");
  const [draft, setDraft] = useState("");
  const [optionsDraft, setOptionsDraft] = useState((field?.options ?? []).join("\n"));
  const [confirming, setConfirming] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionsRef = useRef<HTMLTextAreaElement>(null);
  const { ref: menuRef, pos } = useClampedMenuPosition(x, y, [mode, confirming]);
  useDismissOnOutside(onClose, menuRef);

  useEffect(() => {
    if (mode === "options") optionsRef.current?.focus();
    else if (mode !== "menu") inputRef.current?.focus();
  }, [mode]);

  if (!field) return null;

  const itemClass =
    "w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--accent)] hover:text-[var(--accent-fg)] inline-flex items-center gap-1.5";

  // 重命名 / 选项管理 / 插入字段：inline 输入
  if (mode === "rename" || mode === "insertLeft" || mode === "insertRight") {
    return (
      <div
        ref={menuRef}
        className="fixed border rounded shadow-lg py-2 px-2.5 z-50 w-44"
        style={{ left: pos.x, top: pos.y, background: "var(--bg-secondary)", borderColor: "var(--border)" }}
      >
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const v = draft.trim();
              if (mode === "rename") renameField(field.id, v || field.name);
              else {
                const idx = mode === "insertLeft" ? fieldIndex : fieldIndex + 1;
                insertField(idx, v || "字段", "text");
              }
              onClose();
            }
            if (e.key === "Escape") onClose();
          }}
          onBlur={onClose}
          placeholder={mode === "rename" ? "字段名称" : "新字段名称"}
          className="w-full bg-transparent border-b border-[var(--accent)] outline-none text-xs"
          style={{ color: "var(--text-primary)" }}
        />
      </div>
    );
  }

  if (mode === "options") {
    return (
      <div
        ref={menuRef}
        className="fixed border rounded shadow-lg p-2.5 z-50 w-52"
        style={{ left: pos.x, top: pos.y, background: "var(--bg-secondary)", borderColor: "var(--border)" }}
      >
        <p className="text-[10px] mb-1" style={{ color: "var(--text-muted)" }}>
          每行一个选项
        </p>
        <textarea
          ref={optionsRef}
          value={optionsDraft}
          onChange={(e) => setOptionsDraft(e.target.value)}
          rows={5}
          className="w-full bg-transparent border border-[var(--border)] rounded p-1.5 outline-none text-xs resize-none"
          style={{ color: "var(--text-primary)" }}
        />
        <div className="flex justify-end gap-1 mt-1.5">
          <button
            onClick={onClose}
            className="px-2 py-0.5 rounded text-xs hover:bg-[var(--hover)]"
            style={{ color: "var(--text-secondary)" }}
          >
            取消
          </button>
          <button
            onClick={() => {
              setFieldOptions(
                field.id,
                optionsDraft.split("\n").map((s) => s.trim()).filter(Boolean),
              );
              onClose();
            }}
            className="px-2 py-0.5 rounded text-xs"
            style={{ background: "rgba(212,175,55,0.15)", color: "var(--accent)" }}
          >
            确定
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={menuRef}
      className="fixed border rounded shadow-lg py-1 z-50 w-44"
      style={{ left: pos.x, top: pos.y, background: "var(--bg-secondary)", borderColor: "var(--border)", color: "var(--text-primary)" }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {confirming ? (
        <div className="px-3 py-1.5">
          <p className="text-xs mb-1.5" style={{ color: "var(--text-muted)" }}>
            删除字段将清空所有行该列的值
          </p>
          <button
            onClick={() => {
              removeField(field.id);
              onClose();
            }}
            className="w-full text-left px-3 py-1.5 text-sm rounded mb-1 text-[#f87171] hover:bg-red-600 hover:text-white"
          >
            <span className="inline-flex items-center gap-1.5">
              <Trash2 size={14} /> 确认删除
            </span>
          </button>
          <button
            onClick={() => setConfirming(false)}
            className="w-full text-left px-3 py-1.5 text-sm rounded hover:bg-[var(--accent)] hover:text-[var(--accent-fg)]"
            style={{ color: "var(--text-primary)" }}
          >
            取消
          </button>
        </div>
      ) : (
        <>
          <button className={itemClass} onClick={() => { setMode("rename"); setDraft(field.name); }}>
            <Pencil size={14} /> 重命名
          </button>
          <div className="px-3 py-1">
            <p className="text-[10px] mb-1" style={{ color: "var(--text-muted)" }}>
              字段类型
            </p>
            <div className="flex flex-col gap-0.5">
              {(Object.keys(FIELD_TYPE_LABELS) as FieldType[]).map((t) => (
                <button
                  key={t}
                  onClick={() => {
                    retypeField(field.id, t);
                    onClose();
                  }}
                  className="w-full text-left px-2 py-0.5 text-xs rounded hover:bg-[var(--hover)] inline-flex items-center justify-between"
                  style={{ color: field.type === t ? "var(--accent)" : "var(--text-primary)" }}
                >
                  {FIELD_TYPE_LABELS[t]}
                  {field.type === t && <Check size={11} />}
                </button>
              ))}
            </div>
          </div>
          {field.type === "singleSelect" && (
            <button className={itemClass} onClick={() => { setMode("options"); setOptionsDraft((field.options ?? []).join("\n")); }}>
              单选选项管理
            </button>
          )}
          <hr className="my-1" style={{ borderColor: "var(--border)" }} />
          <button className={itemClass} onClick={() => { setMode("insertLeft"); setDraft(""); }}>
            <Plus size={14} /> 左侧插入字段
          </button>
          <button className={itemClass} onClick={() => { setMode("insertRight"); setDraft(""); }}>
            <Plus size={14} /> 右侧插入字段
          </button>
          <button
            onClick={() => setConfirming(true)}
            className="w-full text-left px-3 py-1.5 text-sm text-[#f87171] hover:bg-red-600 hover:text-white inline-flex items-center gap-1.5"
          >
            <Trash2 size={14} /> 删除字段
          </button>
        </>
      )}
    </div>
  );
}

/** 行菜单：复制行 / 上移 / 下移 / 删除行。 */
function RowMenu({ rowId, x, y, onClose }: { rowId: string; x: number; y: number; onClose: () => void }) {
  const rows = useTableStore((s) => s.rows);
  const duplicateRow = useTableStore((s) => s.duplicateRow);
  const removeRow = useTableStore((s) => s.removeRow);
  const moveRow = useTableStore((s) => s.moveRow);
  const from = rows.findIndex((r) => r.id === rowId);
  const { ref: menuRef, pos } = useClampedMenuPosition(x, y);
  useDismissOnOutside(onClose, menuRef);

  const itemClass =
    "w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--accent)] hover:text-[var(--accent-fg)] inline-flex items-center gap-1.5";

  return (
    <div
      ref={menuRef}
      className="fixed border rounded shadow-lg py-1 z-50 w-36"
      style={{ left: pos.x, top: pos.y, background: "var(--bg-secondary)", borderColor: "var(--border)", color: "var(--text-primary)" }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button className={itemClass} onClick={() => { duplicateRow(rowId); onClose(); }}>
        <Columns3 size={14} /> 复制行
      </button>
      <button
        className={itemClass}
        disabled={from <= 0}
        onClick={() => { moveRow(rowId, from - 1); onClose(); }}
      >
        上移
      </button>
      <button
        className={itemClass}
        disabled={from < 0 || from >= rows.length - 1}
        onClick={() => { moveRow(rowId, from + 2); onClose(); }}
      >
        下移
      </button>
      <hr className="my-1" style={{ borderColor: "var(--border)" }} />
      <button
        onClick={() => { removeRow(rowId); onClose(); }}
        className="w-full text-left px-3 py-1.5 text-sm text-[#f87171] hover:bg-red-600 hover:text-white inline-flex items-center gap-1.5"
      >
        <Trash2 size={14} /> 删除行
      </button>
    </div>
  );
}

/** 添加字段浮层：名称 + 类型选择 + 添加。 */
function AddFieldMenu({ x, y, onClose }: { x: number; y: number; onClose: () => void }) {
  const addField = useTableStore((s) => s.addField);
  const [name, setName] = useState("");
  const [type, setType] = useState<FieldType>("text");
  const inputRef = useRef<HTMLInputElement>(null);
  const { ref: menuRef, pos } = useClampedMenuPosition(x, y);
  useDismissOnOutside(onClose, menuRef);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div
      ref={menuRef}
      className="fixed border rounded shadow-lg p-2.5 z-50 w-48"
      style={{ left: pos.x, top: pos.y, background: "var(--bg-secondary)", borderColor: "var(--border)" }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            addField(name.trim() || "字段", type);
            onClose();
          }
        }}
        placeholder="字段名称"
        className="w-full bg-transparent border-b border-[var(--accent)] outline-none text-xs mb-2"
        style={{ color: "var(--text-primary)" }}
      />
      <div className="flex flex-col gap-0.5 mb-2">
        {(Object.keys(FIELD_TYPE_LABELS) as FieldType[]).map((t) => (
          <button
            key={t}
            onClick={() => setType(t)}
            className="w-full text-left px-2 py-0.5 text-xs rounded hover:bg-[var(--hover)] inline-flex items-center justify-between"
            style={{ color: type === t ? "var(--accent)" : "var(--text-primary)" }}
          >
            {FIELD_TYPE_LABELS[t]}
            {type === t && <Check size={11} />}
          </button>
        ))}
      </div>
      <div className="flex justify-end">
        <button
          onClick={() => {
            addField(name.trim() || "字段", type);
            onClose();
          }}
          className="px-2 py-0.5 rounded text-xs"
          style={{ background: "rgba(212,175,55,0.15)", color: "var(--accent)" }}
        >
          添加
        </button>
      </div>
    </div>
  );
}
