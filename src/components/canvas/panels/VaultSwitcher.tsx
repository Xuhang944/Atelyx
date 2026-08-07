/**
 * 文件面板底部仓库切换条。
 * 面板底部通栏按钮（vault 图标 + 当前仓库名 + 展开箭头）→ 点击向上弹出菜单：
 * - 已添加（最近打开）仓库列表：点击切换（当前仓库高亮禁用）
 * - 分隔线下方「管理仓库」→ 返回启动页（VaultSelectPage）
 * 分层：只读 appStore + 调 selectVault / backToVaultSelect（store 内完成 openVault/watcher/登记）。
 */
import { Check, ChevronUp, Library } from "lucide-react";
import { useEffect, useState } from "react";
import { useAppStore } from "@/stores/appStore";

export function VaultSwitcher() {
  const recentVaults = useAppStore((s) => s.recentVaults);
  const vaultRoot = useAppStore((s) => s.vaultRoot);
  const vaultName = useAppStore((s) => s.vaultName);
  const selectVault = useAppStore((s) => s.selectVault);
  const backToVaultSelect = useAppStore((s) => s.backToVaultSelect);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // 点击菜单外部 / Esc 关闭（data-vault-switcher 内不关）
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-vault-switcher]")) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const switchTo = async (root: string) => {
    setOpen(false);
    if (busy || root === vaultRoot) return;
    setBusy(true);
    try {
      await selectVault(root);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative" data-vault-switcher>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 h-8 hover:bg-[var(--hover)]"
        style={{ color: "var(--text-secondary)" }}
        title="切换仓库"
      >
        <Library size={13} className="flex-shrink-0" />
        <span className="flex-1 min-w-0 truncate text-xs text-left" style={{ color: "var(--text-primary)" }}>
          {vaultName}
        </span>
        <ChevronUp size={12} className="flex-shrink-0" />
      </button>

      {open && (
        <div
          className="absolute bottom-full mb-1 left-0 w-full z-50 rounded-lg border shadow-xl py-1"
          style={{ background: "var(--bg-secondary)", borderColor: "var(--border)" }}
        >
          {/* 已添加仓库列表（当前仓库高亮禁用） */}
          <div className="max-h-[40vh] overflow-y-auto py-0.5">
            {recentVaults.length === 0 ? (
              <p className="px-3 py-2 text-xs" style={{ color: "var(--text-muted)" }}>
                暂无已添加的仓库
              </p>
            ) : (
              recentVaults.map((v) => {
                const current = v.root === vaultRoot;
                return (
                  <button
                    key={v.root}
                    onClick={() => void switchTo(v.root)}
                    disabled={busy || current}
                    title={v.root}
                    className="w-full text-left px-3 py-1.5 hover:bg-[var(--hover)] disabled:hover:bg-transparent disabled:cursor-default"
                  >
                    <span
                      className="block text-[13px] truncate"
                      style={{ color: current ? "var(--accent)" : "var(--text-primary)" }}
                    >
                      {v.name}
                      {current && <Check size={12} className="ml-1 inline" />}
                    </span>
                    <span className="block text-[11px] mt-0.5 truncate" style={{ color: "var(--text-muted)" }}>
                      {v.root}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          <div className="mx-2 my-1" style={{ borderTop: "1px solid var(--border)" }} />

          <button
            onClick={() => {
              setOpen(false);
              backToVaultSelect();
            }}
            className="w-full text-left px-3 py-1.5 text-[13px] hover:bg-[var(--hover)]"
            style={{ color: "var(--text-primary)" }}
          >
            管理仓库
          </button>
        </div>
      )}
    </div>
  );
}
