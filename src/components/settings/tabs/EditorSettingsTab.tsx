import { ToggleSwitch } from "@/components/common/ToggleSwitch";
import { SettingCard } from "@/components/settings/SettingCard";

interface Props {
  softLineBreak: boolean;
  setSoftLineBreak: (v: boolean) => Promise<void>;
  rebuilding: boolean;
  rebuildState: { message: string; error?: string } | null;
  setRebuildConfirm: (v: boolean) => void;
}

/** 编辑器面板（仓库级）。 */
export function EditorSettingsTab({
  softLineBreak,
  setSoftLineBreak,
  rebuilding,
  rebuildState,
  setRebuildConfirm,
}: Props) {
  return (
    <section className="flex-1 p-5 overflow-auto space-y-4">
      {/* 宽松换行：仅渲染层生效，编辑模式始终原文 */}
      <SettingCard
        title="宽松换行"
        description="单个换行显示为换行；关闭 = 按 Markdown 标准需空行换行"
      >
        <ToggleSwitch
          checked={softLineBreak}
          onChange={(v) => void setSoftLineBreak(v)}
          title="宽松换行"
        />
      </SettingCard>

      {/* 内部链接：一键重建为标准 Markdown 写法（批量改写，需确认） */}
      <SettingCard
        title="内部链接"
        description={
          <span>
            一键统一全仓库笔记的链接为标准 Markdown 写法；批量改写不可撤销。
            {rebuilding && <span className="block mt-1">重建中…</span>}
            {rebuildState && (
              <span
                className="block mt-1"
                style={{
                  color: rebuildState.error ? "#f87171" : undefined,
                }}
              >
                {rebuildState.error ?? rebuildState.message}
              </span>
            )}
          </span>
        }
      >
        <button
          className="px-3 py-1.5 text-xs rounded border flex-shrink-0 hover:opacity-80 disabled:opacity-50"
          style={{
            borderColor: "#f87171",
            color: "#f87171",
          }}
          disabled={rebuilding}
          onClick={() => setRebuildConfirm(true)}
          title="批量改写仓库内全部 .md 的链接写法"
        >
          重建内部链接
        </button>
      </SettingCard>
    </section>
  );
}
