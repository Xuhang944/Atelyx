/**
 * Markdown 渲染公共配置（GFM + KaTeX + 高亮 + 防 XSS）。
 * 同时被 ConversationNode / TextNode 使用（两处出现，抽公共避免复制变体）。
 *
 * 对齐通用笔记软件 Markdown 扩展语法：
 * - `==高亮==` → `<mark>`（micromark extension）
 * - `%%注释%%` → 渲染时隐藏（micromark extension + transform 删除占位节点）
 * - `[[笔记名]]` / `[[笔记名|别名]]` → 仓库内 wiki 链接；href 用相对锚点 `#/note/<name>`
 *   （sanitize 协议白名单无自定义协议，相对锚点天然放行），点击由组件层拦截并定位画布节点
 * - `> [!note]` → Callout 引用块（transform 附加 className，GitHub 同款语法）
 * - `![alt|100x200]` → 图片尺寸语法（transform 转 img width/height 属性）
 * - 文件开头 YAML Frontmatter（`---` 块）→ 不渲染为正文（remark-frontmatter 识别为 yaml 节点后删除，
 *   属性由笔记属性面板展示，）
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
import { sanitizeFilename } from "@/utils/filename";

// ===== micromark syntax：==高亮== / %%注释%% / [[wiki 链接]] =====

const EQUAL = 61; // "="
const PERCENT = 37; // "%"
const LBRACKET = 91; // "["
const RBRACKET = 93; // "]"

/** 成对定界符 tokenizer 工厂：`==`、`%%` 共用结构（token 名不同，内容不跨行、单个定界符为普通字符）。 */
function delimitedTokenize(tokenName: string, openCode: number, closeCode: number): Construct {
  const tokenNameTyped = tokenName as Parameters<Effects["enter"]>[0];
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
        effects.consume(code);
        return maybeClose;
      }

      function data(code: Code): State | undefined {
        if (code === closeCode || code === null || markdownLineEnding(code)) {
          effects.exit("data");
          return content(code);
        }
        effects.consume(code);
        return data;
      }

      function maybeClose(code: Code): State | undefined {
        if (code === closeCode) {
          effects.consume(code);
          effects.exit(tokenNameTyped);
          return ok(code);
        }
        // 单个定界符（如 `==a=b==` 中的 `=`）按普通字符继续
        return content(code);
      }
    },
  };
}

const highlightConstruct = delimitedTokenize("highlight", EQUAL, EQUAL);
const commentConstruct = delimitedTokenize("comment", PERCENT, PERCENT);

/** `[[笔记名]]` / `[[笔记名|别名]]`：内容不递归解析（值原样保留，别名用 `|` 分隔）。 */
const wikiLinkConstruct: Construct = {
  tokenize(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
    const wikiLinkToken = "wikiLink" as Parameters<Effects["enter"]>[0];
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
      effects.consume(code);
      return maybeClose;
    }

    function data(code: Code): State | undefined {
      if (code === RBRACKET || code === null || markdownLineEnding(code)) {
        effects.exit("data");
        return content(code);
      }
      effects.consume(code);
      return data;
    }

    function maybeClose(code: Code): State | undefined {
      if (code === RBRACKET) {
        effects.consume(code);
        effects.exit(wikiLinkToken);
        return ok(code);
      }
      return content(code);
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

/** 公共插件列表：两处节点组件共用，勿各自复制。
 * remark-frontmatter 放 remarkCompat 前：先识别文档开头 `---` 块为 yaml 节点，transform 阶段删除。 */
export const MARKDOWN_PLUGINS = [remarkGfm, remarkMath, remarkFrontmatter, remarkCompat];
export const REHYPE_PLUGINS: PluggableList = [
  [rehypeSanitize, MARKDOWN_SANITIZE_SCHEMA],
  rehypeHighlight,
  rehypeKatex,
];

// ===== wiki 链接工具 + 组件工厂 =====

export const WIKI_HREF_PREFIX = "#/note/";

/** `[[笔记名]]` → 候选文件名（无目录前缀：笔记任意文件夹存放，按文件名匹配全仓库同名笔记）。
 * 返回原样 + 净化后两种候选（文件名 = title 净化，）。 */
export function wikiNoteFileCandidates(value: string): string[] {
  const trimmed = value.trim();
  const candidates = [`${trimmed}.md`];
  const sanitized = sanitizeFilename(trimmed);
  if (sanitized && sanitized !== trimmed) candidates.push(`${sanitized}.md`);
  return candidates;
}

export interface WikiLocateOptions {
  /** 渲染时判断链接是否可定位（画布上有引用该笔记的文本节点）。 */
  isLocatable: (value: string) => boolean;
  /** 点击可定位链接时调用（组件层负责 fitView）。 */
  onLocate: (value: string) => void;
}

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
 * ReactMarkdown components 工厂：拦截 `#/note/` 锚点链接（wiki 链接）做定位交互，
 * 其余链接保持默认行为。className 由组件层附加（sanitize 之后），不受 schema 影响。
 */
export function markdownComponents({ isLocatable, onLocate }: WikiLocateOptions): Components {
  return {
    pre: CodeBlock,
    a: ({ href, children, ...rest }) => {
      if (!href?.startsWith(WIKI_HREF_PREFIX)) {
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
          title={locatable ? `定位笔记「${value}」` : `画布上没有引用「${value}」的文本节点`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (locatable) onLocate(value);
          }}
        >
          {children}
        </a>
      );
    },
  };
}
