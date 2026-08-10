/**
 * 无画布时的 `.md` 笔记编辑器（未打开画布时单击笔记打开）。
 *
 * 占据主编辑区（画布位置）：顶部文件名 + 保存状态条，正文 textarea。
 * - 加载：进入时读笔记正文（切换笔记重读）；加载完成前用户已输入则保留输入（不覆盖正在打的字）。
 * - 保存：输入 debounce 500ms 自动写回 `.md`；卸载/切走时 flush 未落盘输入（不静默丢弃）；
 *   写入完成时若已有更新输入则保持「保存中…」，避免误报「已自动保存」。
 * - 分层：走 vaultStore（readNoteContent / saveNoteContent），不直调 service。
 */
import { Check, MoreHorizontal, Pencil } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { useVaultStore, lastFolderRenameTarget, lastNoteRenameTarget } from "@/stores/vaultStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useAppStore } from "@/stores/appStore";
import type { BacklinkRow } from "@/types";
import {
  MARKDOWN_PLUGINS,
  REHYPE_PLUGINS,
  markdownComponents,
  remarkSoftLineBreak,
} from "@/utils/markdown";
import { parseFrontmatter, stringifyFrontmatter } from "@/utils/frontmatter";
import { noteTitleFromFile } from "@/utils/filename";
import { NotePropertiesView } from "@/components/editor/NotePropertiesView";
import { MarkdownEditor } from "@/components/editor/MarkdownEditor";
import { useVaultLinkHandlers } from "@/hooks/useVaultLinkHandlers";

type SaveState = "idle" | "saving" | "saved" | "error";

