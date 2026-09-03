/**
 * Markdown 渲染公共配置（GFM + KaTeX + 高亮 + 防 XSS）。
 * 同时被 ConversationNode / TextNode 使用（两处出现，抽公共避免复制变体）。
 *
 * 对齐通用笔记软件 Markdown 扩展语法：
 * - `==高亮==` → `<mark>`（micromark extension）
 * - `%%注释%%` → 渲染时隐藏（micromark extension + transform 删除占位节点）
 * - `[[笔记名]]` / `[[笔记名|别名]]` → 仓库内 wiki 链接；href 用相对锚点 `#/note/<name>`
 *   （sanitize 协议白名单无自定义协议，相对锚点天然放行），点击由组件层拦截：画布可定位则定位节点，
 *   否则打开目标笔记（onOpenNote 回调解文件名）
 * - `[label](基于仓库的路径)` → 标准 Markdown 链接指向仓库内笔记（相对仓库根路径，命中即内部链接样式、
 *   点击打开目标笔记；未命中/非 .md 不拦截，由组件层 isVaultPathNote/onOpenVaultPathNote 判定）；
 *   `[名]()` 空路径 = 目标笔记不存在，点击快捷新建（onCreateNote 回调解 label 作新笔记名）
 * - `> [!note]` → Callout 引用块（transform 附加 className，GitHub 同款语法）
 * - `![alt|100x200]` → 图片尺寸语法（transform 转 img width/height 属性）
 * - 文件开头 YAML Frontmatter（`---` 块）→ 不渲染为正文（remark-frontmatter 识别为 yaml 节点后删除，
 *   属性由笔记属性面板展示）
 *
 * 安全红线：rehype-sanitize 仍居 rehype 插件首位，自定义 schema 仅扩展渲染所需
 * 白名单；className 通配 `{}` 与 code 高亮一致——class 只驱动受控 CSS，无脚本执行面。
 */
import type { Plugin, PluggableList } from "unified";
import type { Blockquote, Break, Image, Root, Text } from "mdast";
import { useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import type {
  Code,
  Extension as MicromarkExtension,
  Construct,
  Effects,
  State,
  TokenizeContext,
} from "micromark-util-types";
import type { Extension as FromMarkdownExtension } from "mdast-util-from-markdown";
import { markdownLineEnding } from "micromark-util-character";
import { visit } from "unist-util-visit";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Schema } from "hast-util-sanitize";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import type { Components } from "react-markdown";
import { baseName, sanitizeFilename } from "@/utils/filename";

// ===== micromark syntax：==高亮== / %%注释%% / [[wiki 链接]] =====

const EQUAL = 61; // "="
const PERCENT = 37; // "%"
const LBRACKET = 91; // "["
const RBRACKET = 93; // "]"

/** 成对定界符 tokenizer 工厂：`==`、`%%` 共用结构（token 名不同，内容不跨行、单个定界符为普通字符）。
 * 定界符用 `<token>Delimiter` 标记 token 包裹消费（from-markdown 未注册 handler 自动跳过）——
 * micromark 断言每次 consume 前最后事件必须是 enter，`exit("data")` 后不能直接 consume 同一 code。 */
function delimitedTokenize(tokenName: string, openCode: number, closeCode: number): Construct {
  const tokenNameTyped = tokenName as Parameters<Effects["enter"]>[0];
  const delimiterType = `${tokenName}Delimiter` as Parameters<Effects["enter"]>[0];
  return {
    tokenize(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
      return start;

      function start(code: Code): State | undefined {
        effects.enter(tokenNameTyped);
        effects.consume(code);
        return open;
      }

      function open(code: Code): State | undefined {
        if (code !== openCode) return nok(code);
        effects.consume(code);
        return content;
      }

      function content(code: Code): State | undefined {
        if (code === null || markdownLineEnding(code)) return nok(code);
        if (code !== closeCode) {
          // 内容用核心 data token（mdast-util-from-markdown 默认 handler 转 text，自定义 token 会被跳过）
          effects.enter("data");
          return data(code);
        }
        return closeStart(code);
      }

      function data(code: Code): State | undefined {
        if (code === null || markdownLineEnding(code)) return nok(code);
        if (code === closeCode) {
          effects.exit("data");
          return closeStart(code);
        }
        effects.consume(code);
        return data;
      }

      /** 消费关闭定界符（进入时最后事件可能是 exit:data，先 enter 标记 token 再 consume 满足断言）。 */
      function closeStart(code: Code): State | undefined {
        effects.enter(delimiterType);
        effects.consume(code);
        effects.exit(delimiterType);
        return maybeClose;
      }

      function maybeClose(code: Code): State | undefined {
        if (code === closeCode) {
          effects.enter(delimiterType);
          effects.consume(code);
          effects.exit(delimiterType);
          effects.exit(tokenNameTyped);
          // 成功关闭：交还控制权（不带 code——当前 code 已被 consume，ok 由下一次 go 触发）
          return ok;
        }
        // 单个定界符（如 `==a=b==` 中的 `=`）按普通字符继续
        effects.enter("data");
        return data(code);
      }
    },
  };
}

