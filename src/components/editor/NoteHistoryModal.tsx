/**
 * 笔记历史面板（模态浮层）：版本列表（时间/作者/行为/改动摘要）+ 全文预览 + 回滚。
 * 数据经 vaultStore（noteHistoryLoad/noteHistoryRollback）读写，组件不直连 service。
 * 回滚成功经 onRollback(content) 回传编辑器重载。
 */
import { useEffect, useState } from "react";
import { History, RotateCcw, ChevronDown, ChevronRight, X } from "lucide-react";
import { useVaultStore, type NoteHistoryVersion } from "@/stores/vaultStore";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";

interface Props {
  file: string;
  open: boolean;
  onClose: () => void;
  /** 回滚成功：回传回滚后全文（调用方重载编辑器内容）。 */
  onRollback: (content: string) => void;
}

const ACTION_LABEL: Record<NoteHistoryVersion["action"], string> = {
  edit: "编辑",
  restore: "回滚",
  external: "外部修订",
  create: "新建",
  delete: "删除",
};

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function NoteHistoryModal({ file, open, onClose, onRollback }: Props) {
  const [versions, setVersions] = useState<NoteHistoryVersion[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [confirmSeq, setConfirmSeq] = useState<number | null>(null);
  /** 展开预览的 seq。 */
  const [previewSeq, setPreviewSeq] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoaded(false);
    void useVaultStore
      .getState()
      .noteHistoryLoad(file)
      .then((vs) => {
        if (!cancelled) {
          setVersions(vs);
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, file]);

  async function doRollback(seq: number) {
    setConfirmSeq(null);
    const content = await useVaultStore.getState().noteHistoryRollback(file, seq);
    if (content == null) {
      setError("回滚失败：目标版本内容不可用");
      return;
    }
    setError(null);
    onRollback(content);
    onClose();
  }

  if (!open) return null;

  const name = file.split("/").pop() ?? file;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-[560px] max-h-[80vh] flex flex-col rounded-lg shadow-2xl"
        style={{ background: "var(--bg-primary)", border: "1px solid var(--border)" }}
      >
        <div
          className="flex items-center gap-2 px-3 py-2 flex-shrink-0 select-none"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          <History size={15} style={{ color: "var(--accent)" }} />
          <span className="text-sm" style={{ color: "var(--text-primary)" }}>
            历史记录 · {name}
          </span>
          <button
            className="ml-auto p-1 rounded hover:opacity-80"
            style={{ color: "var(--text-muted)" }}
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-2">
          {error && (
            <div className="px-2 py-1.5 mb-2 text-xs rounded" style={{ color: "#f87171", background: "rgba(248,113,113,0.1)" }}>
              {error}
            </div>
          )}
          {loaded && versions.length === 0 && (
            <div className="py-8 text-center text-xs" style={{ color: "var(--text-muted)" }}>
              暂无历史记录
            </div>
          )}
          {!loaded && (
            <div className="py-8 text-center text-xs" style={{ color: "var(--text-muted)" }}>
              加载中…
            </div>
          )}
          {/* 最新在前 */}
          {[...versions].reverse().map((v) => (
            <div
              key={v.seq}
              className="mb-1.5 rounded border px-2 py-1.5 text-xs"
              style={{ borderColor: "var(--border)", background: "var(--input-bg)" }}
            >
              <div className="flex items-center gap-2">
                <button
                  className="p-0.5 rounded hover:opacity-80"
                  style={{ color: "var(--text-muted)" }}
                  onClick={() => setPreviewSeq(previewSeq === v.seq ? null : v.seq)}
                >
                  {previewSeq === v.seq ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </button>
                <span className="font-medium" style={{ color: "var(--text-primary)" }}>
                  {ACTION_LABEL[v.action] ?? v.action}
                </span>
                <span style={{ color: "var(--text-muted)" }}>
                  {v.author.name}
                  {v.author.device && v.author.device !== v.author.name ? ` · ${v.author.device}` : ""}
                </span>
                <span className="ml-auto" style={{ color: "var(--text-muted)" }}>
                  {fmtTime(v.ts)}
                </span>
                <span style={{ color: "var(--text-secondary)" }}>
                  {v.summary ?? `${v.content.length} 字`}
                </span>
                <button
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:opacity-80"
                  style={{ color: "var(--accent)" }}
                  onClick={() => setConfirmSeq(v.seq)}
                >
                  <RotateCcw size={12} /> 回滚
                </button>
              </div>
              {previewSeq === v.seq && (
                <pre
                  className="mt-1.5 px-2 py-1.5 rounded max-h-40 overflow-auto whitespace-pre-wrap break-words"
                  style={{ background: "var(--input-bg)", color: "var(--text-primary)", fontSize: 11 }}
                >
                  {v.content}
                </pre>
              )}
            </div>
          ))}
        </div>
      </div>

      {confirmSeq !== null && (
        <ConfirmDialog
          title="回滚笔记"
          description={`确定回滚到 ${fmtTime(versions.find((v) => v.seq === confirmSeq)?.ts ?? 0)} 的版本？\n当前未保存的编辑将被覆盖，此操作会记录一条「回滚」历史。`}
          onConfirm={() => void doRollback(confirmSeq)}
          onCancel={() => setConfirmSeq(null)}
        />
      )}
    </div>
  );
}
