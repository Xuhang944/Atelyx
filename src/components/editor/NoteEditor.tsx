/**
 * 无画布时的 `.md` 笔记编辑器（未打开画布时单击笔记打开）。
 *
 * 占据主编辑区（画布位置）：顶部文件操作条，正文 textarea。
 * - 加载：进入时读笔记正文（切换笔记重读）；加载完成前用户已输入则保留输入（不覆盖正在打的字）。
 * - 保存：输入 debounce 500ms 自动写回 `.md`；卸载/切走时 flush 未落盘输入（不静默丢弃）；
 *   写入完成时若已有更新输入则保持「保存中…」，避免误报「已自动保存」；状态写 vaultStore 由面积 header 展示。
 * - 分层：走 vaultStore（readNoteContent / saveNoteContent），不直调 service。
 */
import { Check, MoreHorizontal, Pencil, Wand2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { useVaultStore, lastFolderRenameTarget, lastNoteRenameTarget, isKnownNoteDiskContent, type NoteSaveStatus } from "@/stores/vaultStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useAppStore } from "@/stores/appStore";
import { useChatPanelStore } from "@/stores/chatPanelStore";
import { useCollabStore } from "@/stores/collabStore";
import { useNoteCollabStore } from "@/stores/noteCollabStore";
import { Menu, MenuItem } from "@/components/common/Menu";
import type { BacklinkRow, CollabPeer } from "@/types";
import {
  MARKDOWN_PLUGINS,
  REHYPE_PLUGINS,
  remarkSoftLineBreak,
} from "@/utils/markdown";
import { parseFrontmatter, stringifyFrontmatter } from "@/utils/frontmatter";
import { noteTitleFromFile } from "@/utils/filename";
import { NotePropertiesView } from "@/components/editor/NotePropertiesView";
import { MarkdownEditor } from "@/components/editor/MarkdownEditor";
import { NoteHistoryModal } from "@/components/editor/NoteHistoryModal";
import { useMarkdownComponents } from "@/hooks/useMarkdownComponents";
import { useVaultLinkHandlers } from "@/hooks/useVaultLinkHandlers";
import { usePopupAnchor } from "@/hooks/usePopupAnchor";
import { PopupLayer } from "@/components/common/PopupLayer";

type SaveState = NoteSaveStatus["state"];

/** 模块级空数组：notePeers 缺省引用（避免每次渲染新数组导致无限重渲染，见 AGENTS 8.4）。 */
const EMPTY_PEERS: CollabPeer[] = [];

export function NoteEditor({ file }: { file: string }) {
  const readNoteContent = useVaultStore((s) => s.readNoteContent);
  const saveNoteContent = useVaultStore((s) => s.saveNoteContent);
  // 外部修改感知：watcher note 事件 bump 序号（vaultStore.markNoteExternallyEdited），据此重读磁盘
  const externalEditSeq = useVaultStore((s) => s.externalNoteEdits[file] ?? 0);
  // 保存状态存 vaultStore（面积 header 展示；本组件只写不持）
  const noteSaveStatus = useVaultStore((s) => s.noteSaveStates[file]);
  const loadError = noteSaveStatus?.loadError ?? false;
  /** 协作态判定与应用身份：中转开关已开且已连接时，当前笔记进入 Yjs 协同编辑。 */
  const collabEnabled = useSettingsStore((s) => s.collabEnabled);
  const collabConnected = useCollabStore((s) => s.connected);
  const collabNickname = useSettingsStore((s) => s.collabNickname);
  const collabColor = useSettingsStore((s) => s.collabColor);
  const collabDevice = useSettingsStore((s) => s.deviceName);
  const isCollab = collabEnabled && collabConnected;
  /** 当前笔记的协作文档绑定（后台 noteCollabStore 编排；下发给 MarkdownEditor 做 y-codemirror 绑定）。 */
  const collabBinding = useNoteCollabStore((s) => s.bindings[file]);
  const [content, setContent] = useState("");
  /** 编辑 / 预览切换（默认预览：打开即渲染；双击预览内容切回编辑；标题栏已显示文件名故顶部条不再重复）。 */
  const [preview, setPreview] = useState(true);
  /** 源码模式：编辑区显示完整 Markdown 源码 textarea；不勾选 = 实时预览编辑（CodeMirror）。 */
  const [sourceMode, setSourceMode] = useState(false);
  /** 右上角「···」更多选项弹层（统一 usePopupAnchor + PopupLayer）。 */
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const menu = usePopupAnchor(menuTriggerRef);
  /** 划词 AI 改写菜单（右键时的视口坐标 + 选中文本）；null = 关闭。 */
  const [rewriteMenu, setRewriteMenu] = useState<{
    x: number;
    y: number;
    text: string;
  } | null>(null);
  /** 划词改写菜单第二阶段：评论输入框（repositionDeps 切换菜单内容）。 */
  const [rewriteOpen, setRewriteOpen] = useState(false);
  /** 划词改写评论草稿。 */
  const [rewriteComment, setRewriteComment] = useState("");
  /** 历史记录面板开关（「···」更多选项入口）。 */
  const [historyOpen, setHistoryOpen] = useState(false);

  /** 内容区右键：有划词选区（且落在编辑器内容区内）→ 弹「AI 改写」菜单（三模式共用 DOM 选区）。 */
  const handleContentContextMenu = (e: React.MouseEvent) => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const text = sel.toString().trim();
    if (!text) return;
    // 选区须落在内容区内（data-note-content），顶部条/属性区/反链区的选区不触发
    const container = sel.getRangeAt(0).commonAncestorContainer;
    const inContent =
      container instanceof Element
        ? !!container.closest("[data-note-content]")
        : !!container.parentElement?.closest("[data-note-content]");
    if (!inContent) return;
    e.preventDefault();
    setRewriteComment("");
    setRewriteOpen(false);
    setRewriteMenu({ x: e.clientX, y: e.clientY, text });
  };
  /** 非用户编辑的 content 更新序号（加载完成/外部刷新/冲突重载时递增），MarkdownEditor 据此同步正文。 */
  const [editorSyncSeq, setEditorSyncSeq] = useState(0);
  /** 外部修改冲突：本地有未保存改动 + 磁盘已被外部改过。状态存 vaultStore 由面积 header 展示，期间暂停自动保存防覆盖。 */
  const conflictRef = useRef(false);
  const setConflictState = useCallback(
    (v: boolean) => {
      conflictRef.current = v;
      useVaultStore.getState().setNoteConflict(file, v);
    },
    [file],
  );
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 保存状态写 store（面积 header 展示；组件不持 state）。 */
  const setSaveStatus = useCallback(
    (state: SaveState, isLoadError = false) =>
      useVaultStore.getState().setNoteSaveState(file, { state, loadError: isLoadError }),
    [file],
  );
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

  /** 历史记录作者身份登记（进入仓库/编辑器时；身份随设置变化 pass 进本组件）。 */
  useEffect(() => {
    useVaultStore.getState().noteHistorySetAuthor(
      collabNickname || collabDevice || "用户",
      collabDevice || "",
    );
  }, [collabNickname, collabDevice]);

  /** 编辑器根节点引用：点击编辑器外部 → 取消编辑模式（回渲染预览）。 */
  const editorRootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      const root = editorRootRef.current;
      // 编辑器内部（内容区/属性区）不退出；portal 弹层（AI 改写菜单/「···」更多选项经
      // PopupLayer 挂 body，不在根节点内）也不退出——弹层内操作（点菜单项/评论输入框）
      // 不应把编辑态切回预览。preview 已是 true 时幂等无副作用。
      const target = e.target as Element | null;
      if (
        root &&
        !root.contains(e.target as Node) &&
        !target?.closest?.("[data-popup-layer]")
      ) {
        setPreview(true);
      }
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
    setSaveStatus("idle");
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
        if (!cancelled && !dirtyRef.current) setSaveStatus("idle", true);
      });
    return () => {
      cancelled = true;
      // 卸载/切走：清除保存/冲突状态（面积 header 随视图不显示），再 flush 未落盘的输入（debounce 窗口内不静默丢弃）。
      // 组件已卸载不能再 setState，fire-and-forget 写盘即可。
      // 冲突未决时跳过：外部已修改且未明确选择，不覆盖外部修改（提示条已告知）
      useVaultStore.getState().setNoteSaveState(file, null);
      useVaultStore.getState().setNoteConflict(file, false);
      useVaultStore.getState().clearNoteConflictResolveReq(file);
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
  }, [file, readNoteContent, saveNoteContent, setSaveStatus]);

  // 外部修改感知：磁盘内容 ≠ 自身最后写盘基准（lastSavedRef） = 变化（自写回放或真实外部变化）。
  // 无本地改动 → 静默刷新为磁盘最新（实时同步，含应用内其他编辑面——画布文本节点——的写盘回波）；
  // 有本地改动 → 磁盘 = 应用级基线（应用内写盘）则静默保留本地输入，否则冲突提示 + 暂停自动保存，
  // 防覆盖外部修改
  useEffect(() => {
    if (externalEditSeq <= processedSeqRef.current) return;
    processedSeqRef.current = externalEditSeq;
    let cancelled = false;
    void readNoteContent(file)
      .then((disk) => {
        if (cancelled || !mountedRef.current || disk === lastSavedRef.current) return;
        if (isCollab) {
          // 多写者协作：对端/本端正收敛写盘是常态，不走单写者冲突模型。
          // 磁盘 = 本地收敛内容 → 对端写盘与本地一致：静默推进基准（后续增量跳过）不弹冲突；
          // 本地有未落盘编辑且磁盘不同 → 对端尚未收敛的写盘：保留本地，等 debounce 覆盖收敛；
          // 无本地编辑且磁盘不同 → 对端/外部刚落盘一版：收敛到磁盘（回退/合并），不弹冲突、
          // 不静默覆盖——内容随下次保存以「编辑」历史记录，外部内容不丢失。
          if (disk === contentRef.current) {
            lastSavedRef.current = disk;
            return;
          }
          if (dirtyRef.current) return;
          if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
          }
          setContent(disk);
          contentRef.current = disk;
          lastSavedRef.current = disk;
          setSaveStatus("idle");
          // 编辑模式：以磁盘为基底重建 ytext（applyBody）并向房间重新收敛
          setEditorSyncSeq((s) => s + 1);
          return;
        }
        if (dirtyRef.current) {
          // 应用内其他编辑面写入（画布文本节点/AI 改笔记/保存为笔记）：静默保留本地输入，不弹「外部修改冲突」
          // （磁盘 = 应用最近已知内容，见 isKnownNoteDiskContent）；
          // 同时把 lastSavedRef 推进到该自写内容——挂起的 debounce 保存的写盘前校验
          // （handleChange 里「磁盘 ≠ lastSavedRef = 外部修改」）以此基线判定，不推进会把
          // 应用自写误判为外部修改弹冲突；推进后本地编辑按 LWW 覆盖应用自写（同编辑面语义）
          if (isKnownNoteDiskContent(file, disk)) {
            lastSavedRef.current = disk;
            return;
          }
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
          setSaveStatus("idle");
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
  }, [externalEditSeq, file, readNoteContent, setSaveStatus, setConflictState, isCollab]);

  /** 冲突「重新加载」：丢弃本地改动，恢复磁盘最新内容并解除冲突。 */
  const reloadFromDisk = useCallback(() => {
    void readNoteContent(file)
      .then((disk) => {
        if (!mountedRef.current) return;
        setContent(disk);
        contentRef.current = disk;
        lastSavedRef.current = disk;
        dirtyRef.current = false;
        setConflictState(false);
        setSaveStatus("idle");
        // 编辑模式：冲突「重新加载」同步编辑器
        setEditorSyncSeq((s) => s + 1);
      })
      .catch(() => {});
  }, [file, readNoteContent, setConflictState, setSaveStatus]);

  /** 历史回滚完成：把编辑器拨到回滚后内容（记入磁盘基准，编辑器/预览/属性区刷新）。 */
  const handleNoteRollback = useCallback(
    (content: string) => {
      setContent(content);
      contentRef.current = content;
      lastSavedRef.current = content;
      dirtyRef.current = false;
      setConflictState(false);
      setSaveStatus("saved");
      // 编辑模式：回滚同步编辑器（协作态经 applyBody 重建 ytext）
      setEditorSyncSeq((s) => s + 1);
    },
    [setSaveStatus, setConflictState],
  );
  const saveLocalOverExternal = useCallback(() => {
    const v = contentRef.current;
    setConflictState(false);
    const seq = ++saveSeqRef.current;
    setSaveStatus("saving");
    void saveNoteContent(file, v)
      .then(() => {
        lastSavedRef.current = v;
        // 保存期间又输入了（新 seq 已接管）：dirty 保持 true，防后续外部修改静默覆盖正在打的字
        if (seq === saveSeqRef.current) dirtyRef.current = false;
        if (mountedRef.current && seq === saveSeqRef.current) setSaveStatus("saved");
      })
      .catch(() => {
        if (mountedRef.current) setSaveStatus("error");
      });
  }, [file, saveNoteContent, setConflictState, setSaveStatus]);

  /** 面积 header 冲突条按钮 → vaultStore 序号请求 → 本组件订阅执行（与 externalNoteEdits 同构）。
   * 首帧以当前序号为基线：只响应本实例挂载后发出的请求（防处理卸载前残留请求）。 */
  const resolveReq = useVaultStore((s) => s.noteConflictResolveReq[file]);
  const processedResolveSeqRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (processedResolveSeqRef.current === undefined) {
      processedResolveSeqRef.current = resolveReq?.seq ?? 0;
      return;
    }
    const cur = resolveReq?.seq ?? 0;
    if (cur <= processedResolveSeqRef.current) return;
    processedResolveSeqRef.current = cur;
    if (resolveReq?.keepLocal) saveLocalOverExternal();
    else reloadFromDisk();
  }, [resolveReq, reloadFromDisk, saveLocalOverExternal]);

  const handleChange = (v: string) => {
    dirtyRef.current = true;
    contentRef.current = v;
    setContent(v);
    // 冲突中：仅更新本地内容，暂停自动保存（等用户选「重新加载」或「保留本地并保存」，防静默覆盖外部修改）
    if (conflictRef.current) return;
    // 输入即有未落盘改动：显示「未保存」；真正写盘时才切「保存中…」
    setSaveStatus("edited");
    if (timerRef.current) clearTimeout(timerRef.current);
    const seq = ++saveSeqRef.current;
    timerRef.current = setTimeout(() => {
      // 协作态：多写者落盘内容收敛一致，远端/对端正收敛写盘不应走「磁盘≠基准=外部修改」冲突预检
      // （会误报），只做增量跳过 + 直接保存收敛全文；真实外部整文件写入由外部感知 effect 兜底
      // （见其 collab 分支：不静默覆盖）。
      if (isCollab) {
        if (v === lastSavedRef.current) {
          dirtyRef.current = false;
          if (mountedRef.current && seq === saveSeqRef.current) setSaveStatus("saved");
          return;
        }
        setSaveStatus("saving");
        void saveNoteContent(file, v)
          .then(() => {
            lastSavedRef.current = v;
            if (seq === saveSeqRef.current) dirtyRef.current = false;
            if (mountedRef.current && seq === saveSeqRef.current) setSaveStatus("saved");
            // 记录编辑存档点（60s 内连续编辑合并为一版，不逐键）
            void useVaultStore.getState().noteHistoryRecord(file, v, "edit");
          })
          .catch(() => {
            if (mountedRef.current) setSaveStatus("error");
          });
        return;
      }
      // 写盘前校验磁盘基准：期间磁盘已被外部改动（disk ≠ lastSavedRef）则放弃本次写盘并转冲突提示，
      // 防 debounce 到点把外部修改覆盖掉（自写回放磁盘 = lastSavedRef，不受影响）
      void readNoteContent(file)
        .then((disk) => {
          if (!mountedRef.current || seq !== saveSeqRef.current) return;
          if (disk !== lastSavedRef.current) {
            setConflictState(true);
            return;
          }
          // 增量跳过：磁盘已包含与当前输入完全相同的内容（如输入后撤销回已保存状态），
          // 写盘纯属无操作——省去一次全量 fsync 写盘与随之而来的 watcher 回波
          if (v === lastSavedRef.current) {
            dirtyRef.current = false;
            if (mountedRef.current && seq === saveSeqRef.current) setSaveStatus("saved");
            return;
          }
          setSaveStatus("saving");
          void saveNoteContent(file, v)
            .then(() => {
              lastSavedRef.current = v;
              // 保存完成且无新输入：无未保存改动（dirtyRef 重置，后续外部修改恢复静默刷新语义）
              if (seq === saveSeqRef.current) dirtyRef.current = false;
              // 期间又有新输入（新定时器已接管）→ 不显示「已自动保存」；组件已卸载不再写状态
              if (mountedRef.current && seq === saveSeqRef.current) setSaveStatus("saved");
              // 记录编辑存档点（60s 内连续编辑合并为一版，不逐键）
              void useVaultStore.getState().noteHistoryRecord(file, v, "edit");
            })
            .catch(() => {
              if (mountedRef.current) setSaveStatus("error");
            });
        })
        .catch(() => {
          // 写盘前读磁盘失败：文件可能已被外部删除，放弃写盘（不覆盖不重建），提示保存失败
          if (mountedRef.current && seq === saveSeqRef.current) setSaveStatus("error");
        });
    }, 500);
  };

  /** Frontmatter 解析：content 变（输入/外部刷新）→ 面板数据即时重解析，形成「编辑/外部修改即刷新」闭环。 */
  const parsed = useMemo(() => parseFrontmatter(content), [content]);

  /** 协作文档绑定：进入协作态且内容已加载时，以正文（body，LF）为基线绑定 Y.Doc；
   * 绑定幂等——已绑定（collabBinding 非空）不重复建 doc，多面积共享同一实例。
   * 身份（昵称/用户色）随设置变化可重设（bind 内部幂等更新 awareness）。 */
  useEffect(() => {
    if (!isCollab || collabBinding || !content) return;
    useNoteCollabStore.getState().bind(
      file,
      parsed.body.replace(/\r\n/g, "\n"),
      {
        name: collabNickname || collabDevice || "用户",
        color: collabColor || "#30bced",
      },
    );
  }, [isCollab, collabBinding, file, content, parsed.body, collabNickname, collabColor, collabDevice]);

  /** 解绑协作文档：切笔记/卸载时释放一个引用（多面积各释放一次）。 */
  useEffect(() => {
    return () => {
      if (useNoteCollabStore.getState().bindings[file]) {
        useNoteCollabStore.getState().unbind(file);
      }
    };
  }, [file]);

  /** 笔记协作 presence：打开/关闭/切笔记时上报「正在看这篇笔记」，对端据此展示协作者。 */
  useEffect(() => {
    if (isCollab) useCollabStore.getState().notePresence(file);
    else useCollabStore.getState().notePresence(null);
    return () => useCollabStore.getState().notePresence(null);
  }, [isCollab, file]);

  /** 同看这篇笔记的在线协作者（presence.file 命中；卷标含用户色）。 */
  const collabPeers = useCollabStore((s) => s.peers);
  const notePeers = useMemo(
    () =>
      isCollab
        ? collabPeers.filter((p) => p.presence?.file === file && p.presence?.view === "note")
        : EMPTY_PEERS,
    [isCollab, collabPeers, file],
  );

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
  // 预览的 Markdown 组件配置：hook 统一 useMemo 稳定化（回调全部稳定，防预览随输入重渲染）
  const noteMarkdownComponents = useMarkdownComponents({
    onOpenNote: handleOpenWikiNote,
    isVaultPathNote,
    onOpenVaultPathNote: handleOpenVaultPathNote,
    onCreateNote: handleCreateNote,
  });

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
    <div
      ref={editorRootRef}
      className="h-full flex flex-col"
      style={{ background: "var(--bg-primary)" }}
      onContextMenu={handleContentContextMenu}
    >
      {/* 顶部条：右侧编辑/预览切换（保存状态已移至面积 header） */}
      <div
        className="px-3 py-1 flex items-center gap-1.5 text-xs flex-shrink-0 select-none"
        style={{ borderBottom: "1px solid var(--border)", color: "var(--text-muted)" }}
      >
        <span className="ml-auto flex items-center gap-2 flex-shrink-0">
          {/* 协作协作者：同看这篇笔记的在线用户（用户色卷标，点击定位到其选中位——暂只展示） */}
          {notePeers.length > 0 && (
            <span className="flex items-center gap-1 flex-shrink-0">
              {notePeers.slice(0, 4).map((p) => (
                <span
                  key={p.peerId}
                  className="flex items-center gap-1 rounded px-1 py-0.5 text-[11px]"
                  style={{
                    color: p.color,
                    background: `${p.color}1f`,
                    border: `1px solid ${p.color}55`,
                  }}
                  title={`${p.nickname}${p.deviceName ? `（${p.deviceName}）` : ""} 正在编辑本笔记`}
                >
                  <span
                    className="inline-block w-1.5 h-1.5 rounded-full"
                    style={{ background: p.color }}
                  />
                  {p.nickname}
                </span>
              ))}
              {notePeers.length > 4 && (
                <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                  +{notePeers.length - 4}
                </span>
              )}
            </span>
          )}
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
          {/* 「···」更多选项：笔记属性面板入口（统一弹层 PopupLayer：锚定 + 钳制 + Esc/外点关闭） */}
          <span className="flex-shrink-0">
            <button
              ref={menuTriggerRef}
              onClick={() => menu.toggle()}
              title="更多选项"
              className="p-0.5 rounded hover:opacity-80"
              style={{ color: menu.anchor ? "var(--accent)" : "var(--text-muted)" }}
            >
              <MoreHorizontal size={15} />
            </button>
            <PopupLayer
              anchor={menu.anchor}
              onClose={menu.close}
              triggerRef={menuTriggerRef}
              widthClass="w-36"
            >
              <button
                className="w-full flex items-center gap-2 px-2 py-1.5 text-xs hover:opacity-80"
                style={{ color: "var(--text-primary)" }}
                onClick={() => {
                  addFrontmatterTemplate();
                  menu.close();
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
                  menu.close();
                }}
                title="源码模式：编辑区显示 Markdown 源码"
              >
                <span className="w-3.5 flex-shrink-0">
                  {sourceMode && <Check size={12} style={{ color: "var(--accent)" }} />}
                </span>
                源码模式
              </button>
              <button
                className="w-full flex items-center gap-2 px-2 py-1.5 text-xs hover:opacity-80"
                style={{ color: "var(--text-primary)" }}
                onClick={() => {
                  menu.close();
                  setHistoryOpen(true);
                }}
                title="查看本笔记的历史版本并回滚"
              >
                <span className="w-3.5 flex-shrink-0" />
                历史记录
              </button>
            </PopupLayer>
          </span>
        </span>
      </div>

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
          data-note-content
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
          data-note-content
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
            components={noteMarkdownComponents}
          >
            {content}
          </ReactMarkdown>
        </div>
      ) : (
        /* 编辑：实时预览编辑（CodeMirror 文本编辑 + 渲染装饰层，只编辑正文 body，
           frontmatter 由属性面板管理；编辑器自身样式见 styles/index.css）；
           border 与预览/源码模式对齐（1px），accent 高亮 = 进入编辑模式（与源码模式聚焦时一致） */
        <div
          data-note-content
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
            collab={collabBinding}
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

      {/* 划词 AI 改写菜单：第一阶段 = 「AI 改写」入口；确认后追加评论输入框（repositionDeps 换内容），
          确认 → 改写请求入队面板（queueNoteRewrite），面板输入框自动插入指令文本 */}
      {rewriteMenu && (
        <Menu
          x={rewriteMenu.x}
          y={rewriteMenu.y}
          onClose={() => {
            setRewriteMenu(null);
            setRewriteOpen(false);
          }}
          widthClass="w-72"
          contentClassName="p-1.5"
          repositionDeps={[rewriteOpen]}
        >
          {!rewriteOpen ? (
            <MenuItem onClick={() => setRewriteOpen(true)}>
              <Wand2 size={14} className="flex-shrink-0" /> AI 处理（发送到对话面板）
            </MenuItem>
          ) : (
            <div>
              <textarea
                autoFocus
                value={rewriteComment}
                onChange={(e) => setRewriteComment(e.target.value)}
                placeholder="追加评论/要求（可选，如：语气更专业）"
                rows={3}
                spellCheck={false}
                className="w-full resize-none outline-none rounded border px-2 py-1.5 text-xs leading-relaxed"
                style={{
                  background: "var(--input-bg)",
                  color: "var(--text-primary)",
                  borderColor: "var(--input-border)",
                }}
                onKeyDown={(e) => {
                  // Enter 确认 / Shift+Enter 换行；IME 组合期间 Enter 上屏不触发
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    useChatPanelStore.getState().queueNoteRewrite({
                      noteFile: file,
                      label: noteTitleFromFile(file),
                      selectedText: rewriteMenu.text,
                      comment: rewriteComment.trim(),
                    });
                    setRewriteMenu(null);
                    setRewriteOpen(false);
                  }
                }}
              />
              <div className="flex justify-end gap-1 mt-1.5">
                <button
                  onClick={() => {
                    setRewriteMenu(null);
                    setRewriteOpen(false);
                  }}
                  className="px-2 py-1 rounded text-xs hover:opacity-80"
                  style={{ color: "var(--text-secondary)" }}
                >
                  取消
                </button>
                <button
                  onClick={() => {
                    useChatPanelStore.getState().queueNoteRewrite({
                      noteFile: file,
                      label: noteTitleFromFile(file),
                      selectedText: rewriteMenu.text,
                      comment: rewriteComment.trim(),
                    });
                    setRewriteMenu(null);
                    setRewriteOpen(false);
                  }}
                  className="px-2 py-1 rounded text-xs"
                  style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
                >
                  发送到面板
                </button>
              </div>
            </div>
          )}
        </Menu>
      )}

      {/* 笔记历史面板（「···」→ 历史记录） */}
      <NoteHistoryModal
        file={file}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onRollback={handleNoteRollback}
      />
    </div>
  );
}