const highlightConstruct = delimitedTokenize("highlight", EQUAL, EQUAL);
const commentConstruct = delimitedTokenize("comment", PERCENT, PERCENT);

/** `[[笔记名]]` / `[[笔记名|别名]]`：内容不递归解析（值原样保留，别名用 `|` 分隔）。
 * 结构与 delimitedTokenize 一致（delimiter token 包裹定界符，exit 后不裸 consume）。 */
const wikiLinkConstruct: Construct = {
  tokenize(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
    const wikiLinkToken = "wikiLink" as Parameters<Effects["enter"]>[0];
    const delimiterType = "wikiLinkDelimiter" as Parameters<Effects["enter"]>[0];
    return start;

    function start(code: Code): State | undefined {
      effects.enter(wikiLinkToken);
      effects.consume(code);
      return open;
    }

    function open(code: Code): State | undefined {
      if (code !== LBRACKET) return nok(code);
      effects.consume(code);
      return content;
    }

    function content(code: Code): State | undefined {
      if (code === null || markdownLineEnding(code)) return nok(code);
      if (code !== RBRACKET) {
        effects.enter("data");
        return data(code);
      }
      return closeStart(code);
    }

    function data(code: Code): State | undefined {
      if (code === null || markdownLineEnding(code)) return nok(code);
      if (code === RBRACKET) {
        effects.exit("data");
        return closeStart(code);
      }
      effects.consume(code);
      return data;
    }

    /** 消费关闭定界符（进入时最后事件可能是 exit:data，先 enter 标记 token 再 consume 满足断言）。 */
    function closeStart(code: Code): State | undefined {
      effects.enter(delimiterType);
      effects.consume(code);
      effects.exit(delimiterType);
      return maybeClose;
    }

    function maybeClose(code: Code): State | undefined {
      if (code === RBRACKET) {
        effects.enter(delimiterType);
        effects.consume(code);
        effects.exit(delimiterType);
        effects.exit(wikiLinkToken);
        return ok;
      }
      // 单个定界符（如 `[[a]b]]` 中的 `]`）按普通字符继续
      effects.enter("data");
      return data(code);
    }
  },
};

const compatMicromark: MicromarkExtension = {
  text: {
    [EQUAL]: highlightConstruct,
    [PERCENT]: commentConstruct,
    [LBRACKET]: wikiLinkConstruct,
  },
};

// ===== fromMarkdown：自定义 token → mdast 节点 =====

const compatFromMarkdown: FromMarkdownExtension = {
  enter: {
    highlight(token) {
      // mdast 无 mark 节点：data.hName 让 remark-rehype 输出 <mark>（sanitize 白名单已含 mark）
      this.enter({ type: "mark", children: [], data: { hName: "mark" } } as never, token);
    },
    comment(token) {
      // 占位节点，transform 阶段删除（%%注释%% 不渲染）
      this.enter({ type: "comment", children: [] } as never, token);
    },
    wikiLink(token) {
      // url 占位中间态（markdown 中不存在此 url），transform 阶段解析值并替换
      this.enter({ type: "link", url: "wiki-link", children: [] } as never, token);
    },
  },
  exit: {
    highlight(token) {
      this.exit(token);
    },
    comment(token) {
      this.exit(token);
    },
    wikiLink(token) {
      this.exit(token);
    },
  },
};

