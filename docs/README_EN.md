<div align="center" style="padding:4px 0 12px">

[简体中文 →](../README.md)

</div>

<div align="center" style="background:#17171a;border:1px solid #2a2a2e;border-radius:16px;padding:48px 24px 40px;margin:0 0 32px">

<img src="../src-tauri/icons/icon.png" alt="Atelyx" width="92">

<h1 style="color:#E5E0D5;font-weight:700;letter-spacing:3px;margin:16px 0 10px">ATELYX</h1>

<p style="color:#D4AF37;font-size:17px;font-weight:600;margin:0 0 14px">Put conversations, notes, tables, and knowledge into one workbench — AI throughout, and multi-user collaboration</p>

<p style="color:#8b8b8b;max-width:660px;margin:0 auto 30px;font-size:15px;line-height:1.8">
A human-first desktop creation workbench: a dockable multi-view workspace with multiple windows, so AI conversations, notes, knowledge bases, search, and tables are reachable and connectable at a glance — real-time multi-user collaboration, with AI woven throughout. Thinking should never be interrupted.
</p>

<span style="background:#D4AF37;color:#1C1C1E;border-radius:999px;padding:4px 18px;font-size:13px;font-weight:700;margin:0 4px">Windows</span>
<span style="border:1px solid #5a5a5e;color:#9a9a9e;border-radius:999px;padding:3px 17px;font-size:13px;font-weight:600;margin:0 4px">Linux · Wayland</span>
<span style="border:1px solid #5a5a5e;color:#9a9a9e;border-radius:999px;padding:3px 17px;font-size:13px;font-weight:600;margin:0 4px">Apache-2.0</span>

</div>

## Design Philosophy

The worst thing in creation is not the lack of inspiration — it is the interruption of thought. When writing a screenplay, your material lives in a writing app, the storyboard in a spreadsheet tool, and coordination switches back to a chat app — each step feels convenient on its own, yet every switch breaks your flow. What Atelyx wants is to make those switches unnecessary:

<div style="border:1px solid #2a2a2e;border-left:3px solid #D4AF37;border-radius:8px;padding:14px 20px;margin:14px 0">

**01 · One workbench, home for all creation** — conversations, notes, tables, files, and search can all sit side by side in a single workbench. Tabs dock, panels tear off into independent windows, and views combine freely.

**02 · AI woven throughout** — from conversation and note text-selection to table row generation, to reading/writing vault files and web search, AI is one part of the creative flow rather than a separate chat tool you must switch to.

**03 · Artifacts are reusable** — materials, search results, and distilled paragraphs settle into reusable assets that plug into any conversation; context is no longer one-off.

**04 · Knowledge collaborates** — over a LAN, multiple people see each other in real time: co-editing a note, co-editing a canvas, co-viewing a table. Who is looking at what, and where their selection is, is visible at a glance.

**05 · Files are the vault** — no database; canvases, notes, and attachments are plain files: accumulable, backup-able, Git-syncable, and openable in external editors with real-time sync back.

</div>

## Signature: Infinite Canvas · Directed Graph

The canvas remains a signature capability: a conversation with AI should not be a one-way timeline. Once branches multiply, they become impossible to compare; Atelyx turns them into canvas nodes — each branch inherits the full state of its parent and evolves independently, so any number of threads can be laid side by side and compared.

- **Conversation is a directed graph, not a chat log** — a branch is a new node on the canvas; edges express data flow (producer → consumer)
- **Edges are data flow** — typing `@` in the input box and dragging a line from a node's border are two ways of performing the same operation; solid = consumed, dashed = pending
- **Artifacts become nodes** — web search results, pasted materials, and paragraphs distilled from a conversation automatically settle onto the canvas as reusable assets

```
+----------------+             +----------------+
| Conversation A | --branch--> | Conversation B |
+--------+-------+             +----------------+
         | extract: pull out a paragraph
         v
+----------------+
|   Text node    |
+--------+-------+
         | @ mention / drag-and-connect (dashed -> solid)
         v
+----------------+                    +----------------+
| Conversation C | --AI web search--> | Search results |
+--------+-------+                    +----------------+
         | feed: media node / table node
         v
   continue / branch again......
```

- **Conversation node** — multi-turn AI chat with streaming output, branching, and referenceable assets
- **Text node** — a paragraph distilled from a conversation; editable and reusable as prompt context in any conversation
- **Media node** — images and files pasted or dragged in, injected as multimodal attachments
- **Search results node** — the artifact of the AI autonomously searching the web mid-conversation
- **Table node** — a reference to a vault table; a snapshot assembled by field name is injected on use
- **Group / Link node** — canvas organization and external URL cards

## Core Capabilities