export function NoteEditor({ file }: { file: string }) {
  const readNoteContent = useVaultStore((s) => s.readNoteContent);
  const saveNoteContent = useVaultStore((s) => s.saveNoteContent);
  // 外部修改感知：watcher note 事件 bump 序号（vaultStore.markNoteExternallyEdited），据此重读磁盘
  const externalEditSeq = useVaultStore((s) => s.externalNoteEdits[file] ?? 0);
  const [content, setContent] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [loadError, setLoadError] = useState(false);
  /** 编辑 / 预览切换（默认预览：打开即渲染；双击预览内容切回编辑；标题栏已显示文件名故顶部条不再重复）。 */
  const [preview, setPreview] = useState(true);
  /** 源码模式：编辑区显示完整 Markdown 源码 textarea；不勾选 = 实时预览编辑（CodeMirror）。 */
  const [sourceMode, setSourceMode] = useState(false);
  /** 右上角「···」浮层菜单开关。 */
  const [showMenu, setShowMenu] = useState(false);
  /** 非用户编辑的 content 更新序号（加载完成/外部刷新/冲突重载时递增），MarkdownEditor 据此同步正文。 */
  const [editorSyncSeq, setEditorSyncSeq] = useState(0);
  /** 外部修改冲突：本地有未保存改动 + 磁盘已被外部改过。提示用户选择，期间暂停自动保存防覆盖。 */
  const [conflict, setConflict] = useState(false);
  const conflictRef = useRef(false);
  const setConflictState = (v: boolean) => {
    conflictRef.current = v;
    setConflict(v);
  };
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 最新输入（卸载时 flush 用，避免闭包拿到过期内容）。 */
  const contentRef = useRef("");
  /** 加载完成前用户是否已输入：输入优先，加载结果不覆盖正在打的字。 */
  const dirtyRef = useRef(false);
  /** 最后成功写盘的磁盘内容基准：外部修改感知据此区分「自写回放」与「真实外部变化」。 */
  const lastSavedRef = useRef("");
  /** 外部修改感知已处理到的序号（挂载时 = 当前值：加载 useEffect 已读到最新磁盘，只响应后续增量）。 */
  const processedSeqRef = useRef(externalEditSeq);
  /** 保存序号：写入完成时若已有更新的输入，保持「保存中…」而非误报「已自动保存」。 */
  const saveSeqRef = useRef(0);
  /** 卸载守卫：异步保存完成回调不再 setState（React 18 虽静默但属脏更新）。 */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** 编辑器根节点引用：点击编辑器外部 → 取消编辑模式（回渲染预览）。 */
  const editorRootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      const root = editorRootRef.current;
      // 编辑器内部（内容区/属性区/浮层菜单均挂在根节点内）不退出；preview 已是 true 时幂等无副作用
      if (root && !root.contains(e.target as Node)) setPreview(true);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, []);

  // 加载正文；切换笔记（file 变化）重新读取
  useEffect(() => {
    let cancelled = false;
    // 加载起始的序号快照：加载期间外部修改（序号移动）则丢弃本次结果，避免旧内容覆盖新磁盘
    const seqAtLoad = useVaultStore.getState().externalNoteEdits[file] ?? 0;
    setContent("");
    // 编辑模式：清空编辑器（防加载窗口内旧笔记内容被误写到新文件，见 MarkdownEditor 同步机制）
    setEditorSyncSeq((s) => s + 1);
    setSaveState("idle");
    setLoadError(false);
    dirtyRef.current = false;
    void readNoteContent(file)
      .then((c) => {
        if (cancelled) return;
        // 加载期间外部已修改（序号移动）：放弃本次加载结果，外部感知 useEffect 会刷新（防旧内容覆盖新磁盘）
        if ((useVaultStore.getState().externalNoteEdits[file] ?? 0) !== seqAtLoad) return;
        // 基准 = 磁盘最新（即使输入优先不覆盖内容，后续自写回放/外部修改感知也以它为参照）
        lastSavedRef.current = c;
        if (!dirtyRef.current) {
          setContent(c);
          // 编辑模式：加载完成同步编辑器（仅正文，frontmatter 不动）
          setEditorSyncSeq((s) => s + 1);
        }
      })
      .catch(() => {
        // 加载失败：若用户已输入（dirty），输入会随 debounce 写盘，保留编辑界面而非换错误页
        if (!cancelled && !dirtyRef.current) setLoadError(true);
      });
    return () => {
      cancelled = true;
      // 卸载/切走：flush 未落盘的输入（debounce 窗口内不静默丢弃）。
      // 组件已卸载不能再 setState，fire-and-forget 写盘即可。
      // 冲突未决时跳过：外部已修改且未明确选择，不覆盖外部修改（提示条已告知）
      if (conflictRef.current) return;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        // 文件已从仓库列表消失：软件内重命名（写到新文件）或真删除（跳过，防 writeNote 重建已删文件）
        const stillExists = useVaultStore
          .getState()
          .noteList.some((n) => n.file === file);
        const target =
          stillExists ? file : lastNoteRenameTarget(file) ?? lastFolderRenameTarget(file);
        if (target) {
          void saveNoteContent(target, contentRef.current).catch((e) =>
            console.error("笔记保存失败", e)
          );
        }
      }
    };
  }, [file, readNoteContent, saveNoteContent]);

  // 外部修改感知：磁盘内容 ≠ 最后写盘基准 = 真实外部变化（自写回放磁盘 = 基准，天然跳过）。
  // 无本地改动 → 静默刷新为磁盘最新（实时同步）；有本地改动 → 冲突提示 + 暂停自动保存，防覆盖外部修改
  useEffect(() => {
    if (externalEditSeq <= processedSeqRef.current) return;
    processedSeqRef.current = externalEditSeq;
    let cancelled = false;
    void readNoteContent(file)
      .then((disk) => {
        if (cancelled || !mountedRef.current || disk === lastSavedRef.current) return;
        if (dirtyRef.current) {
          // 取消挂起的 debounce 保存（外部修改前已调度），防到点写盘覆盖外部修改
          if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
          }
          setConflictState(true);
        } else {
          setContent(disk);
          contentRef.current = disk;
          lastSavedRef.current = disk;
          setSaveState("idle");
          // 编辑模式：外部静默刷新同步编辑器
          setEditorSyncSeq((s) => s + 1);
        }
      })
      .catch(() => {
        // 外部删除由窗口联动（loadFiles 后不在列表关闭，此处忽略
      });
    return () => {
      cancelled = true;
    };
  }, [externalEditSeq, file, readNoteContent]);

  /** 冲突「重新加载」：丢弃本地改动，恢复磁盘最新内容并解除冲突。 */
  const reloadFromDisk = () => {
    void readNoteContent(file)
      .then((disk) => {
        if (!mountedRef.current) return;
        setContent(disk);
        contentRef.current = disk;
        lastSavedRef.current = disk;
        dirtyRef.current = false;
        setConflictState(false);
        setSaveState("idle");
        // 编辑模式：冲突「重新加载」同步编辑器
        setEditorSyncSeq((s) => s + 1);
      })
      .catch(() => {});
  };

  /** 冲突「保留本地并保存」：用户明确选择用本地内容覆盖外部修改。 */
  const saveLocalOverExternal = () => {
    const v = contentRef.current;
    setConflictState(false);
    const seq = ++saveSeqRef.current;
    void saveNoteContent(file, v)
      .then(() => {
        lastSavedRef.current = v;
        // 保存期间又输入了（新 seq 已接管）：dirty 保持 true，防后续外部修改静默覆盖正在打的字
        if (seq === saveSeqRef.current) dirtyRef.current = false;
        if (mountedRef.current && seq === saveSeqRef.current) setSaveState("saved");
      })
      .catch(() => {
        if (mountedRef.current) setSaveState("error");
      });
  };

  const handleChange = (v: string) => {
    dirtyRef.current = true;
    contentRef.current = v;
    setContent(v);
    // 冲突中：仅更新本地内容，暂停自动保存（等用户选「重新加载」或「保留本地并保存」，防静默覆盖外部修改）
    if (conflictRef.current) return;
    setSaveState("saving");
    if (timerRef.current) clearTimeout(timerRef.current);
    const seq = ++saveSeqRef.current;
    timerRef.current = setTimeout(() => {
      // 写盘前校验磁盘基准：期间磁盘已被外部改动（disk ≠ lastSavedRef）则放弃本次写盘并转冲突提示，
      // 防 debounce 到点把外部修改覆盖掉（自写回放磁盘 = lastSavedRef，不受影响）
      void readNoteContent(file)
        .then((disk) => {
          if (!mountedRef.current || seq !== saveSeqRef.current) return;
          if (disk !== lastSavedRef.current) {
            setConflictState(true);
            return;
          }
          void saveNoteContent(file, v)
            .then(() => {
              lastSavedRef.current = v;
              // 保存完成且无新输入：无未保存改动（dirtyRef 重置，后续外部修改恢复静默刷新语义）
              if (seq === saveSeqRef.current) dirtyRef.current = false;
              // 期间又有新输入（新定时器已接管）→ 不显示「已自动保存」；组件已卸载不再 setState
              if (mountedRef.current && seq === saveSeqRef.current) setSaveState("saved");
            })
            .catch(() => {
              if (mountedRef.current) setSaveState("error");
            });
        })
        .catch(() => {
          // 写盘前读磁盘失败：文件可能已被外部删除，放弃写盘（不覆盖不重建），提示保存失败
          if (mountedRef.current && seq === saveSeqRef.current) setSaveState("error");
        });
    }, 500);
  };

  /** Frontmatter 解析：content 变（输入/外部刷新）→ 面板数据即时重解析，形成「编辑/外部修改即刷新」闭环。 */
  const parsed = useMemo(() => parseFrontmatter(content), [content]);

  /** 宽松换行（仓库级设置，缺省开启）：开启时预览注入软换行→<br> 插件。
   * useMemo 稳定数组引用，避免无关渲染触发 ReactMarkdown 重建 processor。 */
  const softLineBreak = useSettingsStore((s) => s.vaultConfig?.softLineBreak ?? true);
  const previewPlugins = useMemo(
    () => (softLineBreak ? [...MARKDOWN_PLUGINS, remarkSoftLineBreak] : MARKDOWN_PLUGINS),
    [softLineBreak]
  );

  /** 面板编辑提交：新 data 拼回完整 content，走既有 handleChange（debounce 保存/冲突条/外部感知全复用，零新机制）。 */
  const handlePropertiesUpdate = (next: Record<string, unknown>) => {
    try {
      handleChange(stringifyFrontmatter(next, parsed.body));
    } catch (e) {
      // stringify 异常（不应发生）：不污染 content，记录日志便于排查（诊断）
      console.error("[frontmatter] stringify error:", e, next);
    }
  };

  /** 笔记链接打开/新建（公共接线簇，见 hooks/useVaultLinkHandlers；本编辑器不做画布定位）。 */
  const { handleOpenWikiNote, isVaultPathNote, handleOpenVaultPathNote, handleCreateNote } =
    useVaultLinkHandlers();

  /** 反链：全仓库 .md 中引用本文档的笔记（自身排除）；索引缓存 + 指纹增量刷新，扫描开销毫秒级。
   * 只在「切换打开的笔记」时扫描——不随仓库文件变化重扫（根除全量风暴），磁盘为真相自愈。
   * 扫描失败静默降级留空，不阻塞编辑。 */
  const noteName = noteTitleFromFile(file);
  const [backlinks, setBacklinks] = useState<BacklinkRow[]>([]);
  useEffect(() => {
    if (!noteName) return;
    let cancelled = false;
    setBacklinks([]);
    void useVaultStore
      .getState()
      .scanWikiBacklinks(noteName, file)
      .then((rows) => {
        if (!cancelled) setBacklinks(rows.filter((r) => r.file !== file));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [file, noteName]);

  /** 「添加笔记属性」= 一键插入 frontmatter 格式模板（`---\n---\n` 包裹区），用户自行填写；
   * 已有 frontmatter 或格式错误时不重复插入。CRLF 文件用 \r\n 模板，防换行混用。 */
  const addFrontmatterTemplate = () => {
    if (!parsed.ok || parsed.fmPrefix !== "") return;
    const eol = content.includes("\r\n") ? "\r\n" : "\n";
    handleChange("---" + eol + "---" + eol + eol + content);
  };

  return (
    <div ref={editorRootRef} className="h-full flex flex-col" style={{ background: "var(--bg-primary)" }}>
      {/* 顶部条：左侧保存状态（文件名由标题栏窗口标签显示）+ 右侧编辑/预览切换 */}
      <div
        className="px-3 py-1 flex items-center gap-1.5 text-xs flex-shrink-0 select-none"
        style={{ borderBottom: "1px solid var(--border)", color: "var(--text-muted)" }}
      >
        <span
          className="flex-shrink-0 truncate"
          style={{ color: saveState === "error" ? "#f87171" : "var(--text-muted)" }}
        >
          {loadError
            ? "读取失败"
            : saveState === "saving"
              ? "保存中…"
              : saveState === "error"
                ? "保存失败"
                : saveState === "saved"
                  ? "已自动保存"
                  : ""}
        </span>
        <span className="ml-auto flex items-center gap-2 flex-shrink-0">
          {/* 预览模式提示：显示在切换按钮左侧 */}
          {preview && (
            <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              双击内容进入编辑模式
            </span>
          )}
          {/* 固定笔图标：未进入编辑（预览态）淡色，进入编辑后金色高亮（表达激活态） */}
          <button
            onClick={() => setPreview((v) => !v)}
            title={preview ? "切换到编辑" : "切换到只读"}
            className="p-0.5 rounded hover:opacity-80"
            style={{ color: preview ? "var(--text-muted)" : "var(--accent)" }}
          >
            <Pencil size={14} />
          </button>
          {/* 「···」更多选项：笔记属性面板入口 */}
          <span className="relative flex-shrink-0">
            <button
              onClick={() => setShowMenu((v) => !v)}
              title="更多选项"
              className="p-0.5 rounded hover:opacity-80"
              style={{ color: showMenu ? "var(--accent)" : "var(--text-muted)" }}
            >
              <MoreHorizontal size={15} />
            </button>
            {showMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
                <div
                  className="absolute right-0 top-full mt-0.5 z-50 border rounded shadow-lg py-1 w-36"
                  style={{ background: "var(--bg-secondary)", borderColor: "var(--border)" }}
                >
                  <button
                    className="w-full flex items-center gap-2 px-2 py-1.5 text-xs hover:opacity-80"
                    style={{ color: "var(--text-primary)" }}
                    onClick={() => {
                      addFrontmatterTemplate();
                      setShowMenu(false);
                    }}
                    title="在内容顶部插入 frontmatter 格式模板（---\\n---\\n），自行填写属性"
                  >
                    {/* 图标列占位与「源码模式」对齐（Check 图标列同宽） */}
                    <span className="w-3.5 flex-shrink-0" />
                    添加笔记属性
                  </button>
                  <button
                    className="w-full flex items-center gap-2 px-2 py-1.5 text-xs hover:opacity-80"
                    style={{ color: "var(--text-primary)" }}
                    onClick={() => {
                      setSourceMode((v) => !v);
                      setShowMenu(false);
                    }}
                    title="源码模式：编辑区显示 Markdown 源码"
                  >
                    <span className="w-3.5 flex-shrink-0">
                      {sourceMode && <Check size={12} style={{ color: "var(--accent)" }} />}
                    </span>
                    源码模式
                  </button>
                </div>
              </>
            )}
          </span>
        </span>
      </div>

      {/* 外部修改冲突提示条：本地有未保存改动且磁盘已被外部修改。期间自动保存已暂停，
          需用户明确选择「重新加载」（丢弃本地）或「保留本地并保存」（覆盖外部修改），防静默覆盖 */}
      {conflict && (
        <div
          className="px-3 py-1 flex items-center gap-2 text-xs flex-shrink-0 select-none"
          style={{ background: "rgba(248,113,113,0.12)", color: "#f87171", borderBottom: "1px solid var(--border)" }}
        >
          <span className="flex-1 truncate">外部已修改此文件，保存将覆盖外部修改</span>
          <button
            onClick={reloadFromDisk}
            className="px-1.5 py-0.5 rounded border hover:opacity-80 flex-shrink-0"
            style={{ borderColor: "#f87171" }}
            title="丢弃本地改动，加载外部最新内容"
          >
            重新加载
          </button>
          <button
            onClick={saveLocalOverExternal}
            className="px-1.5 py-0.5 rounded border hover:opacity-80 flex-shrink-0"
            style={{ borderColor: "#f87171" }}
            title="用本地内容覆盖外部修改并立即保存"
          >
            保留本地并保存
          </button>
        </div>
      )}

      {/* 属性区：渲染/实时预览编辑模式内嵌编辑器顶部（可点击编辑）；
          源码模式由 textarea 显示 YAML 原文，不重复显示；格式错误时也显示（错误条 + 源码模式修复入口） */}
      {!sourceMode && (parsed.fmPrefix !== "" || !parsed.ok) && (
        <NotePropertiesView
          data={parsed.data}
          parseError={!parsed.ok}
          onUpdate={handlePropertiesUpdate}
          onOpenSource={() => setSourceMode(true)}
        />
      )}

      {loadError ? (
        <div className="flex-1 flex items-center justify-center text-sm" style={{ color: "#f87171" }}>
          读取笔记失败，请确认文件存在
        </div>
      ) : sourceMode ? (
        /* 源码模式：完整 Markdown 源码 textarea（含 frontmatter）；切换回实时预览编辑时内容经 content 双向同步。
           未激活编辑（preview）时只读（阅读/编辑分离，仅可查看源码），双击激活后进入可编辑源码模式 */
        <textarea
          value={content}
          onChange={(e) => handleChange(e.target.value)}
          readOnly={preview}
          onDoubleClick={(e) => {
            // 双击激活编辑：清除浏览器默认的双击选中单词，光标留在双击位置，不选中文本
            const ta = e.currentTarget;
            const pos = ta.selectionStart;
            ta.setSelectionRange(pos, pos);
            window.getSelection()?.removeAllRanges();
            setPreview(false);
          }}
          spellCheck={false}
          placeholder="笔记内容（Markdown）"
          className="flex-1 w-full resize-none outline-none p-4 text-sm leading-relaxed"
          style={{
            background: "var(--bg-primary)",
            color: "var(--text-primary)",
            // 只读（未激活编辑）时光标用默认指针，非文本光标
            cursor: preview ? "default" : "text",
          }}
        />
      ) : preview ? (
        /* 预览：只读渲染 Markdown（扩展语法公共配置；wiki 链接预览中不可定位，灰显降级）。
           四边 border 与 textarea 的全局边框（--input-border）对齐：切换预览时顶部/左右/下方边线均不再变化 */
        <div
          className="flex-1 overflow-auto markdown-body max-w-none break-words p-4 text-sm leading-relaxed"
          style={{ background: "var(--bg-primary)", color: "var(--text-primary)", border: "1px solid var(--input-border)" }}
          onDoubleClick={() => {
            // 双击进入编辑：先清除浏览器默认的双击文本选中（选中单词），再切换，避免进入编辑后残留选中
            window.getSelection()?.removeAllRanges();
            setPreview(false);
          }}
        >
          <ReactMarkdown
            remarkPlugins={previewPlugins}
            rehypePlugins={REHYPE_PLUGINS}
            components={markdownComponents({
              isLocatable: () => false,
              onLocate: () => {},
              onOpenNote: handleOpenWikiNote,
              isVaultPathNote,
              onOpenVaultPathNote: handleOpenVaultPathNote,
              onCreateNote: handleCreateNote,
              onOpenUrl: (url) => void useAppStore.getState().openUrl(url),
            })}
          >
            {content}
          </ReactMarkdown>
        </div>
      ) : (
        /* 编辑：实时预览编辑（CodeMirror 文本编辑 + 渲染装饰层，只编辑正文 body，
           frontmatter 由属性面板管理；编辑器自身样式见 styles/index.css）；
           border 与预览/源码模式对齐（1px），accent 高亮 = 进入编辑模式（与源码模式聚焦时一致） */
        <div
          className="markdown-body flex-1 overflow-auto"
          style={{
            background: "var(--bg-primary)",
            color: "var(--text-primary)",
            border: "1px solid var(--accent)",
          }}
        >
          <MarkdownEditor
            body={parsed.body}
            syncSeq={editorSyncSeq}
            onBodyChange={(md) => {
              // CRLF 文件：编辑器统一输出 LF，拼回前转回文件原有换行，防 frontmatter/正文混用
              const body = parsed.body.includes("\r\n") ? md.replace(/\n/g, "\r\n") : md;
              handleChange(parsed.fmPrefix + body);
            }}
          />
        </div>
      )}

      {/* 反向链接区（编辑器内容区下方，独立于属性区）：引用本文档的笔记列表，点击打开引用方；
          空 = 无引用时也显示该区（空态提示） */}
      <div
        className="flex-shrink-0 px-3 py-2 select-none"
        style={{ borderTop: "1px solid var(--border)" }}
      >
        <div className="text-xs mb-1" style={{ color: "var(--text-muted)" }}>
          反向链接{backlinks.length > 0 ? `（${backlinks.length}）` : ""}
        </div>
        {backlinks.length > 0 ? (
          <div className="flex flex-col gap-0.5 max-h-40 overflow-auto">
            {backlinks.map((b) => (
              <button
                key={b.file}
                className="flex items-center gap-1 text-xs text-left truncate hover:opacity-80"
                style={{ color: "var(--accent)" }}
                onClick={() => useAppStore.getState().openNote(b.file, b.title)}
                title={`打开「${b.title}」`}
              >
                <span className="truncate">{b.title}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>
            暂无引用
          </div>
        )}
      </div>

      {/* 底部状态条：字数统计 */}
      <div
        className="px-3 py-1 text-[11px] flex-shrink-0 select-none"
        style={{ borderTop: "1px solid var(--border)", color: "var(--text-muted)" }}
      >
        {content.length} 字
      </div>
    </div>
  );
}
