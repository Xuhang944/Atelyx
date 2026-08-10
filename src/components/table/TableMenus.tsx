/**
 * 表格编辑器弹层菜单（字段菜单 / 表头右键列菜单 / 行菜单 / 添加字段浮层 /
 * 整表右键菜单 / 状态栏计算类型菜单）。
 *
 * 弹层惯例与全项目一致：`useClampedMenuPosition` 视口钳制 + `useDismissOnOutside`
 * 关闭交互 + 自带 fixed 定位 div；`MENU_ITEM_CLASS` 收敛菜单项统一样式。
 */
import {
  AlignVerticalSpaceAround,
  ArrowLeft,
  ArrowRight,
  Check,
  Columns3,
  Pencil,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useClampedMenuPosition } from "@/hooks/useClampedMenuPosition";
import { useDismissOnOutside } from "@/hooks/useDismissOnOutside";
import { CALC_TYPE_LABELS, CALC_TYPES_BY_FIELD, FIELD_TYPE_LABELS } from "@/constants/table";
import { useTableStore } from "@/stores/tableStore";
import { columnAutoWidth } from "@/utils/table";
import type { FieldType, TableField } from "@/types";

/** 菜单项统一样式（StatMenu 在末尾追加 justify-between）。 */
const MENU_ITEM_CLASS =
  "w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--accent)] hover:text-[var(--accent-fg)] inline-flex items-center gap-1.5";

/** 字段菜单（⋮ 按钮）：专注字段修改——重命名 / 改类型 / 单选选项管理 / 删除（就地确认）。
 *  列级操作（列宽自适应、左右插入字段）走表头右键 `ColumnMenu`。 */
export function FieldMenu({
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
  const removeField = useTableStore((s) => s.removeField);

  const [mode, setMode] = useState<"menu" | "rename" | "options">("menu");
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

  // 重命名：inline 输入
  if (mode === "rename") {
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
              renameField(field.id, draft.trim() || field.name);
              onClose();
            }
            if (e.key === "Escape") onClose();
          }}
          onBlur={onClose}
          placeholder="字段名称"
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
          <button className={MENU_ITEM_CLASS} onClick={() => { setMode("rename"); setDraft(field.name); }}>
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
            <button className={MENU_ITEM_CLASS} onClick={() => { setMode("options"); setOptionsDraft((field.options ?? []).join("\n")); }}>
              单选选项管理
            </button>
          )}
          <hr className="my-1" style={{ borderColor: "var(--border)" }} />
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

/** 表头右键菜单：专注列修改/调整——列宽自适应 / 左侧插入字段 / 右侧插入字段（inline 输入）。
 *  字段属性修改（重命名/类型/选项/删除）走 ⋮ `FieldMenu`。 */
export function ColumnMenu({
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
  const setFieldWidth = useTableStore((s) => s.setFieldWidth);
  const insertField = useTableStore((s) => s.insertField);
  const rows = useTableStore((s) => s.rows);
  const fieldIndex = useTableStore((s) => (field ? s.fields.findIndex((f) => f.id === field.id) : -1));

  const [mode, setMode] = useState<"menu" | "insertLeft" | "insertRight">("menu");
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { ref: menuRef, pos } = useClampedMenuPosition(x, y, [mode]);
  useDismissOnOutside(onClose, menuRef);

  useEffect(() => {
    if (mode !== "menu") inputRef.current?.focus();
  }, [mode]);

  if (!field) return null;

  // 插入字段：inline 输入
  if (mode !== "menu") {
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
              const idx = mode === "insertLeft" ? fieldIndex : fieldIndex + 1;
              insertField(idx, draft.trim() || "字段", "text");
              onClose();
            }
            if (e.key === "Escape") onClose();
          }}
          onBlur={onClose}
          placeholder="新字段名称"
          className="w-full bg-transparent border-b border-[var(--accent)] outline-none text-xs"
          style={{ color: "var(--text-primary)" }}
        />
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
      <button
        className={MENU_ITEM_CLASS}
        onClick={() => {
          setFieldWidth(field.id, columnAutoWidth(field, rows));
          onClose();
        }}
        title="按该列内容宽度自适应（不小于字段名宽度）"
      >
        <Columns3 size={14} /> 列宽自适应
      </button>
      <button className={MENU_ITEM_CLASS} onClick={() => { setMode("insertLeft"); setDraft(""); }}>
        <ArrowLeft size={14} /> 左侧插入字段
      </button>
      <button className={MENU_ITEM_CLASS} onClick={() => { setMode("insertRight"); setDraft(""); }}>
        <ArrowRight size={14} /> 右侧插入字段
      </button>
    </div>
  );
}