| | |
| --- | --- |
| **Dockable workspace · multi-window** | Tab groups dock; panels tear off into independent windows and can be dragged between panels; built-in canvas/note/table layouts; layouts named, saved, and restored on restart; tabs can be locked against accidental edits |
| **Real-time multi-user collaboration** | LAN relay, online members visible in real time (nickname / color / selection highlight); notes co-edited via Yjs with remote cursors; canvas nodes and messages sync instantly with exclusive per-conversation locks and generation indicators; table selections and content shared live |
| **AI conversation & Agents** | Streaming output, branching anytime, collapsible reasoning; reasoning-effort and model two-level selector; vault-level Agent configuration (system prompt + tools); multi-provider model management, connectivity test, model aliases |
| **AI I/O & web** | Agent tools: web search, web fetch, read/locate/search/write/edit vault files |
| **Note editor** | Live-preview editing; inline frontmatter properties; wiki links with quick-create for missing targets; auto-discovered backlinks; AI rewriting on text selection; collaboration |
| **Multi-dimensional table** | Typed fields and multi-image cells; timeline view with playback; AI-assisted row generation; column/row height auto-fitting; undo/redo; xlsx export |
| **History & rollback** | Canvas/note/table version lists, plain-language summaries, change diffs, one-click rollback |
| **File-based vault** | No database, everything is files; notes openable in external editors with real-time sync; renames cascade across references and internal links; exclude folders / attachment folder configurable |
| **Online + vault search** | Web search (Tavily / self-hosted SearXNG); in-vault file lookup + full-text search; search results settle into nodes |

## Interface Overview

<div align="center">

<img src="screenshots/canvas.svg" alt="Infinite canvas: conversation branches and data flow" width="100%">

<img src="screenshots/table.svg" alt="Multi-dimensional table: timeline and playback" width="100%">

<img src="screenshots/note.svg" alt="Note editor: live preview and backlinks" width="100%">

<img src="screenshots/workspace.svg" alt="Workspace: dockable tab groups and multi-window" width="100%">

</div>

## Installation

Download the installer for your platform from [GitHub Releases](https://github.com/Xuhang944/Atelyx/releases):

| Platform | Package |
| --- | --- |
| Windows 10/11 (x64) | `.msi` / `.exe` |
| Linux (native Wayland, X11 compatible) | build from source |

Or build from source:

```bash
pnpm install         # install frontend dependencies
pnpm run tauri:dev   # start dev (Vite + Tauri window)
pnpm run tauri:build # build installers
```

Prerequisites: Node.js 18+, pnpm, Rust (stable), Tauri 2 system dependencies (see [Tauri docs](https://v2.tauri.app/start/prerequisites/)).

## Vault Layout

A vault is a local folder of your choice. No database — everything is stored as files:

```
my-vault/
├── .atelyx/        vault-level config (hidden: config / agents / prompt-notes / chat history / history; API keys never land here)
├── project-a/
│   ├── canvas.atlx canvas file (one JSON per canvas)
│   ├── table.atb   table file
│   ├── prompt.md   note (openable in external editors)
│   └── assets/     attachments (images / files)
└── root-note.md    files at the root work too
```

- `.atlx` / `.md` / attachments are recognized by extension and may live in any folder (including the root)
- Text and media nodes store only path references — content stays in standalone files, shareable across canvases; deleting a canvas never deletes the files
- External edits to `.md` files, attachments, or canvases sync back to the app in real time

## Tech Stack

| Layer | Choice |
| --- | --- |
| Desktop shell | Tauri 2 (Rust backend, native Wayland) |
| Frontend | React 18 + TypeScript + Vite |
| Workspace | Dockable tab groups + multi-window tearing; panel layout tree |
| Canvas | React Flow |
| State | Zustand |
| Styling | TailwindCSS + lucide-react |
| Markdown | react-markdown; CodeMirror 6 live-preview editing |
| Collaboration | Yjs/CRDT note co-editing + self-hosted WebSocket relay (Docker, LAN) |
| Storage | File-based vault (no database) + `notify` real-time external-edit watching |
| AI | OpenAI-compatible providers (with reasoning effort); Agent tools can read/write files and go online; API keys in the OS keychain |
| Search | Tavily API + self-hosted SearXNG |
| Update | Auto-update with signed installers |

## Development

```bash
pnpm run dev         # Vite dev server
pnpm run check       # typecheck + ESLint + tests
pnpm run format      # Prettier
pnpm run tauri:dev   # start dev (Vite + Tauri window)
pnpm run tauri:build # build installers
```

## Privacy & Security

- **API keys live in the OS keychain by default** (isolated per vault) — never in vault files or logs; optional "save with vault" for multi-device sync
- **Multi-user collaboration is LAN-only** — peers see each other through a self-hosted relay, with no cloud sync; relay address and identity (nickname / color) are user-configured
- Markdown rendering disables raw HTML (XSS-safe); vault file reads/writes validate paths (confined to the vault root)
- Auto-update installers carry signature verification; invalid signatures are rejected

## Contributing

- Report bugs / request features: [Issues](https://github.com/Xuhang944/Atelyx/issues)
- Before submitting a pull request, please read [CONTRIBUTING.md](CONTRIBUTING.md) (Chinese)

## License

[Apache-2.0](../LICENSE)