// ===== mdast transform：callout / 图片尺寸 / 注释清理 =====

/** 收集后统一删除（遍历中 splice 会跳过相邻节点）。 */
function dropNodes(tree: Root, types: string[]) {
  const targets: { parent: Extract<Root["children"][number], { children: unknown[] }>; index: number }[] = [];
  visit(tree, (node, index, parent) => {
    if (types.includes((node as { type: string }).type) && parent && index != null) {
      targets.push({ parent: parent as never, index });
    }
  });
  for (const t of targets.reverse()) {
    t.parent.children.splice(t.index, 1);
  }
}

function compatTransform(tree: Root) {
  // `[[笔记名]]` / `[[笔记名|别名]]`：把占位 link（url="wiki-link"）解析为仓库内锚点链接
  visit(tree, "link", (node) => {
    if (node.url !== "wiki-link") return;
    const text = node.children[0];
    if (!text || text.type !== "text") return;
    const sep = text.value.indexOf("|");
    const value = (sep >= 0 ? text.value.slice(0, sep) : text.value).trim();
    const alias = sep >= 0 ? text.value.slice(sep + 1) : "";
    node.url = `#/note/${encodeURIComponent(value)}`;
    node.children = [{ type: "text", value: alias || value }];
  });

  // `> [!type]` / `> [!type]+`（折叠标记 MVP 忽略，只取类型）：标记行不渲染，blockquote 挂 callout class
  visit(tree, "blockquote", (node: Blockquote) => {
    const paragraph = node.children[0];
    if (!paragraph || paragraph.type !== "paragraph") return;
    const first = paragraph.children[0];
    if (!first || first.type !== "text") return;
    const match = /^\[!([a-z][a-z0-9-]*)\]([+-])?\s*/i.exec(first.value);
    if (!match) return;
    const type = match[1].toLowerCase();
    first.value = first.value.slice(match[0].length);
    if (!first.value && paragraph.children.length === 1) {
      node.children.shift();
    }
    node.data = {
      ...node.data,
      hProperties: { className: ["callout", `callout-${type}`] },
    };
  });

  // `![alt|100x200]` / `![alt|100]` → img width/height 属性（图片尺寸语法）
  visit(tree, "image", (node: Image) => {
    if (!node.alt) return;
    const sep = node.alt.lastIndexOf("|");
    if (sep <= 0) return;
    const size = node.alt.slice(sep + 1).trim();
    if (!/^\d+(x\d+)?$/.test(size)) return;
    node.alt = node.alt.slice(0, sep);
    const [width, height] = size.split("x");
    node.data = { ...node.data, hProperties: { width, height } };
  });

  dropNodes(tree, ["comment", "yaml"]);
}

/**
 * remark 插件：组合 micromark syntax + fromMarkdown + mdast transform。
 * 用法与 remark-gfm 一致，直接进 remarkPlugins。
 */
const remarkCompat: Plugin<[], Root> = function () {
  const data = this.data() as {
    micromarkExtensions?: MicromarkExtension[];
    fromMarkdownExtensions?: FromMarkdownExtension[];
  };
  data.micromarkExtensions = [...(data.micromarkExtensions ?? []), compatMicromark];
  data.fromMarkdownExtensions = [...(data.fromMarkdownExtensions ?? []), compatFromMarkdown];
  return compatTransform;
};

// ===== sanitize schema（仅扩展渲染所需白名单，防 XSS 红线不变）=====

export const MARKDOWN_SANITIZE_SCHEMA: Schema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "mark"],
  attributes: {
    ...defaultSchema.attributes,
    // className 通配与 code 高亮一致（RegExp 匹配任意值 = 白名单通配）；class 无脚本执行面，仅驱动受控 CSS
    mark: [["className", /.*/]],
    blockquote: [["className", /.*/]],
    img: [...(defaultSchema.attributes?.img ?? []), "width", "height"],
  },
};

/** 宽松换行（编辑器设置，单个换行渲染为换行）：
 * 把软换行（text 节点中的单个 `\n`；行尾空格硬换行已被 remark 解析为 break 节点）替换为 `<br>`。
 * 关闭宽松换行时预览不注入本插件，按 Markdown 标准单换行视为空格（需空行才换行）。
 * 仅用于预览渲染（NoteEditor），对话/画布节点不注入。 */
