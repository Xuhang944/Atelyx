/**
 * 多维表格编辑器（表格视图）。
 *
 * 布局：工具条（视图切换 / 导出；冲突/错误/保存状态在面积 header）→ 表格主体（行号列 + 列头 + 类型化单元格）→
 * 行尾「+ 新行」→ 底部横向滑动条 → 状态栏（列自动计算，整格点击选类型 + 实时结果）。
 *
 * 交互要点：
 * - 选中体系（互斥）：左上角整格单击全选（角标示意）/ 右键全选并弹菜单；表头单击选整列；
 *   行首单击选整行；单元格按下不动（<5px）松手 = 选中（td 金色内描边，进入隐藏编辑态，
 *   编辑时保持单元格大小），拖动（>5px）= 区域选择/移动手势预留（不进编辑）。
 *   选中后打字直达常驻输入框，首个字符/IME 组合覆盖原值；双击 = 取消覆盖（保留原值）。
 * - 行拖拽为 pointer 模拟（HTML5 DnD 在 WebView2 不可靠，与文件面板同策略）：
 *   行首手柄按下 → 位移超 5px 激活 → 按行元素中点计算插入位（金色插入线指示）→ 松手 moveRow。
 * - 列宽：列头右缘拖拽（钳制 MIN/MAX）；行高：行首底缘拖拽。表头/行首/整表选中后右键菜单
 *   （`ColumnMenu`/`RowMenu`/`SelectAllMenu`）提供列宽/行高自适应与左右插入字段。
 * - 状态栏：每列整格 hover 高亮可点击（未设置留空），弹出计算类型菜单（固定向上弹出，
 *   底边贴点击位置不遮住点击处）；已设置列居中显示「类型 + 结果」。
 * - 冲突/错误/保存状态在面积 header 展示（`AreaFrame` 读 tableStore）。
 * - 弹层菜单（字段/列/行/整表/状态栏）见 `TableMenus.tsx`。
 */
import { FileOutput, GripVertical, MoreHorizontal, MoveDiagonal, Plus, Sigma } from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useTableStore } from "@/stores/tableStore";
import { useUiStateStore } from "@/stores/uiStateStore";
import { TableCell, clearCell, navigateCell, navDirection } from "@/components/table/TableCell";
import { TableTimeline } from "@/components/table/TableTimeline";
import { useCollabStore } from "@/stores/collabStore";
import type { CollabPeer } from "@/types";
import {
  AddFieldMenu,
  ColumnMenu,
  FieldMenu,
  RowMenu,
  SelectAllMenu,
  StatMenu,
} from "@/components/table/TableMenus";
import { computeColumnCalc, fieldDefaultWidth } from "@/utils/table";
import {
  ADD_FIELD_COL_WIDTH,
  CALC_TYPE_LABELS,
  MAX_COL_WIDTH,
  MAX_ROW_HEIGHT,
  MIN_COL_WIDTH,
  MIN_ROW_HEIGHT,
  ROW_NUM_COL_WIDTH,
} from "@/constants/table";
import type { TableField, TableRow } from "@/types";

