/**
 * 文本式 Markdown 实时预览编辑（NoteEditor 编辑模式）。
 *
 * 架构：文档模型 = 纯文本（与文件正文逐字节一致），编辑永不改写内容——「实时预览」是
 * 纯视觉装饰层：语法高亮 + 标记隐藏（光标所在行/行内元素显示原文）+ 图片/链接/任务复选框
 * widget，每次击键/光标移动实时重算。不存在「序列化回写」环节，编辑行为不会规范化正文。
 *
 * 与 frontmatter 解耦：只编辑正文 body，`onBodyChange` 输出完整正文 markdown，
 * 由 NoteEditor 用 `fmPrefix + body` 拼回完整 content（frontmatter 原样保留）。
 *
 * 生命周期自建（不用任何 React 封装）：挂载点 ref 直挂 EditorView，卸载即 destroy
 * （`new EditorView` 同步完成，无 StrictMode 双挂载竞态）。
 *
 * 数据流：
 * - 用户编辑 → updateListener（同步）→ onBodyChange(doc.toString()) → NoteEditor.handleChange
 * - 外部同步（syncSeq 变化：watcher 外部修改 / 冲突重载 / 加载完成）→ dispatch 全量替换，
 *   写入用 suppress 标志吞掉紧随其后的同步回放（dispatch 同步触发 updateListener）
 * - 初始注入：create 后 replace 一次。
 *
 * 安全：渲染层只出样式（class + textContent + dataURL），不注入 HTML；链接点击经
 * Tauri shell 走系统默认程序，webview 不导航。
 */
import { useCallback, useEffect, useRef } from "react";
import {
  EditorState,
  RangeSetBuilder,
  StateField,
  Transaction,
  type Extension,
  type TransactionSpec,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  keymap,
  type DecorationSet,
} from "@codemirror/view";
import {
  HighlightStyle,
  syntaxHighlighting,
  syntaxTree,
} from "@codemirror/language";
import { markdown, markdownKeymap } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { tags } from "@lezer/highlight";
import { useAppStore } from "@/stores/appStore";
import { useVaultStore } from "@/stores/vaultStore";

// ===== 主题 =====

/** 语法高亮色板：全部映射现有主题 CSS 变量（浅/深主题自动跟随，无需额外配置）。 */
const highlightStyle = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "600", color: "var(--text-primary)" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.quote, color: "var(--text-secondary)" },
  { tag: tags.link, color: "var(--accent)" },
  { tag: tags.url, color: "var(--text-muted)" },
  { tag: tags.monospace, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
  { tag: tags.processingInstruction, color: "var(--text-muted)" },
  { tag: tags.comment, color: "var(--text-muted)" },
  { tag: tags.labelName, color: "var(--text-muted)" },
  { tag: tags.string, color: "var(--text-secondary)" },
]);

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "transparent",
    color: "var(--text-primary)",
    // 与预览/源码模式 text-sm（0.875rem）对齐，避免切换模式时字体跳动
    fontSize: "0.875rem",
  },
  ".cm-scroller": {
    fontFamily: "inherit",
    lineHeight: "1.625",
    padding: "1rem 0",
  },
  ".cm-content": {
    padding: "0 1rem",
    caretColor: "var(--accent)",
  },
  ".cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "1.5px" },
  "&.cm-focused": { outline: "none" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--accent) 25%, transparent)",
  },
  ".cm-gutters": { display: "none" },
});

// ===== 装饰 widgets（纯视觉层；点击经 shell 打开系统程序，webview 不导航） =====

/** 链接 widget：样式化可点击；光标进入链接范围后装饰失效、显示原文。 */
class LinkWidget extends WidgetType {
  constructor(
    private readonly text: string,
    private readonly url: string,
    private readonly openUrl: (url: string) => void,
  ) {
    super();
  }

  eq(other: LinkWidget) {
    return other.text === this.text && other.url === this.url;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "md-editor-link";
    span.textContent = this.text;
    span.title = this.url;
    span.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.openUrl(this.url);
    });
    return span;
  }
}