export const remarkSoftLineBreak: Plugin<[], Root> = () => (tree: Root) => {
  const targets: {
    parent: Extract<Root["children"][number], { children: unknown[] }>;
    index: number;
    text: string;
  }[] = [];
  visit(tree, "text", (node, index, parent) => {
    const text = (node as { value: string }).value;
    if (parent && index != null && text.includes("\n")) {
      targets.push({ parent: parent as never, index, text });
    }
  });
  // 倒序替换：splice 不影响前面 index
  for (const t of targets.reverse()) {
    const nodes: (Break | Text)[] = [];
    for (const part of t.text.split(/(\n)/)) {
      if (part === "\n") nodes.push({ type: "break" });
      else if (part !== "") nodes.push({ type: "text", value: part });
    }
    t.parent.children.splice(t.index, 1, ...nodes);
  }
};

// ===== 正文内联标签 `#标签` → 胶囊渲染（与属性徽章同一视觉）=====

/** 标签正则：`#` 前非字母/数字/`#`/`_`/`/`（排除标题、日期 `#2024`、`foo#bar`、`##x`、URL 片段 `x.com/#faq`），
 * 标签字符集含字母数字 `_ - /`，须含 ≥1 个字母（与 Rust 侧 extract_inline_tags 同一语义；渲染层额外跳过代码/链接内文本）。
 * `u` 标志使 `\p{L}` 匹配 Unicode 字母（中文标签）。 */
const INLINE_TAG_RE = /(^|[^\p{L}\p{N}_#/])#([\p{L}\p{N}_\-/]+)/gu;

/** 把文本按内联标签拆分为分段（string = 原文片段，{tag} = 需胶囊化的标签）；无标签返回单段。 */
function splitInlineTags(value: string): (string | { tag: string })[] {
  const parts: (string | { tag: string })[] = [];
  let last = 0;
  INLINE_TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_TAG_RE.exec(value))) {
    const tag = m[2] ?? "";
    if (!/[\p{L}]/u.test(tag)) continue;
    // 起点 = `#` 位置（匹配含前缀字符，`^` 匹配前缀为空）：start 之前原文保留，胶囊从 `#` 起含整标签
    const start = m.index + (m[1]?.length ?? 0);
    const end = start + 1 + tag.length;
    if (start > last) parts.push(value.slice(last, start));
    parts.push({ tag });
    last = end;
  }
  if (last < value.length) parts.push(value.slice(last));
  return parts;
}

/** hast 节点最小结构（宽松类型，与既有 transform 风格一致；不依赖 hast 包解析）。 */
interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/**
 * 正文内联 `#标签` → 胶囊 span。跳过 code/pre/a 与 KaTeX 数学 DOM 内的文本（代码/链接/数学里的 `#` 不是标签）。
 * 置于 REHYPE_PLUGINS 末尾——sanitize 之后创建 span，不受白名单限制，
 * 只产出受控 class（无脚本执行面）。识别规则与 Rust 侧标签索引一致；链接内标签仅入索引、预览不渲染（视觉从简）。
 */
export const rehypeInlineTags: Plugin<[], HastNode> = () => (tree: HastNode) => {
  const processChildren = (children: HastNode[], skip: boolean): HastNode[] => {
    const out: HastNode[] = [];
    for (const child of children) {
      if (child.type === "text") {
        if (skip) {
          out.push(child);
          continue;
        }
        const parts = splitInlineTags(child.value ?? "");
        // 仅单段纯文本 = 无标签（原样保留）；纯 `#tag` 文本拆分为 [{tag}]（长度 1 但非字符串），
        // 需继续拆分——否则整行/整段仅一个标签时预览不渲染胶囊
        if (parts.length === 0 || (parts.length === 1 && typeof parts[0] === "string")) {
          out.push(child);
          continue;
        }
        for (const p of parts) {
          if (typeof p === "string") {
            out.push({ type: "text", value: p });
          } else {
            out.push({
              type: "element",
              tagName: "span",
              properties: { className: ["inline-tag"] },
              children: [{ type: "text", value: `#${p.tag}` }],
            });
          }
        }
      } else if (child.type === "element") {
        // 跳过 code/pre/a 与 KaTeX 数学 DOM（`\text{#tag}` 等是数学内容不是标签；katex 输出经 rehypeKatex 已定型）
        const props = (child.properties ?? {}) as { className?: unknown };
        const cls = Array.isArray(props.className) ? props.className.join(" ") : "";
        const childSkip =
          skip ||
          child.tagName === "code" ||
          child.tagName === "pre" ||
          child.tagName === "a" ||
          cls.includes("katex");
        child.children = processChildren(child.children ?? [], childSkip);
        out.push(child);
      } else {
        out.push(child);
      }
    }
    return out;
  };
  tree.children = processChildren(tree.children ?? [], false);
};

