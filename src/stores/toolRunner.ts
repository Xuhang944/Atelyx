/**
 * AI 工具执行公共器（画布对话节点 / AI 对话面板共用）。
 * 按工具名分发：web_search → 搜索回填；write_note → 落盘笔记；append_table_row / edit_note
 * → 修改仓库文件。返回 tool 消息回填 AI + 结果摘要（消息气泡工具块展示）。
 * 画布/面板差异（产物节点）由 hooks 消化：画布传建节点回调，面板不传。
 */
import { runSearch } from "@/services/search";
import { useSettingsStore } from "@/stores/settingsStore";
import { useVaultStore } from "@/stores/vaultStore";
import { useTableStore } from "@/stores/tableStore";
import type { ChatParams, ToolCall } from "@/services/ai/client";
import type { ToolExecResult } from "./streaming";
import type { SearchResultData } from "@/types";

/** 工具执行钩子（产物节点差异由调用方注入）。 */
export interface ToolExecHooks {
  /** web_search 产物（画布 = 建搜索结果节点；面板不传）。 */
  onSearchResult?: (query: string, data: SearchResultData) => void;
  /** write_note 产物（画布 = 建笔记节点；面板不传）。 */
  onNoteCreated?: (file: string, title: string) => void;
}

/** 解析工具参数 JSON（残缺/非法降级为空对象，由各分支按缺参处理）。 */
function parseToolArgs(argsJson: string): Record<string, unknown> {
  try {
    return JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 校验 edits 数组元素为 {oldText, newText}（AI 传错形状时丢弃，防执行器崩）。 */
function asEdits(value: unknown): Array<{ oldText: string; newText: string }> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (e): e is { oldText: string; newText: string } =>
      typeof e === "object" &&
      e !== null &&
      typeof (e as { oldText?: unknown }).oldText === "string" &&
      typeof (e as { newText?: unknown }).newText === "string",
  );
}

/**
 * 执行一轮工具调用（引擎 executeTools 回调的公共实现）。
 * 搜索走 Rust 代理（invoke 不支持 AbortSignal）：用户点停止后，已发出的请求结果回来时
 * 被下方 aborted 检查丢弃（不建产物），引擎下一轮携已 abort 的 signal 立即收敛。
 */
export async function runToolCalls(
  calls: ToolCall[],
  signal: AbortSignal,
  hooks?: ToolExecHooks,
): Promise<{ messages: ChatParams["messages"]; results: ToolExecResult[] }> {
  const toolMessages: ChatParams["messages"] = [];
  const results: ToolExecResult[] = [];
  for (const tc of calls) {
    const args = parseToolArgs(tc.function.arguments);
    switch (tc.function.name) {
      case "web_search": {
        const query = typeof args.query === "string" ? args.query : "";
        const data = query
          ? await runSearch(useSettingsStore.getState().searchConfig, query)
          : { query: "", results: [], error: "搜索参数解析失败" };
        // 用户已点停止：不创建「搜索失败」节点（abort 后 runSearch 降级为 error，属预期中止而非失败）
        if (signal.aborted) break;
        if (data.results.length > 0 || data.error) {
          hooks?.onSearchResult?.(data.query || query || "搜索", data);
        }
        toolMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: data.error
            ? `搜索失败：${data.error}`
            : JSON.stringify(data.results),
        });
        results.push({
          id: tc.id,
          ok: !data.error,
          summary: data.error
            ? `搜索失败：${data.error}`
            : `找到 ${data.results.length} 条结果`,
        });
        break;
      }
      case "write_note": {
        const title = typeof args.title === "string" ? args.title.trim() : "";
        const content = typeof args.content === "string" ? args.content : "";
        if (!title || !content) {
          toolMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: "写笔记失败：缺少标题或正文",
          });
          results.push({ id: tc.id, ok: false, summary: "缺少标题或正文" });
          break;
        }
        if (signal.aborted) break;
        try {
          const file = await useVaultStore
            .getState()
            .createNoteWithContent(title, content);
          if (signal.aborted) break;
          hooks?.onNoteCreated?.(file, title);
          toolMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: `已生成笔记「${title}」（${file}）`,
          });
          results.push({
            id: tc.id,
            ok: true,
            summary: `已生成笔记《${title}》`,
          });
        } catch (e) {
          toolMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: `写笔记失败：${e instanceof Error ? e.message : String(e)}`,
          });
          results.push({
            id: tc.id,
            ok: false,
            summary: e instanceof Error ? e.message : String(e),
          });
        }
        break;
      }
      case "append_table_row": {
        const tableTitle =
          typeof args.tableTitle === "string" ? args.tableTitle.trim() : "";
        const rows = Array.isArray(args.rows) ? args.rows : [];
        if (!tableTitle || rows.length === 0) {
          toolMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: "追加失败：缺少 tableTitle 或 rows",
          });
          results.push({
            id: tc.id,
            ok: false,
            summary: "缺少表格标题或行数据",
          });
          break;
        }
        if (signal.aborted) break;
        const res = await useTableStore
          .getState()
          .appendRowsFromAi(tableTitle, rows);
        toolMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: res.ok ? res.summary : `追加失败：${res.summary}`,
        });
        results.push({ id: tc.id, ok: res.ok, summary: res.summary });
        break;
      }
      case "edit_note": {
        const note = typeof args.note === "string" ? args.note.trim() : "";
        const edits = asEdits(args.edits);
        if (!note || edits.length === 0) {
          toolMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: "修改失败：缺少 note 或 edits",
          });
          results.push({
            id: tc.id,
            ok: false,
            summary: "缺少笔记名或修改内容",
          });
          break;
        }
        if (signal.aborted) break;
        const res = await useVaultStore.getState().applyNoteEdits(note, edits);
        toolMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: res.ok ? res.summary : `修改失败：${res.summary}`,
        });
        results.push({ id: tc.id, ok: res.ok, summary: res.summary });
        break;
      }
      default:
        toolMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: `未知工具：${tc.function.name}`,
        });
        results.push({
          id: tc.id,
          ok: false,
          summary: `未知工具：${tc.function.name}`,
        });
    }
  }
  return { messages: toolMessages, results };
}
