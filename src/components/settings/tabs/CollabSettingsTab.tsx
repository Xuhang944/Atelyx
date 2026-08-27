import { RotateCcw } from "lucide-react";
import { ToggleSwitch } from "@/components/common/ToggleSwitch";
import { SettingCard } from "@/components/settings/SettingCard";
import { randomPeerColor, type RelayTestResult } from "@/stores/collabStore";

/** 协作配置补丁（与 settingsStore.setCollabConfig 的结构兼容）。 */
type CollabConfigPatch = Partial<{
  collabEnabled: boolean;
  collabRelayUrl: string;
  collabNickname: string;
  collabColor: string;
}>;

interface Props {
  collabEnabled: boolean;
  setCollabConfig: (patch: CollabConfigPatch) => Promise<void>;
  collabConnected: boolean;
  runConnectionTest: () => Promise<void>;
  testing: boolean;
  testResult: RelayTestResult | null;
  relayUrlDraft: string;
  setRelayUrlDraft: (v: string) => void;
  commitRelayUrl: () => void;
  collabNicknameDraft: string;
  setCollabNicknameDraft: (v: string) => void;
  commitCollabNickname: () => void;
  collabColorDraft: string;
  commitCollabColorDraft: (v: string) => void;
}

/** 多人协作面板（应用级）：局域网中转——同仓库在线成员经 relay 实时互见（presence）。 */
export function CollabSettingsTab({
  collabEnabled,
  setCollabConfig,
  collabConnected,
  runConnectionTest,
  testing,
  testResult,
  relayUrlDraft,
  setRelayUrlDraft,
  commitRelayUrl,
  collabNicknameDraft,
  setCollabNicknameDraft,
  commitCollabNickname,
  collabColorDraft,
  commitCollabColorDraft,
}: Props) {
  return (
    <section className="flex-1 p-5 overflow-auto space-y-4">
      {/* 开关：开启即连接（地址/身份变化即时重建连接） */}
      <SettingCard
        title="多人协作"
        description="局域网内同仓库成员实时互见（选中高亮）"
      >
        <div className="flex items-center gap-3">
          <ToggleSwitch
            checked={collabEnabled}
            onChange={(v) => void setCollabConfig({ collabEnabled: v })}
            title="多人协作"
          />
          {collabEnabled && (
            <span
              className="flex items-center gap-1.5 text-xs"
              style={{ color: collabConnected ? "#22c55e" : "var(--text-muted)" }}
            >
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: collabConnected ? "#22c55e" : "var(--text-muted)" }}
              />
              {collabConnected ? "已连接" : "未连接"}
            </span>
          )}
        </div>
      </SettingCard>

      {/* 中转地址 + 检查连接：地址模糊可补全（只输 host:port）；检查 = 独立连接发探测 hello，
          收到 hello-ack 判成功（不影响常驻连接；未开启协作也可先测） */}
      <SettingCard
        title="中转地址"
        description="中转服务地址，多人须指向同一中转"
      >
        <div className="flex flex-col items-start gap-1.5 w-[340px]">
          <div className="flex items-center gap-2 w-full">
            <input
              value={relayUrlDraft}
              onChange={(e) => setRelayUrlDraft(e.target.value)}
              onBlur={commitRelayUrl}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              placeholder="192.168.1.10:17701"
              className="text-sm rounded px-2 py-1 outline-none flex-1 min-w-0"
              style={{
                color: "var(--text-primary)",
                background: "var(--input-bg)",
                border: "1px solid var(--input-border)",
              }}
            />
            <button
              onClick={runConnectionTest}
              disabled={testing}
              title="连接中转服务测试连通性"
              className="px-2.5 py-1 text-xs rounded border flex-shrink-0 hover:opacity-80 disabled:opacity-50"
              style={{
                borderColor: "var(--border)",
                color: "var(--text-secondary)",
              }}
            >
              {testing ? "检查中…" : "检查连接"}
            </button>
          </div>
          {testResult && (
            <span
              className="text-xs"
              style={{ color: testResult.ok ? "#22c55e" : "#f87171" }}
            >
              {testResult.message}
            </span>
          )}
        </div>
      </SettingCard>

      {/* 身份：昵称 = 在线列表展示名；颜色 = 远端选中高亮描边色 */}
      <SettingCard
        title="昵称与颜色"
        description="空昵称 = 设备名；空颜色 = 随机分配"
      >
        <div className="flex items-center gap-2">
          <input
            value={collabNicknameDraft}
            onChange={(e) => setCollabNicknameDraft(e.target.value)}
            onBlur={commitCollabNickname}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            placeholder="设备名"
            className="text-sm rounded px-2 py-1 outline-none max-w-[140px]"
            style={{
              color: "var(--text-primary)",
              background: "var(--input-bg)",
              border: "1px solid var(--input-border)",
            }}
          />
          <input
            type="color"
            value={collabColorDraft}
            onChange={(e) => commitCollabColorDraft(e.target.value)}
            title="身份颜色"
            className="w-6 h-6 rounded cursor-pointer bg-transparent p-0 border-0"
          />
          <button
            onClick={() => {
              // 随机 = 提交一个新随机色存显式值（重启不变）；空色仅作未配置时的启动随机兜底
              commitCollabColorDraft(randomPeerColor());
            }}
            title="随机换色"
            className="flex items-center gap-1 text-xs rounded px-1.5 py-1 hover:bg-[var(--hover)] flex-shrink-0"
            style={{ color: "var(--text-secondary)" }}
          >
            <RotateCcw size={12} />
            随机
          </button>
        </div>
      </SettingCard>
    </section>
  );
}