/** 公共插件列表：两处节点组件共用，勿各自复制。
 * remark-frontmatter 放 remarkCompat 前：先识别文档开头 `---` 块为 yaml 节点，transform 阶段删除。 */
export const MARKDOWN_PLUGINS = [remarkGfm, remarkMath, remarkFrontmatter, remarkCompat];
export const REHYPE_PLUGINS: PluggableList = [
  [rehypeSanitize, MARKDOWN_SANITIZE_SCHEMA],
  rehypeHighlight,
  rehypeKatex,
  rehypeInlineTags,
];

// ===== wiki 链接工具 + 组件工厂 =====

export const WIKI_HREF_PREFIX = "#/note/";

/** `[[笔记名]]` → 候选文件名（无目录前缀：笔记任意文件夹存放，按文件名匹配全仓库同名笔记）。
 * 返回原样 + 净化后两种候选（文件名 = title 净化）。 */
export function wikiNoteFileCandidates(value: string): string[] {
  const trimmed = value.trim();
  const candidates = [`${trimmed}.md`];
  const sanitized = sanitizeFilename(trimmed);
  if (sanitized && sanitized !== trimmed) candidates.push(`${sanitized}.md`);
  return candidates;
}

/** `[[笔记名]]` → 按文件名匹配全仓库同名笔记，返回 `{file, title}`（title = 文件名去 .md）。 */
export function wikiNoteFileOf(
  value: string,
  noteList: { name: string; file: string }[],
): { file: string; title: string } | null {
  for (const candidate of wikiNoteFileCandidates(value)) {
    const hit = noteList.find((n) => n.name === candidate);
    if (hit) return { file: hit.file, title: hit.name.replace(/\.md$/i, "") };
  }
  return null;
}

