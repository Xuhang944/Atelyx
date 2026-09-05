/**
 * 设置 → 插件面板：已装插件管理 + 市场浏览。
 *
 * - 已装列表（app + 当前仓库 vault 级）：启停/更新/卸载，展示类型/作用域/版本/运行状态/
 *   声明的命令/能力清单（敏感能力高亮）——启用前用户据此判断插件要碰什么。
 * - 市场：搜索/筛选/安装（见 MarketplaceSection）。
 * 分层：本组件只经 pluginStore 触达插件能力（不直连 services）。
 */
import { useState } from "react";
import { RefreshCw, Trash2 } from "lucide-react";
import { usePluginStore } from "@/stores/pluginStore";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { ToggleSwitch } from "@/components/common/ToggleSwitch";
import { MarketplaceSection } from "@/components/plugins/MarketplaceSection";
import {
  PLUGIN_CAPABILITY_LABELS,
  PLUGIN_SCOPE_LABELS,
  PLUGIN_TYPE_LABELS,
} from "@/constants/plugins";
import { isSensitiveCapability } from "@/utils/pluginManifest";

type TabMode = "installed" | "market";

export function PluginsSettingsTab() {
  const plugins = usePluginStore((s) => s.plugins);
  const setEnabled = usePluginStore((s) => s.setEnabled);
  const update = usePluginStore((s) => s.update);
  const uninstall = usePluginStore((s) => s.uninstall);

  const [mode, setMode] = useState<TabMode>("installed");
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null);

  const rows = Object.values(plugins).sort((a, b) => (a.id < b.id ? -1 : 1));

  return (
    <section className="flex-1 min-h-0 p-5 flex flex-col overflow-hidden">
      {/* 模式切换：已安装 / 市场 */}
      <div className="flex gap-1 mb-4">
        {(
          [
            { key: "installed", label: "已安装" },
            { key: "market", label: "市场" },
          ] as { key: TabMode; label: string }[]
        ).map((m) => (
          <button
            key={m.key}
            onClick={() => setMode(m.key)}
            className="px-3 py-1.5 rounded text-xs"
            style={
              mode === m.key
                ? { background: "var(--accent)", color: "var(--accent-fg)" }
                : { color: "var(--text-secondary)", background: "transparent" }
            }
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode === "market" ? (
        <MarketplaceSection />
      ) : (
        <>
      {/* 操作反馈（更新/卸载错误等） */}
      {notice && (
        <div
          className="text-xs mb-3 break-words"
          style={{ color: notice.kind === "ok" ? "var(--text-secondary)" : "#f87171" }}
        >
          {notice.text}
        </div>
      )}
      {/* 已装插件列表 */}
      <div className="flex-1 min-h-0 overflow-auto space-y-2">
        {rows.length === 0 && (
          <div className="text-sm py-8 text-center" style={{ color: "var(--text-muted)" }}>
            尚未安装插件。前往「市场」tab 浏览安装。
          </div>
        )}
        {rows.map((p) => {
          const uses = p.manifest.uses ?? [];
          const sensitive = uses.filter((u) => isSensitiveCapability(u));
          const failed = p.phase === "failed";
          return (
            <div
              key={p.id}
              className="rounded border p-3"
              style={{ borderColor: "var(--border)", background: "var(--bg-primary)" }}
            >
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate" style={{ color: "var(--text-primary)" }}>
                      {p.manifest.name}
                    </span>
                    {failed && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "#f87171", background: "rgba(248,113,113,0.1)" }}>
                        加载失败
                      </span>
                    )}
                    {p.blocked && (
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded"
                        title={p.blocked}
                        style={{ color: "#f87171", background: "rgba(248,113,113,0.1)" }}
                      >
                        已被官方下架
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] truncate" style={{ color: "var(--text-muted)" }}>
                    {p.id} · {PLUGIN_TYPE_LABELS[p.manifest.type]} · {PLUGIN_SCOPE_LABELS[p.scope]} · v{p.manifest.version}
                  </div>
                </div>
                <ToggleSwitch
                  checked={p.enabled}
                  onChange={(on) => void setEnabled(p.id, on)}
                  title={p.enabled ? "停用" : "启用"}
                />
                <button
                  onClick={() => void update(p.id).catch(() => setNotice({ kind: "error", text: "更新失败" }))}
                  title="更新"
                  className="p-1.5 rounded hover:bg-[var(--hover)]"
                  style={{ color: "var(--text-muted)" }}
                >
                  <RefreshCw size={14} />
                </button>
                <button
                  onClick={() => setConfirmUninstall(p.id)}
                  title="卸载"
                  className="p-1.5 rounded hover:bg-[var(--hover)]"
                  style={{ color: "var(--text-muted)" }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              {failed && p.error && (
                <div className="mt-1.5 text-[11px] break-words" style={{ color: "#f87171" }}>
                  {p.error}
                </div>
              )}
              {uses.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {uses.map((u) => (
                    <span
                      key={u}
                      className="text-[10px] px-1.5 py-0.5 rounded border"
                      title={PLUGIN_CAPABILITY_LABELS[u] ?? u}
                      style={{
                        color: sensitive.includes(u) ? "#f59e0b" : "var(--text-secondary)",
                        borderColor: "var(--border)",
                        background: sensitive.includes(u) ? "rgba(245,158,11,0.1)" : "transparent",
                      }}
                    >
                      {PLUGIN_CAPABILITY_LABELS[u] ?? u}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {confirmUninstall && (
        <ConfirmDialog
          title={`卸载插件「${plugins[confirmUninstall]?.manifest.name ?? confirmUninstall}」`}
          description="将删除插件目录与本地状态，插件贡献的功能随即移除。此操作不可撤销。"
          confirmText="卸载"
          onConfirm={() => {
            const id = confirmUninstall;
            setConfirmUninstall(null);
            void uninstall(id).catch(() => setNotice({ kind: "error", text: "卸载失败" }));
          }}
          onCancel={() => setConfirmUninstall(null)}
        />
      )}
        </>
      )}
    </section>
  );
}