/** 异步图片加载取消器（widget 销毁时中断，防卸载后脏更新）。 */
const imageLoadCancels = new WeakMap<HTMLElement, () => void>();

/** 干净的仓库相对路径校验（无 `..`/`.`/空段、非绝对路径、非盘符或协议前缀），防 shell 打开逃逸仓库根。 */
function isSafeVaultRelPath(src: string): boolean {
  if (!src) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src)) return false;
  const parts = src.split(/[\\/]+/);
  return parts.every((p) => p !== "" && p !== "." && p !== "..");
}

/** 图片 widget：相对路径经 Rust 读 dataURL 异步加载；点击用系统默认程序打开原文件。 */
class ImageWidget extends WidgetType {
  constructor(
    private readonly src: string,
    private readonly alt: string,
    private readonly width: string | null,
    private readonly height: string | null,
    private readonly readImage: (src: string) => Promise<string | null>,
    private readonly openPath: (path: string) => void,
    private readonly vaultRoot: string | null,
  ) {
    super();
  }

  eq(other: ImageWidget) {
    return (
      other.src === this.src &&
      other.alt === this.alt &&
      other.width === this.width &&
      other.height === this.height
    );
  }

  toDOM() {
    const box = document.createElement("span");
    box.className = "md-editor-image";
    box.title = this.src;
    const img = document.createElement("img");
    img.alt = this.alt || this.src;
    img.loading = "lazy";
    img.draggable = false;
    if (this.width) img.style.width = `${this.width}px`;
    if (this.height) img.style.height = `${this.height}px`;
    // 点击打开原文件（系统默认程序）；绝对路径 = 仓库根 + 相对路径（Windows 兼容混合分隔符）。
    // 仅干净的仓库相对路径可点击：`..`/绝对路径/盘符或协议前缀一律不挂点击，防 shell 打开仓库外文件
    if (this.vaultRoot && isSafeVaultRelPath(this.src)) {
      const absolute = this.vaultRoot.replace(/[\\/]+$/, "") + "/" + this.src;
      box.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.openPath(absolute);
      });
    }
    let cancelled = false;
    imageLoadCancels.set(box, () => {
      cancelled = true;
    });
    if (/^https?:/i.test(this.src)) {
      img.src = this.src;
    } else {
      void this.readImage(this.src).then((dataUrl) => {
        if (cancelled) return;
        if (!dataUrl) {
          // 加载失败：降级回显原文（灰显），不显示破图
          box.classList.add("md-editor-image-missing");
          box.textContent = `![${this.alt}](${this.src})`;
          return;
        }
        img.src = dataUrl;
      });
    }
    box.appendChild(img);
    return box;
  }

  destroy(box: HTMLElement) {
    imageLoadCancels.get(box)?.();
    imageLoadCancels.delete(box);
  }
}

/** 任务列表复选框 widget：点击在 `[ ]`/`[x]` 之间切换（纯文本替换，零改写风险）。 */
class CheckboxWidget extends WidgetType {
  constructor(
    private readonly checked: boolean,
    private readonly toggle: () => void,
  ) {
    super();
  }

  eq(other: CheckboxWidget) {
    return other.checked === this.checked;
  }

  toDOM() {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "md-editor-checkbox";
    input.checked = this.checked;
    input.addEventListener("mousedown", (e) => e.stopPropagation());
    input.addEventListener("change", () => this.toggle());
    return input;
  }
}

/** wiki 链接 `[[标题|别名]]` widget：内部链接样式（编辑器内不可定位，点击无操作）。 */
class WikiLinkWidget extends WidgetType {
  constructor(
    private readonly text: string,
    private readonly target: string,
  ) {
    super();
  }

  eq(other: WikiLinkWidget) {
    return other.text === this.text && other.target === this.target;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "md-editor-wikilink";
    span.textContent = this.text;
    span.title = this.target;
    return span;
  }
}

/** 列表标记 widget：无序列表小圆点 / 有序列表序号（替代被隐藏的 `- `、`1. ` 标记）。 */
class ListMarkerWidget extends WidgetType {
  constructor(private readonly text: string) {
    super();
  }

  eq(other: ListMarkerWidget) {
    return other.text === this.text;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "md-editor-list-marker";
    span.textContent = this.text;
    return span;
  }
}

