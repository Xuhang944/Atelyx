/**
 * 表格类型化单元格（按字段类型分派编辑器）。
 *
 * - text：单击 = 仅选中（高亮由 td 层负责，不出现编辑框）；选中后打字 = 覆盖编辑
 *   （清空原值，新内容直接覆盖）；双击 = 进入编辑（保留原值光标插入）；失焦/Esc 提交
 * - number：数字输入（失焦/Enter 提交，空 = 清空）；单/双击语义同 text
 * - singleSelect：选项下拉（含空项）
 * - image：多图单元格——缩略图 + 左右切换（>1 张）+ n/m 角标 + 追加/移除；点击缩略图 → 放大预览
 *
 * 纯 UI：值读写经 store（updateCell/addImageToCell/removeImageAt）；
 * 单元格选中（selectCell）由 TableEditor 的 td 层统一处理。
 */
import { ChevronLeft, ChevronRight, ImagePlus, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTableStore } from "@/stores/tableStore";
import { ImageLightbox } from "@/components/table/ImageLightbox";
import { DropdownSelect } from "@/components/common/DropdownSelect";
import type { TableField, TableRow } from "@/types";

/**
 * 覆盖编辑意图订阅：TableEditor 键盘监听（选中单元格后打字）经 store 下发，
 * 匹配本单元格时清除意图并进入覆盖编辑（initial = 覆盖初始内容，IME 为 ""）。
 */
function useOverwriteRequest(
  rowId: string,
  fieldId: string,
  setDraft: (v: string) => void,
  setEditing: (v: boolean) => void,
): void {
  const overwriteTarget = useTableStore((s) => s.overwriteTarget);
  const clearOverwriteTarget = useTableStore((s) => s.clearOverwriteTarget);
  useEffect(() => {
    if (overwriteTarget?.rowId === rowId && overwriteTarget?.fieldId === fieldId) {
      clearOverwriteTarget();
      setDraft(overwriteTarget.initial);
      setEditing(true);
    }
  }, [overwriteTarget, rowId, fieldId, clearOverwriteTarget, setDraft, setEditing]);
}

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

/** 文本单元格：单击仅选中，双击进入编辑（保留原值）；选中后打字 = 覆盖编辑（清空原值）。
 *  编辑态 = absolute textarea 铺满 td（编辑即单元格本身），失焦提交，Esc 取消。 */
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
  const ref = useRef<HTMLTextAreaElement>(null);
  // 选中单元格后打字 → 覆盖编辑（清空原值，新内容直接覆盖）
  useOverwriteRequest(row.id, field.id, setDraft, setEditing);
  useDraftSyncOnUndo(row.id, field.id, setDraft);

  useEffect(() => {
    if (editing) {
      ref.current?.focus();
      ref.current?.setSelectionRange(ref.current.value.length, ref.current.value.length);
    }
  }, [editing]);

  if (editing) {
    return (
      <div className="w-full min-h-8 px-1.5 py-1 text-xs whitespace-pre-wrap break-words">
        {/* 占位（不可见）：与显示态同结构撑起 td 高度（编辑框 absolute 不参与布局）。
            未固定行高 = 内容高（随 draft 增长）；固定行高 = td 高由行高决定。 */}
        <div className="invisible">{draft}</div>
        <textarea
          ref={ref}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            setEditing(false);
            // diff 后才写：失焦未改动不置脏（避免无谓写盘，同 TextNode 惯例）；
            // 保留原文首尾空白（文本即真相，不 trim）；有改动提交会话（撤销单元保留），无改动丢弃
            if (draft !== value) {
              useTableStore.getState().commitCellEdit();
              updateCell(row.id, field.id, draft || undefined);
            } else {
              useTableStore.getState().abortCellEdit();
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              useTableStore.getState().abortCellEdit();
              setDraft(value);
              setEditing(false);
            }
          }}
          // absolute 铺满 td（td relative）：编辑框即单元格本身，无边框无背景，内容滚动
          className="absolute inset-0 w-full h-full resize-none overflow-auto border-none bg-transparent outline-none text-xs px-1.5 py-1 cursor-text"
          style={{ color: "var(--text-primary)" }}
        />
      </div>
    );
  }
  return (
    <div
      // 单击仅选中（td 层高亮），双击进入编辑；maxHeight 限高实现截断：
      // tr height 是 min-height 语义（内容更高会撑开行），固定行高时须显式限高才裁剪
      className="w-full h-full min-h-8 px-1.5 py-1 text-xs whitespace-pre-wrap break-words overflow-hidden cursor-default"
      style={{ color: "var(--text-primary)", maxHeight: row.height ?? undefined }}
      onDoubleClick={(e) => {
        e.preventDefault(); // 阻止双击默认选词选区闪现
        // 编辑会话开始（提交时才确认撤销单元，Esc/无改动不产生空撤销）
        useTableStore.getState().beginCellEdit(row.id, field.id);
        setDraft(value);
        setEditing(true);
      }}
    >
      {value}
    </div>
  );
}

/** 数字/时长单元格：数字输入（失焦/Enter 提交，空 = 清空）。 */
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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value !== undefined ? String(value) : "");
  const ref = useRef<HTMLInputElement>(null);
  // 选中单元格后打字 → 覆盖编辑（清空原值，新内容直接覆盖）
  useOverwriteRequest(row.id, field.id, setDraft, setEditing);
  useDraftSyncOnUndo(row.id, field.id, setDraft);

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  const commit = () => {
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
        setDraft(value !== undefined ? String(value) : "");
      }
    }
  };

  if (editing) {
    return (
      <div className="w-full min-h-8">
        <input
          ref={ref}
          type="number"
          step={field.type === "duration" ? 0.1 : 1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              useTableStore.getState().abortCellEdit();
              setDraft(value !== undefined ? String(value) : "");
              setEditing(false);
            }
          }}
          // absolute 铺满 td（td relative）：编辑框即单元格本身，无边框无背景
          className="absolute inset-0 w-full h-full bg-transparent outline-none border-none text-xs px-1.5 cursor-text"
          style={{ color: "var(--text-primary)" }}
        />
        {field.type === "duration" && (
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
  return (
    <div
      className="flex items-center w-full min-h-8 px-1.5 text-xs cursor-default"
      style={{ color: "var(--text-primary)" }}
      onDoubleClick={(e) => {
        e.preventDefault(); // 阻止双击默认选词选区闪现
        // 编辑会话开始（提交时才确认撤销单元，Esc/无改动不产生空撤销）
        useTableStore.getState().beginCellEdit(row.id, field.id);
        setDraft(value !== undefined ? String(value) : "");
        setEditing(true);
      }}
    >
      <span className="truncate">
        {value !== undefined ? (field.type === "duration" ? `${value} 秒` : String(value)) : ""}
      </span>
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
