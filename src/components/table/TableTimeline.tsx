/**
 * 时间线视图 + 预演播放器。
 *
 * 字段驱动（无硬编码模式）：
 * - 取第一个 `duration` 字段决定卡片宽度（60px/秒，最短 120px）与播放时长；无该字段 → 等宽卡片 + 固定 3s/行
 * - 取第一个 `image` 字段供缩略图/大图；无图镜头显示首个 text 字段摘要文字卡片
 * - 点击卡片 = 跳选该行（与表格视图 `selectedRowId` 联动，停止播放）
 *
 * 预演：上方预览区（当前行大图/文字卡片）+ 控制条（播放/暂停/停止、当前时间/总时长）+
 * 时间轴（卡片流 + 刻度尺 + 播放头）。rAF 驱动播放头，纯前端零依赖；
 * 播放中当前卡片自动滚入视野；组件卸载（切视图/关窗）自动停止。
 */
import { Pause, Play, Square } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PREVIEW_DEFAULT_DURATION,
  TIMELINE_CARD_GAP,
  TIMELINE_EQUAL_CARD_WIDTH,
  TIMELINE_MIN_CARD_WIDTH,
  TIMELINE_PX_PER_SEC,
} from "@/constants/table";
import { useTableStore } from "@/stores/tableStore";
import { useCollabStore } from "@/stores/collabStore";
import { useTableImageSrc } from "@/hooks/useTableImageSrc";
import type { TableField, TableRow } from "@/types";

/** 时间线卡片缩略图：条目路径经 useTableImageSrc 解析（加载中/失败显示文字摘要兜底）。 */
function CardThumb({ entry, summary }: { entry: string | undefined; summary: string }) {
  const src = useTableImageSrc(entry ?? "");
  if (!src) {
    return (
      <div
        className="w-full h-full p-1.5 text-[10px] leading-4 overflow-hidden whitespace-pre-wrap break-words"
        style={{ color: "var(--text-muted)" }}
      >
        {summary || "…"}
      </div>
    );
  }
  return <img src={src} alt="" className="w-full h-full object-cover" draggable={false} />;
}

/**
 * 时间线卡片流：memo 隔离——播放中 playhead 不参与 props，仅换行（shotIndex 变化）时重渲染，
 * 其余帧浅比较全等整体跳过（消除播放时每帧全表重建卡片的掉帧主因）。
 */
const TimelineCards = memo(function TimelineCards({
  rows,
  selectedRowId,
  shotIndex,
  durations,
  hasDurationField,
  imageField,
  textField,
  peerColorByRowId,
  onJump,
}: {
  rows: TableRow[];
  selectedRowId: string | null;
  shotIndex: number;
  durations: number[];
  hasDurationField: boolean;
  imageField?: TableField;
  textField?: TableField;
  peerColorByRowId: ReadonlyMap<string, string>;
  onJump: (index: number) => void;
}) {
  return (
    <>
      {rows.map((row, i) => {
        const isSelected = row.id === selectedRowId;
        const isCurrent = i === shotIndex;
        const images =
          imageField && Array.isArray(row.values[imageField.id]) ? (row.values[imageField.id] as string[]) : [];
        const summary =
          textField && typeof row.values[textField.id] === "string" ? (row.values[textField.id] as string) : "";
        return (
          <div
            key={row.id}
            data-row-id={row.id}
            data-shot-id={i}
            onClick={() => onJump(i)}
            className="flex flex-col rounded cursor-pointer overflow-hidden flex-shrink-0 transition-colors"
            style={{
              width: cardWidthAt(durations[i], hasDurationField),
              border: `1px solid ${isCurrent ? "var(--accent)" : peerColorByRowId.get(row.id) ?? "var(--border)"}`,
              background: isSelected ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "var(--bg-secondary)",
              outline: isCurrent ? "1px solid var(--accent)" : undefined,
            }}
            title={`行 ${i + 1} · ${durations[i]} 秒`}
          >
            <div className="h-20 overflow-hidden flex items-center justify-center" style={{ background: "var(--bg-tertiary)" }}>
              {images.length > 0 ? (
                <CardThumb entry={images[0]} summary={summary} />
              ) : (
                <div
                  className="w-full h-full p-1.5 text-[10px] leading-4 overflow-hidden whitespace-pre-wrap break-words"
                  style={{ color: "var(--text-muted)" }}
                >
                  {summary || `行 ${i + 1}`}
                </div>
              )}
            </div>
            <div className="flex items-center justify-between px-1.5 py-1 text-[10px]" style={{ color: "var(--text-muted)" }}>
              <span>{i + 1}</span>
              <span>{durations[i]}s</span>
            </div>
          </div>
        );
      })}
    </>
  );
});

