/**
 * 最左侧功能栏（Activity Bar）。
 * 垂直图标列 = 核心功能入口：「文件」切换左栏文件面板；「搜索」切换左栏搜索面板；
 * 「AI 对话」开启右侧边栏 AI 对话面板；其余未实现禁用。底部固定：设置齿轮 + 帮助问号。
 */
import type { ReactNode } from "react";
import {
  Clock,
  Database,
  Files,
  HelpCircle,
  Image,
  MoreVertical,
  PanelsTopLeft,
  Search,
  Settings,
  Sparkles,
} from "lucide-react";

interface ActivityBarProps {
  /** 文件面板是否可见（「文件」图标高亮态） */
  filesActive: boolean;
  onToggleFiles: () => void;
  /** 搜索面板是否可见（「搜索」图标高亮态） */
  searchActive: boolean;
  onToggleSearch: () => void;
  /** 右侧边栏 AI 对话 tab 是否激活（「AI 对话」图标高亮态） */
  aiActive: boolean;
  onOpenAiChat: () => void;
  onOpenSettings: () => void;
}

export function ActivityBar({ filesActive, onToggleFiles, searchActive, onToggleSearch, aiActive, onOpenAiChat, onOpenSettings }: ActivityBarProps) {
  return (
    <div
      className="w-12 h-full flex flex-col items-center py-3 gap-1 flex-shrink-0"
      style={{ background: "var(--bg-secondary)", borderRight: "1px solid var(--border)" }}
    >
      <IconButton
        icon={<Files size={19} />}
        title="文件管理"
        active={filesActive}
        onClick={onToggleFiles}
      />
      <IconButton
        icon={<Search size={19} />}
        title="搜索"
        active={searchActive}
        onClick={onToggleSearch}
      />
      <IconButton
        icon={<Sparkles size={19} />}
        title="AI 对话"
        active={aiActive}
        onClick={onOpenAiChat}
      />
      <IconButton icon={<PanelsTopLeft size={19} />} title="白板（尚未支持）" disabled />
      <IconButton icon={<Clock size={19} />} title="时间线（尚未支持）" disabled />
      <IconButton icon={<Database size={19} />} title="数据库（尚未支持）" disabled />
      <IconButton icon={<Image size={19} />} title="媒体库（尚未支持）" disabled />
      <IconButton icon={<MoreVertical size={19} />} title="更多（尚未支持）" disabled />

      <div className="flex-1" />
      <IconButton icon={<Settings size={19} />} title="设置" onClick={onOpenSettings} />
      <IconButton icon={<HelpCircle size={19} />} title="帮助" disabled />
    </div>
  );
}

function IconButton({
  icon,
  title,
  active,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className="w-9 h-9 rounded-lg flex items-center justify-center disabled:cursor-not-allowed"
      style={{
        color: active ? "var(--accent)" : disabled ? "var(--text-muted)" : "var(--text-secondary)",
        background: active ? "rgba(212,175,55,0.2)" : undefined,
      }}
    >
      {icon}
    </button>
  );
}