/** 横隔条 block widget：`---` 整行替换为水平线（光标所在行保持原文）。 */
class DividerWidget extends WidgetType {
  eq() {
    return true;
  }

  toDOM() {
    const div = document.createElement("div");
    div.className = "md-editor-divider";
    return div;
  }
}

// ===== 装饰构建 =====

interface DecorationOptions {
  vaultRoot: string | null;
  onOpenUrl: (url: string) => void;
  onOpenPath: (path: string) => void;
  readImage: (src: string) => Promise<string | null>;
}

/** 行内容器节点（Emphasis 等标记容器 + Link/Image 整体替换）。 */
const INLINE_CONTAINER_NAMES = new Set([
  "Emphasis",
  "StrongEmphasis",
  "InlineCode",
  "Strikethrough",
  "Link",
  "Image",
  "Autolink",
]);
/** 语法标记叶节点（容器边界 mark + 块级标记；围栏代码的 CodeMark 不在此列，保持原文）。 */
const MARK_NAMES = new Set([
  "HeaderMark",
  "QuoteMark",
  "ListMark",
  "EmphasisMark",
  "CodeMark",
  "LinkMark",
  "StrikethroughMark",
]);
/** 块级标记：按「光标所在行不隐藏」规则处理（其余 mark 由容器逻辑决定）。 */
const BLOCK_MARKS = new Set(["HeaderMark", "QuoteMark", "ListMark"]);

interface RangeInfo {
  from: number;
  to: number;
}

interface MarkInfo extends RangeInfo {
  name: string;
}

/** 任务复选框替换范围：ListMark 前缀原文保留（`- `、`* `、`1. ` 各自不动，toggle 只改 `[ ]`/`[x]`）。 */
interface TaskMarkerInfo extends RangeInfo {
  marker: string;
}

interface ContainerInfo extends RangeInfo {
  name: string;
  marks: RangeInfo[];
}

const rangeKey = (r: RangeInfo) => `${r.from}:${r.to}`;