/** 刻度尺：memo 隔离——播放中 totalDuration 不变则跳过每帧重建。 */
const TimelineRuler = memo(function TimelineRuler({ totalDuration }: { totalDuration: number }) {
  return (
    <div className="relative h-5">
      {Array.from({ length: Math.floor(totalDuration / 5) + 1 }, (_, k) => {
        const t = k * 5;
        return (
          <div key={t} className="absolute top-0 flex flex-col items-start" style={{ left: t * TIMELINE_PX_PER_SEC }}>
            <div className="w-px h-3" style={{ background: "var(--text-muted)", opacity: 0.5 }} />
            <span className="text-[9px] mt-0.5" style={{ color: "var(--text-muted)" }}>
              {t}s
            </span>
          </div>
        );
      })}
    </div>
  );
});

/** 预览区（当前行大图/文字卡片）：memo 隔离——播放中仅换行（currentRow 引用变化）时重渲染。 */
const TimelinePreview = memo(function TimelinePreview({
  currentRow,
  shotIndex,
  imageField,
  textField,
  coverSrc,
  durationSec,
}: {
  currentRow: TableRow;
  shotIndex: number;
  imageField?: TableField;
  textField?: TableField;
  coverSrc: string | null;
  durationSec: number;
}) {
  return (
    <div className="flex-1 min-h-0 flex items-center justify-center p-4 relative">
      <div className="flex flex-col items-center gap-2 max-w-full">
        {imageField && Array.isArray(currentRow.values[imageField.id]) && (currentRow.values[imageField.id] as string[]).length > 0 ? (
          coverSrc ? (
            <img
              src={coverSrc}
              alt={`行 ${shotIndex + 1}`}
              className="max-h-[55vh] max-w-full object-contain rounded shadow-lg"
              draggable={false}
            />
          ) : (
            <div
              className="w-72 aspect-video rounded flex items-center justify-center text-xs"
              style={{ background: "var(--bg-secondary)", color: "var(--text-muted)", border: "1px dashed var(--border)" }}
            >
              图片加载中…
            </div>
          )
        ) : textField && typeof currentRow.values[textField.id] === "string" && currentRow.values[textField.id] ? (
          <div
            className="max-w-xl max-h-[55vh] overflow-auto p-4 rounded whitespace-pre-wrap text-sm"
            style={{ background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border)" }}
          >
            {currentRow.values[textField.id] as string}
          </div>
        ) : (
          <div
            className="px-6 py-3 rounded text-sm"
            style={{ background: "var(--bg-secondary)", color: "var(--text-muted)", border: "1px dashed var(--border)" }}
          >
            行 {shotIndex + 1}（无图片与文本内容）
          </div>
        )}
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>
          行 {shotIndex + 1} · {durationSec} 秒
        </div>
      </div>
    </div>
  );
});

/** 播放头进度线：memo 小件——每帧仅自身重渲染（left 变化），不拖累卡片流/刻度尺/预览区。 */
const PlayheadLine = memo(function PlayheadLine({ left, visible }: { left: number; visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="absolute top-0 bottom-0 w-0.5 pointer-events-none z-10" style={{ left: 12 + left, background: "var(--accent)" }} />
  );
});

/** 单行播放时长：duration 字段值（>0 才有效），缺省 3s。 */
function rowDuration(row: TableRow, durationFieldId: string | undefined): number {
  if (!durationFieldId) return PREVIEW_DEFAULT_DURATION;
  const v = row.values[durationFieldId];
  return typeof v === "number" && v > 0 ? v : PREVIEW_DEFAULT_DURATION;
}

/** 卡片宽度：有时长字段 = max(时长×比例, 最短宽)；无 = 等宽。 */
function cardWidthAt(duration: number, hasDurationField: boolean): number {
  return hasDurationField
    ? Math.max(duration * TIMELINE_PX_PER_SEC, TIMELINE_MIN_CARD_WIDTH)
    : TIMELINE_EQUAL_CARD_WIDTH;
}

export function TableTimeline() {
  const rows = useTableStore((s) => s.rows);
  const fields = useTableStore((s) => s.fields);
  const selectedRowId = useTableStore((s) => s.selectedRowId);
  const selectRow = useTableStore((s) => s.selectRow);
  // 协作：同看本表格的在线用户（远端选中行 → 卡片边框用户色）
  const tableFile = useTableStore((s) => s.tableFile);
  const collabPeers = useCollabStore((s) => s.peers);
  // 协作远端选中行 → 用户色（按 rowId 预建 Map：播放每帧 O(1) 查询，不再每帧 collabPeers × rows 全量扫描；保留「首个匹配 peer 优先」语义）
  const peerColorByRowId = useMemo(() => {
    const map = new Map<string, string>();
    if (!tableFile) return map;
    for (const p of collabPeers) {
      const sel = p.presence?.selection;
      if (
        p.presence?.file === tableFile &&
        sel &&
        (sel.kind === "cell" || sel.kind === "row") &&
        !map.has(sel.rowId)
      ) {
        map.set(sel.rowId, p.color);
      }
    }
    return map;
  }, [collabPeers, tableFile]);

  const durationField = fields.find((f) => f.type === "duration");
  const imageField = fields.find((f) => f.type === "image");
  const textField = fields.find((f) => f.type === "text");

  const durations = useMemo(
    () => rows.map((r) => rowDuration(r, durationField?.id)),
    [rows, durationField],
  );
  const totalDuration = durations.reduce((a, b) => a + b, 0);
  const hasDurationField = !!durationField;
  const totalWidth =
    rows.reduce((acc, _r, i) => acc + cardWidthAt(durations[i], hasDurationField), 0) +
    Math.max(0, rows.length - 1) * TIMELINE_CARD_GAP;

  // ===== 播放状态：播放头 = 时间轴绝对秒数（暂停/跳镜天然成立）=====
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const playheadRef = useRef(0);
  const finished = rows.length > 0 && playhead >= totalDuration;

  /** 播放头所在行下标（累加时长二分/线性扫描；空表 = -1）。 */
  const shotIndex = useMemo(() => {
    if (rows.length === 0) return -1;
    let acc = 0;
    for (let i = 0; i < durations.length; i++) {
      acc += durations[i];
      if (playhead < acc) return i;
    }
    return durations.length - 1;
  }, [rows.length, durations, playhead]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      playheadRef.current += (now - last) / 1000;
      last = now;
      if (playheadRef.current >= totalDuration) {
        playheadRef.current = totalDuration;
        setPlayhead(totalDuration);
        setPlaying(false);
        return;
      }
      setPlayhead(playheadRef.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, totalDuration]);

  // 播放中当前卡片滚入视野（shotIndex 变化触发）
  const cardsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!playing || shotIndex < 0) return;
    const el = cardsRef.current?.querySelector<HTMLElement>(`[data-shot-id="${shotIndex}"]`);
    el?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [playing, shotIndex]);

  /** 各卡片起点时间（前缀和一次计算，播放头定位 / 跳选 / 进度条共用，防多次 slice+reduce）。 */
  const shotStarts = useMemo(() => {
    const starts: number[] = [];
    let acc = 0;
    for (const d of durations) {
      starts.push(acc);
      acc += d;
    }
    return starts;
  }, [durations]);

  // 播放头像素位置：累计前序卡片宽度 + 当前卡内比例
  const playheadPx = useMemo(() => {
    if (rows.length === 0 || shotIndex < 0) return 0;
    let acc = 0;
    for (let i = 0; i < shotIndex; i++) acc += cardWidthAt(durations[i], hasDurationField) + TIMELINE_CARD_GAP;
    const shotStart = shotStarts[shotIndex] ?? 0;
    const frac = durations[shotIndex] > 0 ? (playhead - shotStart) / durations[shotIndex] : 0;
    return acc + Math.min(1, Math.max(0, frac)) * cardWidthAt(durations[shotIndex], hasDurationField);
  }, [rows.length, shotIndex, durations, shotStarts, playhead, hasDurationField]);

  /** 跳选行：停止播放并定位到该行起点（与表格视图选中联动）。useCallback 稳定引用，防 onJump 每帧新引用击穿 TimelineCards 的 memo。 */
  const jumpTo = useCallback(
    (index: number) => {
      setPlaying(false);
      playheadRef.current = shotStarts[index] ?? 0;
      setPlayhead(playheadRef.current);
      selectRow(rows[index]?.id ?? null);
    },
    [shotStarts, rows, selectRow],
  );

  const formatTime = (t: number): string => {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  // 预览区大图条目（当前播放行首个 image）→ 显示 dataURL（路径经缓存解析；换行/换卡片自动重取）
  const coverEntry =
    shotIndex >= 0 && imageField
      ? (rows[shotIndex]?.values[imageField.id] as string[] | undefined)?.[0]
      : undefined;
  const coverSrc = useTableImageSrc(coverEntry ?? "");

  if (rows.length === 0) {
    return (
      <div className="h-full w-full flex items-center justify-center" style={{ background: "var(--bg-primary)" }}>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          暂无行数据，请先在表格视图添加行。
        </p>
      </div>
    );
  }

  const currentRow = rows[shotIndex];

  return (
    <div className="h-full flex flex-col" style={{ background: "var(--bg-primary)" }}>
      {/* 预览区：当前行大图（无图 → 文字卡片）；memo 隔离，播放中仅换行时重渲染 */}
      <TimelinePreview
        currentRow={currentRow}
        shotIndex={shotIndex}
        imageField={imageField}
        textField={textField}
        coverSrc={coverSrc}
        durationSec={durations[shotIndex]}
      />

      {/* 控制条 */}
      <div
        className="flex-shrink-0 flex items-center gap-3 px-3 py-1.5 border-t text-xs"
        style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
      >
        <button
          onClick={() => {
            if (finished) {
              // 播完 → 重播（从头）
              playheadRef.current = 0;
              setPlayhead(0);
              setPlaying(true);
            } else {
              setPlaying((v) => !v);
              if (!playing) playheadRef.current = playhead;
            }
          }}
          className="w-8 h-8 flex items-center justify-center rounded-full transition-colors"
          style={{ background: "color-mix(in srgb, var(--accent) 15%, transparent)", color: "var(--accent)" }}
          title={playing ? "暂停" : finished ? "重播" : "播放"}
        >
          {playing ? <Pause size={15} /> : <Play size={15} className="ml-0.5" />}
        </button>
        <button
          onClick={() => {
            setPlaying(false);
            playheadRef.current = 0;
            setPlayhead(0);
          }}
          className="w-7 h-7 flex items-center justify-center rounded hover:bg-[var(--hover)]"
          style={{ color: "var(--text-secondary)" }}
          title="停止（回到开头）"
        >
          <Square size={13} />
        </button>
        <span className="font-mono">
          {formatTime(playhead)} / {formatTime(totalDuration)}
        </span>
      </div>

      {/* 时间轴：刻度尺 + 卡片流 + 播放头 */}
      <div className="flex-shrink-0 border-t overflow-x-auto" style={{ borderColor: "var(--border)" }}>
        <div className="relative" style={{ width: totalWidth + 24, padding: "0 12px 10px" }}>
          {/* 刻度尺（仅有时长字段显示；memo 隔离，播放中跳过重建） */}
          {durationField && <TimelineRuler totalDuration={totalDuration} />}
          {/* 卡片流（memo 隔离，播放中仅换行时重渲染） */}
          <div ref={cardsRef} className="flex items-stretch" style={{ gap: TIMELINE_CARD_GAP }}>
            <TimelineCards
              rows={rows}
              selectedRowId={selectedRowId}
              shotIndex={shotIndex}
              durations={durations}
              hasDurationField={hasDurationField}
              imageField={imageField}
              textField={textField}
              peerColorByRowId={peerColorByRowId}
              onJump={jumpTo}
            />
          </div>
          {/* 播放头（进度线；memo 小件，每帧仅自身重渲染） */}
          <PlayheadLine left={playheadPx} visible={playing} />
        </div>
      </div>
    </div>
  );
}