/** 表格编辑器：areaId 用于聚焦判定（撤销/重做快捷键门控，同画布快捷键惯例）。 */
export function TableEditor({ areaId }: { areaId: string }) {
  const fields = useTableStore((s) => s.fields);
  const rows = useTableStore((s) => s.rows);
  const selection = useTableStore((s) => s.selection);
  const selectRow = useTableStore((s) => s.selectRow);
  const selectCell = useTableStore((s) => s.selectCell);
  const selectField = useTableStore((s) => s.selectField);
  const selectAll = useTableStore((s) => s.selectAll);
  const focusedAreaId = useUiStateStore((s) => s.focusedAreaId);
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

  // 字段菜单 / 行菜单 / 添加字段浮层 / 状态栏计算菜单
  const [fieldMenu, setFieldMenu] = useState<{ fieldId: string; x: number; y: number } | null>(null);
  const [columnMenu, setColumnMenu] = useState<{ fieldId: string; x: number; y: number } | null>(null);
  const [rowMenu, setRowMenu] = useState<{ rowId: string; x: number; y: number } | null>(null);
  const [addFieldMenu, setAddFieldMenu] = useState<{ x: number; y: number } | null>(null);
  const [statMenu, setStatMenu] = useState<{ fieldId: string; x: number; y: number } | null>(null);
  const [allMenu, setAllMenu] = useState<{ x: number; y: number } | null>(null);

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

  // ===== Ctrl+Z/Y 撤销/重做 + 选中态焦点兜底导航（全局键盘监听；选中单元格的覆盖输入由常驻输入框承接，不经此监听）=====
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // 仅表格面积聚焦时生效（同画布快捷键门控惯例）；编辑框聚焦同样接管
      // （受控 input/textarea 原生撤销不可靠，整编辑会话一步撤销与 Esc 放弃编辑互补）
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && !e.altKey && focusedAreaId === areaId) {
        const key = e.key.toLowerCase();
        if (key === "z" && !e.shiftKey) {
          e.preventDefault();
          useTableStore.getState().undo();
          return;
        }
        if (key === "y" || (key === "z" && e.shiftKey)) {
          e.preventDefault();
          useTableStore.getState().redo();
          return;
        }
      }
      if (ctrl || e.altKey) return;
      if (focusedAreaId !== areaId) return;
      // —— 焦点兜底导航 ——
      // 导航撞上非文本字段单元格（singleSelect/image 无常驻输入框）或点击空白后焦点落 body，
      // 方向键默认行为会滚动表格：此处按选中态语义接管导航；输入框聚焦（编辑态/选中态）时
      // 自身 keydown 已处理，不重复；lightbox 打开时方向键归其切图，不接管。
      const st = useTableStore.getState();
      if (st.view !== "table") return;
      const sel = st.selection;
      if (sel?.kind !== "cell") return;
      const el = document.activeElement;
      if (el && el !== document.body && el !== document.documentElement) return;
      if (document.querySelector("[data-lightbox]")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        st.selectRow(null); // 取消并清选中
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault(); // 防浏览器默认（滚动/后退）
        // 输入框失焦时（点了表格空白）清空语义照常：文本类字段清空，其余无操作
        const field = st.fields.find((f) => f.id === sel.fieldId);
        if (field && (field.type === "text" || field.type === "number" || field.type === "duration")) {
          clearCell(sel.rowId, sel.fieldId);
        }
        return;
      }
      const dir = navDirection(e.key);
      if (dir) {
        e.preventDefault();
        navigateCell(sel.rowId, sel.fieldId, dir); // 移动选中（高亮跟随，输入框回到文本列自动聚焦）
        return;
      }
      // 可打印字符（焦点落空后打字）：重新聚焦常驻输入框，不 preventDefault——
      // 字符随 keydown 默认行为落入新焦点元素，覆盖编辑照常（同步聚焦机制）
      if (e.key.length === 1) {
        const field = st.fields.find((f) => f.id === sel.fieldId);
        if (field && (field.type === "text" || field.type === "number" || field.type === "duration")) {
          rowsElRef.current
            ?.querySelector<HTMLTextAreaElement | HTMLInputElement>("[data-cell-editor]")
            ?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusedAreaId, areaId]);

  // ===== 单元格按下手势：<5px 松手 = 选中（进入隐藏编辑态）；>5px 拖动 = 区域选择/移动手势预留（不进编辑）=====
  const cellPressRef = useRef<{ rowId: string; fieldId: string; x: number; y: number; active: boolean } | null>(null);
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const p = cellPressRef.current;
      if (!p) return;
      if (!p.active && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 5) {
        cellPressRef.current = { ...p, active: true };
      }
    };
    const onUp = () => {
      cellPressRef.current = null;
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
  }, []);

  const startCellPress = useCallback((e: React.PointerEvent, rowId: string, fieldId: string) => {
    if (e.button !== 0) return;
    cellPressRef.current = { rowId, fieldId, x: e.clientX, y: e.clientY, active: false };
  }, []);

  /** 单元格松手（未拖动）→ 选中 + 标记面积聚焦（点 td 不冒泡到面积层，快捷键门控需显式标记）+
   *  聚焦常驻输入框（已选中单元格的再次点击不触发重渲染，须直接聚焦防失焦后打字失效）。 */
  const releaseCellPress = useCallback(
    (rowId: string, fieldId: string) => {
      const p = cellPressRef.current;
      if (!p || p.active) return;
      cellPressRef.current = null;
      useUiStateStore.getState().setFocusedArea(areaId);
      selectCell(rowId, fieldId);
      rowsElRef.current
        ?.querySelector<HTMLTextAreaElement | HTMLInputElement>("[data-cell-editor]")
        ?.focus();
    },
    [areaId, selectCell],
  );

  // ===== 列宽 / 行高拖拽调整（指针模拟，与行拖拽同策略）=====
  const resizeRef = useRef<
    | { kind: "col"; fieldId: string; startX: number; startWidth: number }
    | { kind: "row"; rowId: string; startY: number; startHeight: number }
    | null
  >(null);
  /** 拖拽是否已入栈（首次实际变化才 push，点击未拖动不产生空撤销单元）。 */
  const pushedRef = useRef(false);
  const setFieldWidth = useTableStore((s) => s.setFieldWidth);
  const setRowHeight = useTableStore((s) => s.setRowHeight);
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      if (r.kind === "col") {
        const width = Math.round(
          Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, r.startWidth + (e.clientX - r.startX))),
        );
        // 拖拽会话首次实际变化才入栈（期间连续调整合并为一步撤销）
        if (!pushedRef.current && width !== r.startWidth) {
          useTableStore.getState().pushUndo();
          pushedRef.current = true;
        }
        setFieldWidth(r.fieldId, width);
      } else {
        const height = Math.round(
          Math.max(MIN_ROW_HEIGHT, Math.min(MAX_ROW_HEIGHT, r.startHeight + (e.clientY - r.startY))),
        );
        if (!pushedRef.current && height !== r.startHeight) {
          useTableStore.getState().pushUndo();
          pushedRef.current = true;
        }
        setRowHeight(r.rowId, height);
      }
    };
    const onUp = () => {
      resizeRef.current = null;
      pushedRef.current = false;
      document.body.style.cursor = "";
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
    };
  }, [setFieldWidth, setRowHeight]);

  const startColResize = useCallback((e: React.PointerEvent, field: TableField) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = {
      kind: "col",
      fieldId: field.id,
      startX: e.clientX,
      startWidth: field.width ?? fieldDefaultWidth(field.name),
    };
    pushedRef.current = false;
    document.body.style.cursor = "col-resize";
  }, []);

  /** 行高拖拽起点：手动高度优先，缺省读当前 DOM 实际行高（内容撑开的值），防起点跳变。 */
  const startRowResize = useCallback((e: React.PointerEvent, row: TableRow) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = rowsElRef.current?.querySelector<HTMLElement>(`[data-row-id="${row.id}"]`);
    resizeRef.current = {
      kind: "row",
      rowId: row.id,
      startY: e.clientY,
      startHeight: row.height ?? el?.offsetHeight ?? MIN_ROW_HEIGHT,
    };
    pushedRef.current = false;
    document.body.style.cursor = "row-resize";
  }, []);

  /** 列宽：手动调整值优先，缺省按字段名自适应。 */
  const widthOf = (f: TableField): number => f.width ?? fieldDefaultWidth(f.name);
  /** 表格总宽 = 行号列 + 各列宽 + 表头末尾「+」列：显式设给 table，拖宽一列只增总宽、
   *  其他列不挤压（border-collapse + table-fixed 无显式宽度时引擎会撑满容器并重分配）。 */
  const totalWidth = ROW_NUM_COL_WIDTH + fields.reduce((acc, f) => acc + widthOf(f), 0) + ADD_FIELD_COL_WIDTH;

  // ===== 协作 presence：同仓库看同一表格的在线用户（远端选中高亮 + 工具条胶囊）=====
  const tableFile = useTableStore((s) => s.tableFile);
  const collabPeers = useCollabStore((s) => s.peers);
  /** 本表格相关的远端用户（presence.file 匹配当前表格；未打开表格时无）。 */
  const tablePeers = tableFile ? collabPeers.filter((p) => p.presence?.file === tableFile) : [];
  /** 定位到远端用户选中位置（行滚动到视口中央；timeline 卡片同样带 data-row-id，
   *  document 查询命中当前渲染的视图——任一布局内表格视图唯一，无歧义）。 */
  const focusPeer = (p: CollabPeer) => {
    const sel = p.presence?.selection;
    if (!sel || sel.kind === "all") return;
    const rowId = sel.kind === "cell" || sel.kind === "row" ? sel.rowId : null;
    if (!rowId) return;
    const el =
      view === "table"
        ? rowsElRef.current?.querySelector<HTMLElement>(`[data-row-id="${rowId}"]`)
        : document.querySelector<HTMLElement>(`[data-row-id="${rowId}"]`);
    el?.scrollIntoView({ block: "center", inline: "nearest" });
  };

  // ===== 选中高亮（互斥：单元格 = td 内描边；行/列/整表 = 淡金背景）=====
  const rowHighlighted = (rowId: string): boolean =>
    selection?.kind === "row" ? selection.rowId === rowId : selection?.kind === "all";
  const colHighlighted = (fieldId: string): boolean =>
    selection?.kind === "column" ? selection.fieldId === fieldId : selection?.kind === "all";
  const cellSelected = (rowId: string, fieldId: string): boolean =>
    selection?.kind === "cell" && selection.rowId === rowId && selection.fieldId === fieldId;
  /** 行/列/整表的淡金背景（列选中作用于表头与数据单元格）。 */
  const highlightBg = (highlighted: boolean) => (highlighted ? "color-mix(in srgb, var(--accent) 8%, transparent)" : undefined);
  /** 远端用户选中覆盖本单元格的（cell 精确 / row 整行 / column 整列 / all 全表）。 */
  const peersAtCell = (rowId: string, fieldId: string): CollabPeer[] =>
    tablePeers.filter((p) => {
      const sel = p.presence?.selection;
      if (!sel) return false;
      if (sel.kind === "cell") return sel.rowId === rowId && sel.fieldId === fieldId;
      if (sel.kind === "row") return sel.rowId === rowId;
      if (sel.kind === "column") return sel.fieldId === fieldId;
      return true;
    });
  /** 单元格描边：本端选中 = 金色 2px；远端覆盖 = 用户色 1px 同心叠加（多用户自动分层）。 */
  const cellShadow = (rowId: string, fieldId: string): string | undefined => {
    if (cellSelected(rowId, fieldId)) return "inset 0 0 0 2px var(--accent)";
    const ps = peersAtCell(rowId, fieldId);
    if (ps.length === 0) return undefined;
    return ps.map((p, i) => `inset 0 0 0 ${i + 1}px ${p.color}`).join(", ");
  };

  // ===== 底部横向滑动条 + 状态栏：与表格横向滚动双向同步（常显；宽度 = 表格总宽 + 边框余量）=====
  const bottomScrollRef = useRef<HTMLDivElement>(null);
  const statBarRef = useRef<HTMLDivElement>(null);
  const syncScroll = (from: HTMLElement, to: HTMLElement) => {
    if (from.scrollLeft !== to.scrollLeft) to.scrollLeft = from.scrollLeft;
  };
  const onTableScroll = () => {
    if (rowsElRef.current && bottomScrollRef.current) {
      syncScroll(rowsElRef.current, bottomScrollRef.current);
    }
    if (rowsElRef.current && statBarRef.current) {
      syncScroll(rowsElRef.current, statBarRef.current);
    }
  };
  const onBottomScroll = () => {
    if (bottomScrollRef.current && rowsElRef.current) {
      syncScroll(bottomScrollRef.current, rowsElRef.current);
    }
  };
  const onStatBarScroll = () => {
    if (statBarRef.current && rowsElRef.current) {
      syncScroll(statBarRef.current, rowsElRef.current);
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
      {/* 工具条（冲突/错误/保存状态均在面积 header） */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 border-b flex-shrink-0 text-xs"
        style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
      >
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
        {/* 协作：同看本表格的在线用户胶囊（点击定位其选中位置；断开连接自动消失） */}
        {tablePeers.length > 0 && (
          <div className="flex items-center gap-1 flex-shrink-0">
            {tablePeers.map((p) => (
              <button
                key={p.peerId}
                onClick={() => focusPeer(p)}
                className="flex items-center gap-1.5 px-1.5 py-0.5 rounded transition-colors hover:bg-[var(--hover)]"
                title={`${p.nickname}${p.deviceName ? `（${p.deviceName}）` : ""} · 点击定位到其选中`}
              >
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: p.color }} />
                <span className="max-w-24 truncate" style={{ color: "var(--text-secondary)" }}>
                  {p.nickname}
                </span>
              </button>
            ))}
          </div>
        )}
        <button
          onClick={() => {
            void exportXlsx().then((ok) => {
              if (ok) setExported(true);
            });
          }}
          className="flex items-center gap-1 px-2 py-1 rounded transition-colors"
          style={{ color: exported ? "var(--accent)" : "var(--text-secondary)", background: exported ? "color-mix(in srgb, var(--accent) 15%, transparent)" : undefined }}
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
        // 整表选中时右键任意数据单元格 → 列宽/行高自适应菜单（行首/表头各自处理；实时读 selection 防冒泡冲突）
        onContextMenu={(e) => {
          if (useTableStore.getState().selection?.kind !== "all") return;
          e.preventDefault();
          setAllMenu({ x: e.clientX, y: e.clientY });
        }}
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
                className="relative border-b border-r text-center sticky top-0 z-10"
                style={{ background: "var(--bg-secondary)", borderColor: "var(--border)" }}
                onClick={selectAll}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  selectAll();
                  setAllMenu({ x: e.clientX, y: e.clientY });
                }}
                title="单击全选 · 右键全选并弹出菜单"
              >
                {/* 右下角角标（纯示意，事件穿透）：整格可点击全选 */}
                <div
                  className="absolute bottom-0.5 right-0.5 w-4 h-4 pointer-events-none"
                  style={{ color: "var(--text-muted)" }}
                >
                  <MoveDiagonal size={11} />
                </div>
              </th>
              {fields.map((f) => (
                <th
                  key={f.id}
                  className="border-b border-r align-middle px-1.5 py-1 sticky top-0 z-10 group relative"
                  style={{
                    background: colHighlighted(f.id) ? "color-mix(in srgb, var(--accent) 8%, transparent)" : "var(--bg-secondary)",
                    borderColor: "var(--border)",
                  }}
                  onClick={() => selectField(f.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    selectField(f.id);
                    setColumnMenu({ fieldId: f.id, x: e.clientX, y: e.clientY });
                  }}
                  title="单击选中整列"
                >
                  <div className="flex items-center gap-1 min-w-0">
                    <span className="truncate flex-1 font-normal cursor-default" title={f.name}>
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
                className="border-b border-r align-middle px-1.5 py-1 sticky top-0 z-10 text-center"
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
                    height: row.height ?? undefined,
                    opacity: draggingRowId === row.id ? 0.45 : 1,
                    background: highlightBg(rowHighlighted(row.id)),
                    cursor: draggingRowId === row.id ? "grabbing" : undefined,
                  }}
                >
                  {/* 行首：行号 + 拖拽手柄 + 底部行高拖拽手柄（行菜单走右键） */}
                  <td
                    className="relative border-b border-r px-1 text-center"
                    style={{ borderColor: "var(--border)" }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      selectRow(row.id);
                      setRowMenu({ rowId: row.id, x: e.clientX, y: e.clientY });
                    }}
                    title="右键行菜单 · 底部拖拽调行高"
                  >
                    {/* absolute 铺满 td：序号 + 拖拽手柄随行高垂直居中（行高拖拽手柄在其下层仍可交互） */}
                    <div className="absolute inset-0 flex items-center justify-center gap-0.5">
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
                    </div>
                    {/* 行高拖拽手柄：底部横条，按下拖拽调整（钳制 MIN/MAX） */}
                    <div
                      onPointerDown={(e) => startRowResize(e, row)}
                      className="absolute left-0 right-0 bottom-0 h-1.5 cursor-row-resize hover:bg-[var(--accent)]/25 transition-colors"
                      title="拖拽调整行高"
                    />
                  </td>
                  {fields.map((f) => (
                    <td
                      key={f.id}
                      // relative：编辑态 textarea absolute inset-0 以此为定位上下文撑满单元格
                      className="border-b border-r relative"
                      style={{
                        borderColor: "var(--border)",
                        background: highlightBg(colHighlighted(f.id)),
                        boxShadow: cellShadow(row.id, f.id),
                      }}
                      onPointerDown={(e) => startCellPress(e, row.id, f.id)}
                      onPointerUp={() => releaseCellPress(row.id, f.id)}
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

        {/* 状态栏：列自动计算（整格点击选择计算类型，hover 高亮，内容居中，横向滚动与表格同步） */}
        <div
          ref={statBarRef}
          onScroll={onStatBarScroll}
          className="flex-shrink-0 border-t overflow-x-auto no-horizontal-scrollbar h-8"
          style={{ borderColor: "var(--border)" }}
        >
          {/* h-full：容器 h-8 固定高，内部 flex 无此会塌陷为内容高（items-stretch 只管它的子项），内容贴顶留白 */}
          <div className="flex h-full items-stretch" style={{ width: totalWidth }}>
            <div
              className="flex-shrink-0 flex items-center justify-center border-r"
              style={{ width: ROW_NUM_COL_WIDTH, color: "var(--text-muted)", borderColor: "var(--border)" }}
              title="列自动计算"
            >
              <Sigma size={13} />
            </div>
            {fields.map((f) => {
              const result = computeColumnCalc(f, rows);
              return (
                <div
                  key={f.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    const rect = e.currentTarget.getBoundingClientRect();
                    setStatMenu({ fieldId: f.id, x: rect.left, y: rect.top });
                  }}
                  className="flex-shrink-0 flex items-center justify-center px-1.5 border-r cursor-pointer transition-colors hover:bg-[var(--hover)]"
                  style={{ width: widthOf(f), borderColor: "var(--border)" }}
                  title={f.calcType ? `${CALC_TYPE_LABELS[f.calcType]}：${result ?? "—"}` : "选择计算类型"}
                >
                  {result !== null && (
                    <span className="truncate text-xs" style={{ color: "var(--text-primary)" }} title={result}>
                      {f.calcType ? `${CALC_TYPE_LABELS[f.calcType]} ${result}` : result}
                    </span>
                  )}
                </div>
              );
            })}
            <div className="flex-shrink-0" style={{ width: ADD_FIELD_COL_WIDTH }} />
          </div>
        </div>
        </>
      )}

      {/* 字段菜单（⋮：字段修改） */}
      {fieldMenu && (
        <FieldMenu
          field={fields.find((f) => f.id === fieldMenu.fieldId)}
          x={fieldMenu.x}
          y={fieldMenu.y}
          onClose={() => setFieldMenu(null)}
        />
      )}
      {/* 表头右键菜单（列修改/调整） */}
      {columnMenu && (
        <ColumnMenu
          field={fields.find((f) => f.id === columnMenu.fieldId)}
          x={columnMenu.x}
          y={columnMenu.y}
          onClose={() => setColumnMenu(null)}
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
      {/* 状态栏计算类型菜单 */}
      {statMenu && (
        <StatMenu
          field={fields.find((f) => f.id === statMenu.fieldId)}
          x={statMenu.x}
          y={statMenu.y}
          onClose={() => setStatMenu(null)}
        />
      )}
      {/* 整表选中右键菜单：全部列宽 / 行高自适应 */}
      {allMenu && <SelectAllMenu x={allMenu.x} y={allMenu.y} onClose={() => setAllMenu(null)} />}
    </div>
  );
}