/** `[text](url)` / `![alt](url)`（含可选 title）解析；不匹配返回 null（保持原文）。 */
function parseBracketLink(text: string): { label: string; url: string } | null {
  const m =
    /^\[([^\]]*)\]\(([^)\s]+)(?:\s+["'`][^"'`]*["'`])?\)$/.exec(text) ||
    /^\[([^\]]*)\]\(([^)]+)\)$/.exec(text);
  if (!m) return null;
  return { label: m[1] ?? "", url: m[2]?.trim() ?? "" };
}

function buildDecorations(
  state: EditorState,
  opts: DecorationOptions,
  dispatch: (spec: TransactionSpec) => void,
): DecorationSet {
  const doc = state.doc;
  const sel = state.selection.main;
  const cursorLine = doc.lineAt(sel.head).number;
  const tree = syntaxTree(state);
  const builder = new RangeSetBuilder<Decoration>();

  const marks: MarkInfo[] = [];
  const containers: ContainerInfo[] = [];
  const taskMarkers: TaskMarkerInfo[] = [];
  const dividerLines: RangeInfo[] = [];

  tree.iterate({
    enter: (node) => {
      const name = node.type.name;
      if (MARK_NAMES.has(name)) {
        marks.push({ from: node.from, to: node.to, name });
      } else if (INLINE_CONTAINER_NAMES.has(name)) {
        // 标记叶节点是容器节点的直接子节点（SyntaxNodeRef 无子树遍历，经 node.node 取）
        const childMarks: RangeInfo[] = [];
        for (let child = node.node?.firstChild; child; child = child.nextSibling) {
          if (MARK_NAMES.has(child.type.name)) {
            childMarks.push({ from: child.from, to: child.to });
          }
        }
        containers.push({ from: node.from, to: node.to, name, marks: childMarks });
      } else if (name === "TaskMarker") {
        // 任务复选框：沿父链找 ListItem（TaskMarker → Task → ListItem）取 ListMark 前缀，
        // 整段替换为复选框
        let listItem = node.node?.parent;
        while (listItem && listItem.type.name !== "ListItem") listItem = listItem.parent;
        const listMark = listItem?.getChild("ListMark");
        if (listMark) {
          taskMarkers.push({
            from: listMark.from,
            to: node.to,
            marker: doc.sliceString(listMark.from, listMark.to),
          });
        }
      } else if (name === "HorizontalRule") {
        // `---` 横隔条：按整行替换（含可能的缩进），光标所在行保持原文
        const line = doc.lineAt(node.from);
        dividerLines.push({ from: line.from, to: line.to });
      }
    },
  });

  const widgetEntries: { from: number; to: number; dec: Decoration }[] = [];
  const widgetBounds: RangeInfo[] = [];
  const marksToHide = new Set<string>();
  const marksToShow = new Set<string>();

  // 横隔条（`---` → 水平线 block widget；光标所在行保持原文）。
  // block 装饰只能经 StateField（standard decorations）提供，ViewPlugin 提供会抛 RangeError
  for (const d of dividerLines) {
    if (doc.lineAt(d.from).number === cursorLine) continue;
    const dec = Decoration.replace({ widget: new DividerWidget(), block: true });
    widgetEntries.push({ from: d.from, to: d.to, dec });
    widgetBounds.push({ from: d.from, to: d.to });
  }

  // 任务复选框（整段替换 `- [ ]` → 复选框；光标所在行保持原文）
  for (const t of taskMarkers) {
    if (doc.lineAt(t.from).number === cursorLine) continue;
    const checked = doc.sliceString(t.from, t.to).includes("[x]");
    const toggle = () => {
      const nowChecked = state.sliceDoc(t.from, t.to).includes("[x]");
      dispatch({
        changes: { from: t.from, to: t.to, insert: `${t.marker} [${nowChecked ? " " : "x"}]` },
      });
    };
    const dec = Decoration.replace({ widget: new CheckboxWidget(checked, toggle) });
    widgetEntries.push({ from: t.from, to: t.to, dec });
    widgetBounds.push({ from: t.from, to: t.to });
  }

  // 行内容器：由内向外处理（Link/Image 整体替换为 widget；标记容器隐藏其边界 mark）
  containers.sort((a, b) => a.to - a.from - (b.to - b.from) || a.from - b.from);
  const cursorInside = (from: number, to: number) => sel.from < to && sel.to > from;

  for (const c of containers) {
    if (cursorInside(c.from, c.to)) {
      // 光标所在的行内元素：显示原文（mark 不隐藏）
      for (const m of c.marks) marksToShow.add(rangeKey(m));
      continue;
    }
    if (c.name === "Link" || c.name === "Autolink") {
      const text = doc.sliceString(c.from, c.to);
      // `<https://x>` 角括号 Autolink：剥括号，url/label 用括号内内容
      const inner = text.length >= 2 && text[0] === "<" && text[text.length - 1] === ">" ? text.slice(1, -1) : text;
      const parsed = c.name === "Autolink" ? { label: inner, url: inner } : parseBracketLink(text);
      if (!parsed || !/^(https?:|mailto:|xmpp:)/i.test(parsed.url)) {
        // 非外链（相对路径/wiki 语法等）：标记保持原文，不隐藏
        for (const m of c.marks) marksToShow.add(rangeKey(m));
        continue;
      }
      const dec = Decoration.replace({
        widget: new LinkWidget(parsed.label || parsed.url, parsed.url, opts.onOpenUrl),
      });
      widgetEntries.push({ from: c.from, to: c.to, dec });
      widgetBounds.push({ from: c.from, to: c.to });
    } else if (c.name === "Image") {
      const text = doc.sliceString(c.from, c.to);
      const parsed = parseBracketLink(text);
      if (!parsed || !parsed.url) {
        for (const m of c.marks) marksToShow.add(rangeKey(m));
        continue;
      }
      let alt = parsed.label;
      let width: string | null = null;
      let height: string | null = null;
      // `![alt|100x200]` 图片尺寸语法
      const sep = alt.lastIndexOf("|");
      if (sep > 0) {
        const size = alt.slice(sep + 1).trim();
        if (/^\d+(x\d+)?$/.test(size)) {
          alt = alt.slice(0, sep).trim();
          const parts = size.split("x");
          width = parts[0] ?? null;
          height = parts[1] ?? null;
        }
      }
      const dec = Decoration.replace({
        widget: new ImageWidget(parsed.url, alt, width, height, opts.readImage, opts.onOpenPath, opts.vaultRoot),
      });
      widgetEntries.push({ from: c.from, to: c.to, dec });
      widgetBounds.push({ from: c.from, to: c.to });
    } else {
      // Emphasis/StrongEmphasis/InlineCode/Strikethrough：隐藏其边界 mark
      for (const m of c.marks) marksToHide.add(rangeKey(m));
    }
  }

  // wiki 链接 `[[标题|别名]]`（lezer 不识别的语法，按行正则匹配；光标行保持原文）
  for (let lineNum = 1; lineNum <= doc.lines; lineNum++) {
    if (lineNum === cursorLine) continue;
    const line = doc.line(lineNum);
    const re = /\[\[([^\]|]*?)(?:\|([^\]]*?))?\]\]/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(line.text))) {
      const target = (match[1] ?? "").trim();
      if (!target) continue;
      const from = line.from + match.index;
      const to = from + match[0].length;
      // 已被其它 widget 覆盖（如链接文本里的怪例）则跳过
      if (widgetBounds.some((w) => from >= w.from && to <= w.to)) continue;
      const dec = Decoration.replace({
        widget: new WikiLinkWidget((match[2] ?? target).trim() || target, target),
      });
      widgetEntries.push({ from, to, dec });
      widgetBounds.push({ from, to });
    }
  }

  // 其余 mark：块级标记（标题/引用/列表）按行隐藏；行内标记已由容器逻辑决定
  // （围栏代码的 CodeMark 不在 BLOCK_MARKS 且不进容器 → 保持原文，代码块不丢围栏）
  for (const m of marks) {
    if (marksToShow.has(rangeKey(m))) continue;
    if (widgetBounds.some((w) => m.from >= w.from && m.to <= w.to)) continue;
    if (marksToHide.has(rangeKey(m))) {
      widgetEntries.push({ from: m.from, to: m.to, dec: Decoration.replace({}) });
      continue;
    }
    if (BLOCK_MARKS.has(m.name) && doc.lineAt(m.from).number !== cursorLine) {
      // 列表标记替换为可视符号（`- ` → 小圆点、`1. ` → 序号），标题/引用标记保持隐藏
      const marker = m.name === "ListMark" ? doc.sliceString(m.from, m.to) : "";
      const dec = /^[-*+]$/.test(marker.trim())
        ? Decoration.replace({ widget: new ListMarkerWidget("•") })
        : marker
          ? Decoration.replace({ widget: new ListMarkerWidget(marker) })
          : Decoration.replace({});
      widgetEntries.push({ from: m.from, to: m.to, dec });
    }
  }

  widgetEntries.sort((a, b) => a.from - b.from || a.to - b.to);
  for (const w of widgetEntries) builder.add(w.from, w.to, w.dec);
  return builder.finish();
}

