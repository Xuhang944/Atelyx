/**
 * 表格类型化单元格（按字段类型分派编辑器）。
 *
 * - text：点击就地 textarea（失焦/Esc 提交）
 * - number：数字输入（失焦/Enter 提交，空 = 清空）
 * - duration：数字输入 + 「秒」后缀
 * - singleSelect：选项下拉（含空项）
 * - image：多图单元格——缩略图 + 左右切换（>1 张）+ n/m 角标 + 追加/移除；点击缩略图 → 放大预览
 *
 * 纯 UI：值读写经 store（updateCell/addImageToCell/removeImageAt）。
 */
import { ChevronLeft, ChevronRight, ImagePlus, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTableStore } from "@/stores/tableStore";
import { ImageLightbox } from "@/components/table/ImageLightbox";
import { DropdownSelect } from "@/components/common/DropdownSelect";
import type { TableField, TableRow } from "@/types";

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
        onChange={(v) => updateCell(row.id, field.id, v || undefined)}
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

/** 文本单元格：点击就地编辑（textarea 自适应高度，失焦提交，Esc 取消）。 */
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

  useEffect(() => {
    if (editing) {
      ref.current?.focus();
      ref.current?.setSelectionRange(ref.current.value.length, ref.current.value.length);
    }
  }, [editing]);

  if (editing) {
    return (
      <textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          // diff 后才写：失焦未改动不置脏（避免无谓写盘，同 TextNode 惯例）；
          // 保留原文首尾空白（文本即真相，不 trim）
          if (draft !== value) updateCell(row.id, field.id, draft || undefined);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setDraft(value);
            setEditing(false);
          }
        }}
        className="w-full min-h-8 resize-none bg-transparent outline-none text-xs p-1.5"
        style={{ color: "var(--text-primary)" }}
      />
    );
  }
  return (
    <div
      className="w-full min-h-8 px-1.5 py-1 text-xs cursor-text whitespace-pre-wrap break-words"
      style={{ color: "var(--text-primary)" }}
      onClick={() => {
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

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const v = draft.trim();
    if (v === "") {
      updateCell(row.id, field.id, undefined);
    } else {
      const n = Number(v);
      if (!Number.isNaN(n)) updateCell(row.id, field.id, n);
      else setDraft(value !== undefined ? String(value) : "");
    }
  };

  if (editing) {
    return (
      <div className="flex items-center gap-1 px-1">
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
              setDraft(value !== undefined ? String(value) : "");
              setEditing(false);
            }
          }}
          className="w-full h-8 bg-transparent outline-none text-xs"
          style={{ color: "var(--text-primary)" }}
        />
        {field.type === "duration" && <span className="text-[10px] flex-shrink-0" style={{ color: "var(--text-muted)" }}>秒</span>}
      </div>
    );
  }
  return (
    <div
      className="flex items-center w-full min-h-8 px-1.5 text-xs cursor-text"
      style={{ color: "var(--text-primary)" }}
      onClick={() => {
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
      <div className="group flex items-center justify-center min-h-8 p-1">
        <button
          onClick={() => void addImageToCell(row.id, field.id)}
          className="w-6 h-6 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-[var(--hover)]"
          style={{ color: "var(--text-muted)" }}
          title="添加图片"
        >
          <ImagePlus size={14} />
        </button>
      </div>
    );
  }

  return (
    <div className="relative p-1 group">
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
