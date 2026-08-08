/**
 * 文件名工具。
 * 与 Rust 侧 `vault::sanitize_filename` 对齐（见 `src-tauri/src/vault.rs`），
 * 确保前端预生成的文件名与 Rust 落盘一致。
 */

/**
 * 净化文件名：替换 `/\:*?"<>|` 为 `_`，trim 首尾空白。
 * 与 Rust 侧 `sanitize_filename` 行为完全一致。
 */
export function sanitizeFilename(title: string): string {
  return title.replace(/[\/\\:*?"<>|]/g, "_").trim();
}

/**
 * 防重名：若 name 与 existing 列表中某项冲突，追加 `-2`、`-3`... 直到不冲突。
 * 序号插在扩展名前：`笔记-2.md`（而非 `笔记.md-2`）；无扩展名则直接追加。
 * @example dedupeFilename("笔记.md", ["笔记.md"]) === "笔记-2.md"
 * @example dedupeFilename("笔记", ["笔记", "笔记-2"]) === "笔记-3"
 * @example dedupeFilename("a.b.md", ["a.b.md"]) === "a.b-2.md"
 * @example dedupeFilename("笔记.md", ["其他.md"]) === "笔记.md"
 */
export function dedupeFilename(name: string, existing: string[]): string {
  const set = new Set(existing);
  if (!set.has(name)) return name;
  // 拆 stem/ext（取最后扩展名分隔点），序号插在 ext 前
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let i = 2;
  while (set.has(`${stem}-${i}${ext}`)) i++;
  return `${stem}-${i}${ext}`;
}

/** 文件相对路径的父目录（"a/b.md" → "a"；根目录文件 → ""）。 */
export function parentDir(file: string): string {
  const i = file.lastIndexOf("/");
  return i > 0 ? file.slice(0, i) : "";
}

/** 同目录新文件名拼接（父目录 + 文件名）。 */
export function siblingPath(file: string, name: string): string {
  const dir = parentDir(file);
  return dir ? `${dir}/${name}` : name;
}

/**
 * 目录重命名后 remap 相对路径：路径位于 `oldDir/` 下 → `newDir/` + 剩余部分；否则原样返回。
 * 前缀含尾斜杠，防误匹配 `a` 命中 `ab/x.md`。
 */
export function remapDirPrefix(path: string, oldDir: string, newDir: string): string {
  const prefix = `${oldDir}/`;
  return path.startsWith(prefix) ? `${newDir}/${path.slice(prefix.length)}` : path;
}