/** 实时预览装饰插件：文档/选区变化时全量重建（笔记规模下开销可忽略）。 */
/** 实时预览装饰 StateField：文档/选区变化时全量重建（笔记规模下开销可忽略）。
 * 用 StateField + EditorView.decorations.from 而非 ViewPlugin：block 装饰（横隔条）
 * 只能经 standard decorations 提供，ViewPlugin 提供会抛 RangeError。 */
function livePreview(
  opts: DecorationOptions,
  dispatchRef: { current: (spec: TransactionSpec) => void },
): Extension {
  return StateField.define<DecorationSet>({
    create(state) {
      return buildDecorations(state, opts, (spec) => dispatchRef.current(spec));
    },
    update(value, tr) {
      if (tr.docChanged || tr.selection !== undefined) {
        return buildDecorations(tr.state, opts, (spec) => dispatchRef.current(spec));
      }
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

// ===== 组件 =====

interface Props {
  /** 当前正文（挂载时初始注入；外部同步时 replaceAll 的目标）。 */
  body: string;
  /** 非用户编辑的 content 更新序号（外部修改/冲突重载/加载完成时 NoteEditor 递增），变化即同步编辑器。 */
  syncSeq: number;
  /** 用户编辑回调：输出编辑器当前全文 markdown 正文。 */
  onBodyChange: (markdown: string) => void;
}

export function MarkdownEditor({ body, syncSeq, onBodyChange }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** 装饰 widget 的 dispatch 转发：StateField 闭包捕获 ref 而非函数，view 创建后赋值才有效。 */
  const dispatchRef = useRef<(spec: TransactionSpec) => void>(() => {});
  /** 程序化注入的回放抑制：applyBody 的 dispatch 同步触发 updateListener，写入期间置位吞掉回放。 */
  const suppressRef = useRef(false);
  /** 上次注入内容：卸载 flush 时内容 === 注入目标则不重复上报。 */
  const lastAppliedRef = useRef("");
  const syncSeqRef = useRef(syncSeq);
  /** 回调/body 经 ref 转发：create 闭包在挂载时构建一次，捕获不到后续渲染的最新值。 */
  const onBodyChangeRef = useRef(onBodyChange);
  onBodyChangeRef.current = onBodyChange;
  const bodyRef = useRef(body);
  bodyRef.current = body;

  /** 程序化写入：记录注入目标 + 抑制回放，再全量替换（CRLF 注入前规范化为 LF）。 */
  const applyBody = useCallback((md: string) => {
    const view = viewRef.current;
    if (!view) return;
    const normalized = md.replace(/\r\n/g, "\n");
    lastAppliedRef.current = normalized;
    suppressRef.current = true;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: normalized },
      // 外部同步不进撤销栈：Ctrl+Z 不应回滚到注入前的内容（与用户编辑隔离）
      annotations: [Transaction.addToHistory.of(false)],
    });
    suppressRef.current = false;
  }, []);

  // 创建编辑器（`new EditorView` 同步完成，无需 StrictMode 异步守卫；卸载即 destroy）
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const opts: DecorationOptions = {
      vaultRoot: useAppStore.getState().vaultRoot,
      onOpenUrl: (url) => void useAppStore.getState().openUrl(url),
      onOpenPath: (path) => void useAppStore.getState().openInExplorer(path),
      readImage: async (src) => {
        try {
          return await useVaultStore.getState().readAttachmentDataUrl(src);
        } catch {
          return null;
        }
      },
    };
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: bodyRef.current.replace(/\r\n/g, "\n"),
        extensions: [
          // addKeymap: false——Enter/Backspace 绑定统一由下方 keymap.of 组合提供
          markdown({ codeLanguages: languages, addKeymap: false }),
          EditorView.lineWrapping,
          history(),
          keymap.of([...markdownKeymap, ...defaultKeymap, ...historyKeymap]),
          syntaxHighlighting(highlightStyle),
          editorTheme,
          livePreview(opts, dispatchRef),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !suppressRef.current) {
              onBodyChangeRef.current(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    dispatchRef.current = (spec) => view.dispatch(spec);
    // 初始注入（挂载时的 body）
    applyBody(bodyRef.current);
    return () => {
      // 卸载 flush：更新监听同步触发、正常编辑已实时上报，此处兜底取最新 doc
      // （复用回放抑制：内容 === 上次注入目标则不报，防注入回放误上报）
      try {
        const latest = view.state.doc.toString();
        if (latest !== lastAppliedRef.current) {
          onBodyChangeRef.current(latest);
        }
      } catch {
        // 视图已失效：跳过
      }
      viewRef.current = null;
      dispatchRef.current = () => {};
      view.destroy();
    };
  }, [applyBody]);

  // 外部同步：非用户编辑的 content 更新（watcher 外部修改 / 冲突重载 / 加载完成）
  useEffect(() => {
    if (syncSeq === 0 || syncSeq === syncSeqRef.current) return;
    syncSeqRef.current = syncSeq;
    applyBody(bodyRef.current);
  }, [syncSeq, applyBody]);

  return <div ref={hostRef} className="h-full" data-markdown-editor />;
}