/** 行菜单：复制行 / 上移 / 下移 / 行高自适应 / 删除行。 */
export function RowMenu({ rowId, x, y, onClose }: { rowId: string; x: number; y: number; onClose: () => void }) {
  const rows = useTableStore((s) => s.rows);
  const duplicateRow = useTableStore((s) => s.duplicateRow);
  const removeRow = useTableStore((s) => s.removeRow);
  const moveRow = useTableStore((s) => s.moveRow);
  const clearRowHeight = useTableStore((s) => s.clearRowHeight);
  const from = rows.findIndex((r) => r.id === rowId);
  const { ref: menuRef, pos } = useClampedMenuPosition(x, y);
  useDismissOnOutside(onClose, menuRef);

  return (
    <div
      ref={menuRef}
      className="fixed border rounded shadow-lg py-1 z-50 w-36"
      style={{ left: pos.x, top: pos.y, background: "var(--bg-secondary)", borderColor: "var(--border)", color: "var(--text-primary)" }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button className={MENU_ITEM_CLASS} onClick={() => { duplicateRow(rowId); onClose(); }}>
        <Columns3 size={14} /> 复制行
      </button>
      <button
        className={MENU_ITEM_CLASS}
        disabled={from <= 0}
        onClick={() => { moveRow(rowId, from - 1); onClose(); }}
      >
        上移
      </button>
      <button
        className={MENU_ITEM_CLASS}
        disabled={from < 0 || from >= rows.length - 1}
        onClick={() => { moveRow(rowId, from + 2); onClose(); }}
      >
        下移
      </button>
      <button
        className={MENU_ITEM_CLASS}
        onClick={() => { clearRowHeight(rowId); onClose(); }}
        title="清除手动行高，恢复按内容自然撑开"
      >
        <AlignVerticalSpaceAround size={14} /> 行高自适应
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
export function AddFieldMenu({ x, y, onClose }: { x: number; y: number; onClose: () => void }) {
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

/** 整表选中右键菜单：全部列宽自适应 / 全部行高自适应。 */
export function SelectAllMenu({ x, y, onClose }: { x: number; y: number; onClose: () => void }) {
  const fields = useTableStore((s) => s.fields);
  const rows = useTableStore((s) => s.rows);
  const setFieldWidth = useTableStore((s) => s.setFieldWidth);
  const clearRowHeight = useTableStore((s) => s.clearRowHeight);
  const { ref: menuRef, pos } = useClampedMenuPosition(x, y);
  useDismissOnOutside(onClose, menuRef);

  return (
    <div
      ref={menuRef}
      className="fixed border rounded shadow-lg py-1 z-50 w-44"
      style={{ left: pos.x, top: pos.y, background: "var(--bg-secondary)", borderColor: "var(--border)", color: "var(--text-primary)" }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        className={MENU_ITEM_CLASS}
        onClick={() => {
          for (const f of fields) setFieldWidth(f.id, columnAutoWidth(f, rows));
          onClose();
        }}
        title="按各列内容宽度自适应（不小于字段名宽度）"
      >
        <Columns3 size={14} /> 列宽自适应
      </button>
      <button
        className={MENU_ITEM_CLASS}
        onClick={() => {
          for (const r of rows) clearRowHeight(r.id);
          onClose();
        }}
        title="清除全部手动行高，恢复按内容自然撑开"
      >
        <AlignVerticalSpaceAround size={14} /> 行高自适应
      </button>
    </div>
  );
}

/** 状态栏计算类型菜单：无 + 字段类型可用计算（当前项 accent + Check）。
 *  固定向上弹出（bottom 定位，底边贴点击位置上方不遮住点击处），左边缘对齐点击单元格，右缘视口钳制。 */
export function StatMenu({
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
  const setCalcType = useTableStore((s) => s.setCalcType);
  const menuRef = useDismissOnOutside(onClose);

  if (!field) return null;

  // 左边缘对齐点击单元格，右缘不溢出视口（w-24 = 96px + 4px 边距）
  const left = Math.max(4, Math.min(x, window.innerWidth - 96 - 4));
  // 菜单估算高 ~200px（最多 6 项）：上方空间不足（状态栏贴近窗口顶）时贴视口顶展开，保证选项可达
  const bottom = Math.min(window.innerHeight - y + 4, window.innerHeight - 4 - 200);

  return (
    <div
      ref={menuRef}
      className="fixed border rounded shadow-lg py-1 z-50 w-24"
      style={{
        left,
        bottom,
        background: "var(--bg-secondary)",
        borderColor: "var(--border)",
      }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        className={`${MENU_ITEM_CLASS} justify-between`}
        style={{ color: field.calcType ? "var(--text-primary)" : "var(--accent)" }}
        onClick={() => {
          setCalcType(field.id, undefined);
          onClose();
        }}
      >
        <span>无</span>
        {!field.calcType && <Check size={12} />}
      </button>
      {CALC_TYPES_BY_FIELD[field.type]?.map((t) => (
        <button
          key={t}
          className={`${MENU_ITEM_CLASS} justify-between`}
          style={{ color: field.calcType === t ? "var(--accent)" : "var(--text-primary)" }}
          onClick={() => {
            setCalcType(field.id, t);
            onClose();
          }}
        >
          <span>{CALC_TYPE_LABELS[t]}</span>
          {field.calcType === t && <Check size={12} />}
        </button>
      ))}
    </div>
  );
}
