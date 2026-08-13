/**
 * 文件面板底部仓库切换条。
 * 面板底部通栏按钮（vault 图标 + 当前仓库名 + 展开箭头）→ 点击向上弹出菜单：
 * - 已添加（最近打开）仓库列表：点击切换（当前仓库高亮禁用）
 * - 分隔线下方「管理仓库」→ 返回启动页（VaultSelectPage）
 * 弹层 = `PopupLayer` 统一壳（align="bottom" 向上弹出，底边贴切换条顶边，minWidth = 切换条宽）。
 * 分层：只读 appStore + 调 selectVault / backToVaultSelect（store 内完成 openVault/watcher/登记）。
 */
import { Check, ChevronUp, Library } from "lucide-react";
import { useRef, useState } from "react";
import { useAppStore } from "@/stores/appStore";
import { PopupLayer } from "@/components/common/PopupLayer";
import { usePopupAnchor } from "@/hooks/usePopupAnchor";

export function VaultSwitcher() {
  const recentVaults = useAppStore((s) => s.recentVaults);
  const vaultRoot = useAppStore((s) => s.vaultRoot);
  const vaultName = useAppStore((s) => s.vaultName);
  const selectVault = useAppStore((s) => s.selectVault);
  const backToVaultSelect = useAppStore((s) => s.backToVaultSelect);

  const barRef = useRef<HTMLButtonElement>(null);
  const { anchor, toggle, close } = usePopupAnchor(barRef, { align: "bottom" });
  const [busy, setBusy] = useState(false);

  const switchTo = async (root: string) => {
    close();
    if (busy || root === vaultRoot) return;
    setBusy(true);
    try {
      await selectVault(root);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        ref={barRef}
        onClick={toggle}
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

      <PopupLayer anchor={anchor} onClose={close} triggerRef={barRef} align="bottom">
        {/* 已添加仓库列表（当前仓库高亮禁用）；max-w 限制长路径撑宽，行内 truncate 截断 */}
        <div className="max-h-[40vh] overflow-y-auto py-0.5 max-w-[380px]">
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
            close();
            backToVaultSelect();
          }}
          className="w-full text-left px-3 py-1.5 text-[13px] hover:bg-[var(--hover)]"
          style={{ color: "var(--text-primary)" }}
        >
          管理仓库
        </button>
      </PopupLayer>
    </>
  );
}