/** 链接 href 解码（用于匹配与展示）；非法百分号编码原样返回（不抛错、不拦截）。 */
function decodeLinkHref(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

/** `[label](基于仓库的路径)` → 按仓库相对路径（或文件名兜底）匹配笔记，返回 `{file, title}`。
 * percent 解码 + 反斜杠→`/` + 去 `./`/前导 `/`；含 `..` 段或未命中返回 null（防越出仓库、不拦截）。
 * 大小写不敏感兜底（Windows 文件系统不区分大小写：`方案.MD` 与 `方案.md` 是同一文件）。 */
export function vaultPathNoteOf(
  href: string,
  noteList: { name: string; file: string }[],
): { file: string; title: string } | null {
  let path = decodeLinkHref(href);
  path = path.replace(/\\/g, "/");
  while (path.startsWith("./")) path = path.slice(2);
  while (path.startsWith("/")) path = path.slice(1);
  if (!path) return null;
  if (path.split("/").includes("..")) return null;
  const basename = baseName(path);
  const ci = (s: string) => s.toLowerCase();
  const hit = noteList.find(
    (n) =>
      n.file === path ||
      ci(n.file) === ci(path) ||
      n.file === basename ||
      ci(n.file) === ci(basename),
  );
  if (!hit) return null;
  return { file: hit.file, title: hit.name.replace(/\.md$/i, "") };
}

export interface WikiLocateOptions {
  /** 渲染时判断链接是否可定位（画布上有引用该笔记的文本节点）。 */
  isLocatable: (value: string) => boolean;
  /** 点击可定位链接时调用（组件层负责 fitView）。 */
  onLocate: (value: string) => void;
  /** 点击不可定位链接时调用（组件层解析文件名后打开目标笔记）。 */
  onOpenNote: (value: string) => void;
  /** 渲染时判断相对路径链接（无协议、非 wiki/外部链接）是否指向仓库内笔记（命中 = 内部链接样式）。 */
  isVaultPathNote: (href: string) => boolean;
  /** 点击仓库内笔记链接（`[label](基于仓库的路径)`）时调用（组件层打开目标笔记）。 */
  onOpenVaultPathNote: (href: string) => void;
  /** 点击空路径内部链接（`[名]()`，目标笔记不存在）时调用（组件层快捷新建该笔记）。 */
  onCreateNote: (name: string) => void;
  /** 外部链接（http/https/mailto/xmpp）点击时调用（组件层经 shell 打开系统浏览器，webview 不导航）。 */
  onOpenUrl: (url: string) => void;
}

/** 拦截走系统浏览器的外部链接协议（MarkdownEditor 链接装饰共用同一正则）。 */
export const EXTERNAL_LINK_RE = /^(https?:|mailto:|xmpp:)/i;

/**
 * 代码块容器：右上角悬浮复制按钮（hover 显现）。
 * `nowheel`/`nodrag` 防画布缩放/拖拽；复制失败静默（边界捕获，不阻塞阅读）。
 */
function CodeBlock({
  children,
  node: _node,
  ...rest
}: React.JSX.IntrinsicElements["pre"] & { node?: unknown }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    const text = preRef.current?.querySelector("code")?.textContent ?? "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用（权限/非安全上下文）：静默失败，按钮不反馈
    }
  };
  return (
    <div className="relative group">
      <button
        type="button"
        title="复制代码"
        onClick={handleCopy}
        className="nodrag nowheel absolute top-1.5 right-1.5 rounded p-1 opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
      <pre ref={preRef} {...rest}>
        {children as ReactNode}
      </pre>
    </div>
  );
}

/**
 * ReactMarkdown components 工厂：按链接形态分流——`#/note/` wiki 锚点（画布定位/打开笔记）、
 * 空路径 `[名]()`（快捷新建）、外部协议（系统浏览器）、仓库内路径（打开笔记）、其余保持默认。
 * className 由组件层附加（sanitize 之后），不受 schema 影响。
 */
export function markdownComponents({
  isLocatable,
  onLocate,
  onOpenNote,
  isVaultPathNote,
  onOpenVaultPathNote,
  onCreateNote,
  onOpenUrl,
}: WikiLocateOptions): Components {
  return {
    pre: CodeBlock,
    a: ({ href, children, ...rest }) => {
      if (!href?.startsWith(WIKI_HREF_PREFIX)) {
        if (href === "") {
          // `[名]()` 空路径内部链接：目标笔记不存在，点击快捷新建（label 作新笔记名）
          const name = typeof children === "string" ? children : "";
          return (
            <a
              href={href}
              {...rest}
              className="internal-link internal-link-missing"
              title={name ? `创建笔记「${name}」` : "内部链接（目标笔记不存在）"}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (name) onCreateNote(name);
              }}
            >
              {children}
            </a>
          );
        }
        if (href && EXTERNAL_LINK_RE.test(href)) {
          return (
            <a
              href={href}
              {...rest}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onOpenUrl(href);
              }}
            >
              {children}
            </a>
          );
        }
        if (href && isVaultPathNote(href)) {
          return (
            <a
              href={href}
              {...rest}
              className="internal-link"
              title={`打开笔记「${decodeLinkHref(href)}」`}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onOpenVaultPathNote(href);
              }}
            >
              {children}
            </a>
          );
        }
        return (
          <a href={href} {...rest}>
            {children}
          </a>
        );
      }
      const value = decodeURIComponent(href.slice(WIKI_HREF_PREFIX.length));
      const locatable = isLocatable(value);
      return (
        <a
          href={href}
          {...rest}
          className={locatable ? "internal-link" : "internal-link internal-link-missing"}
          title={locatable ? `定位笔记「${value}」` : `打开笔记「${value}」`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (locatable) onLocate(value);
            else onOpenNote(value);
          }}
        >
          {children}
        </a>
      );
    },
  };
}
