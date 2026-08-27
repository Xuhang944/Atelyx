/** 设置项卡片（设置页统一样式基准）：左侧标题 + 描述，右侧控件。 */
export function SettingCard({
  title,
  description,
  children,
}: {
  title: string;
  description: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex items-center justify-between p-3 rounded-lg border gap-3"
      style={{
        background: "var(--bg-primary)",
        borderColor: "var(--border)",
      }}
    >
      <div className="min-w-0">
        <div
          className="text-sm font-medium"
          style={{ color: "var(--text-primary)" }}
        >
          {title}
        </div>
        <div className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
          {description}
        </div>
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}
