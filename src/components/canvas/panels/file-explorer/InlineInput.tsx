/** 行内编辑输入框（重命名 / 新建草稿共用）：Enter 提交、Esc 取消、失焦提交（挂载自动聚焦）。 */
export function InlineInput({
  value,
  onChange,
  onCommit,
  onCancel,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  placeholder?: string;
}) {
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit();
        if (e.key === "Escape") onCancel();
      }}
      placeholder={placeholder}
      className="flex-1 bg-transparent border-b border-[var(--accent)] outline-none text-xs"
      style={{ color: "var(--text-primary)" }}
    />
  );
}
