import { SettingCard } from "@/components/settings/SettingCard";

interface Props {
  excludeDraft: string;
  setExcludeDraft: (v: string) => void;
  commitExcludeFolders: () => void;
  attachmentDraft: string;
  setAttachmentDraft: (v: string) => void;
  commitAttachmentFolder: () => void;
}

/** 文件与路径面板（仓库级）。 */
export function FilesSettingsTab({
  excludeDraft,
  setExcludeDraft,
  commitExcludeFolders,
  attachmentDraft,
  setAttachmentDraft,
  commitAttachmentFolder,
}: Props) {
  return (
    <section className="flex-1 p-5 overflow-auto space-y-4">
      {/* 排除文件夹：逗号分隔；不显示在文件面板、不参与监听 */}
      <SettingCard
        title="排除文件夹"
        description="不显示在文件面板、不参与监听；修改后重开仓库生效"
      >
        <input
          value={excludeDraft}
          onChange={(e) => setExcludeDraft(e.target.value)}
          onBlur={commitExcludeFolders}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          placeholder="如：Archive, templates"
          className="w-[260px] text-sm rounded px-2 py-1 outline-none focus:ring-1 focus:ring-[var(--accent)]"
          style={{
            color: "var(--text-secondary)",
            background: "var(--input-bg)",
            border: "1px solid var(--input-border)",
          }}
        />
      </SettingCard>
      {/* 附件文件夹：粘贴 / 拖入的附件导入到此文件夹（留空 = 根目录） */}
      <SettingCard
        title="附件文件夹"
        description="粘贴 / 拖入的附件导入到此文件夹；修改后重开仓库生效"
      >
        <input
          value={attachmentDraft}
          onChange={(e) => setAttachmentDraft(e.target.value)}
          onBlur={commitAttachmentFolder}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          placeholder="如：assets 或 素材/图片"
          className="w-[260px] text-sm rounded px-2 py-1 outline-none focus:ring-1 focus:ring-[var(--accent)]"
          style={{
            color: "var(--text-secondary)",
            background: "var(--input-bg)",
            border: "1px solid var(--input-border)",
          }}
        />
      </SettingCard>
    </section>
  );
}
