import {
  App,
  ItemView,
  MarkdownRenderer,
  Notice,
  Plugin,
  PluginSettingTab,
  RequestUrlParam,
  Setting,
  TFile,
  WorkspaceLeaf,
  normalizePath,
  requestUrl,
} from "obsidian";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ClaudeSettings {
  apiKey: string;
  model: string;
  maxTokens: number;
  systemPrompt: string;
}

const DEFAULT_SETTINGS: ClaudeSettings = {
  apiKey: "",
  model: "claude-sonnet-4-6",
  maxTokens: 8096,
  systemPrompt:
    "You are Claude Code running inside Obsidian. You have access to the user's vault and can read, write, search, and manage notes. Help the user with writing, coding, research, and note organization. When asked to modify notes, use the provided tools. Be concise and practical.",
};

type Role = "user" | "assistant";

interface TextBlock {
  type: "text";
  text: string;
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

interface Message {
  role: Role;
  content: string | ContentBlock[];
}

interface ToolDef {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required: string[];
  };
}

interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: ContentBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  usage: { input_tokens: number; output_tokens: number };
  error?: { type: string; message: string };
}

// ─── View ─────────────────────────────────────────────────────────────────────

const VIEW_TYPE_CLAUDE = "claude-code-view";

class ClaudeView extends ItemView {
  plugin: ClaudeCodePlugin;
  private messages: Message[] = [];
  private inputEl: HTMLTextAreaElement;
  private messagesEl: HTMLElement;
  private sendBtn: HTMLButtonElement;
  private isLoading = false;

  constructor(leaf: WorkspaceLeaf, plugin: ClaudeCodePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE_CLAUDE;
  }

  getDisplayText() {
    return "Claude Code";
  }

  getIcon() {
    return "bot";
  }

  async onOpen() {
    this.buildUI();
  }

  private buildUI() {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("claude-view");

    // Header
    const header = root.createDiv("claude-header");
    header.createSpan({ text: "Claude Code", cls: "claude-title" });
    const headerActions = header.createDiv("claude-header-actions");

    const clearBtn = headerActions.createEl("button", {
      text: "Clear",
      cls: "claude-btn-sm",
    });
    clearBtn.onclick = () => this.clearConversation();

    const activeBtn = headerActions.createEl("button", {
      text: "Insert note",
      cls: "claude-btn-sm",
    });
    activeBtn.onclick = () => this.insertActiveNote();

    // Messages container
    this.messagesEl = root.createDiv("claude-messages");

    this.renderWelcome();

    // Input area
    const inputArea = root.createDiv("claude-input-area");
    this.inputEl = inputArea.createEl("textarea", {
      cls: "claude-textarea",
      attr: { placeholder: "Ask Claude anything about your vault..." },
    });
    this.inputEl.rows = 3;
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    const inputActions = inputArea.createDiv("claude-input-actions");
    this.sendBtn = inputActions.createEl("button", {
      text: "Send",
      cls: "claude-btn-primary",
    });
    this.sendBtn.onclick = () => this.sendMessage();
  }

  private renderWelcome() {
    const welcome = this.messagesEl.createDiv("claude-welcome");
    welcome.createEl("p", {
      text: "👋 こんにちは! I'm Claude. I can help you with your Obsidian vault:",
    });
    const list = welcome.createEl("ul");
    [
      "Read and write notes",
      "Search across your vault",
      "Create structured notes from ideas",
      "Summarize, edit, or expand content",
      "Help with code or technical writing",
    ].forEach((item) => list.createEl("li", { text: item }));
  }

  private async insertActiveNote() {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice("No active note open");
      return;
    }
    const content = await this.app.vault.read(activeFile);
    this.inputEl.value =
      `[Current note: ${activeFile.path}]\n\n` + this.inputEl.value;
    this.inputEl.focus();
  }

  private clearConversation() {
    this.messages = [];
    this.messagesEl.empty();
    this.renderWelcome();
  }

  private async sendMessage() {
    const text = this.inputEl.value.trim();
    if (!text || this.isLoading) return;

    if (!this.plugin.settings.apiKey) {
      new Notice("Please set your Anthropic API key in Claude Code settings");
      return;
    }

    this.inputEl.value = "";
    this.messages.push({ role: "user", content: text });
    this.appendMessageBubble("user", text);
    this.setLoading(true);

    try {
      await this.runAgentLoop();
    } catch (err) {
      console.error("Claude error:", err);
      this.appendMessageBubble(
        "assistant",
        `⚠️ Error: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      this.setLoading(false);
    }
  }

  // Agentic loop: keep calling API until stop_reason is "end_turn"
  private async runAgentLoop() {
    const tools = buildToolDefinitions();
    let iterations = 0;
    const maxIterations = 10;

    while (iterations < maxIterations) {
      iterations++;
      const response = await callClaude(
        this.plugin.settings,
        this.messages,
        tools
      );

      // Collect text blocks for display
      const textParts: string[] = [];
      const toolCalls: ToolUseBlock[] = [];

      for (const block of response.content) {
        if (block.type === "text") textParts.push(block.text);
        if (block.type === "tool_use") toolCalls.push(block);
      }

      // Show assistant text
      if (textParts.length > 0) {
        this.appendMessageBubble("assistant", textParts.join("\n\n"));
      }

      // Add full assistant response to history
      this.messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason === "end_turn") break;
      if (response.stop_reason !== "tool_use") break;

      // Execute tools and collect results
      const toolResults: ToolResultBlock[] = [];
      for (const tc of toolCalls) {
        this.appendToolCall(tc.name, tc.input);
        const result = await executeTool(this.app, tc.name, tc.input);
        this.appendToolResult(tc.name, result);
        toolResults.push({
          type: "tool_result",
          tool_use_id: tc.id,
          content: result,
        });
      }

      // Add tool results back to history
      this.messages.push({ role: "user", content: toolResults });
    }
  }

  private appendMessageBubble(role: Role, text: string) {
    const wrap = this.messagesEl.createDiv(`claude-msg claude-msg-${role}`);
    const bubble = wrap.createDiv("claude-bubble");

    if (role === "assistant") {
      MarkdownRenderer.render(this.app, text, bubble, "", this);
    } else {
      bubble.createEl("p", { text });
    }

    this.scrollToBottom();
  }

  private appendToolCall(name: string, input: Record<string, unknown>) {
    const el = this.messagesEl.createDiv("claude-tool-call");
    const summary = el.createEl("details");
    summary.createEl("summary", { text: `🔧 ${name}` });
    const pre = summary.createEl("pre");
    pre.createEl("code", { text: JSON.stringify(input, null, 2) });
    this.scrollToBottom();
  }

  private appendToolResult(name: string, result: string) {
    const last = this.messagesEl.querySelectorAll(".claude-tool-call");
    const el = last[last.length - 1] as HTMLElement | null;
    if (!el) return;
    const details = el.querySelector("details");
    if (!details) return;
    const resultDiv = details.createDiv("claude-tool-result");
    const preview = result.length > 500 ? result.slice(0, 500) + "…" : result;
    resultDiv.createEl("pre").createEl("code", { text: preview });
    this.scrollToBottom();
  }

  private setLoading(loading: boolean) {
    this.isLoading = loading;
    this.sendBtn.disabled = loading;
    this.sendBtn.textContent = loading ? "…" : "Send";

    if (loading) {
      const indicator = this.messagesEl.createDiv("claude-loading");
      indicator.setAttribute("id", "claude-loading-indicator");
      indicator.createSpan({ text: "Claude is thinking" });
      const dots = indicator.createSpan({ cls: "claude-dots" });
      dots.createSpan({ text: "." });
      dots.createSpan({ text: "." });
      dots.createSpan({ text: "." });
      this.scrollToBottom();
    } else {
      document.getElementById("claude-loading-indicator")?.remove();
    }
  }

  private scrollToBottom() {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }
}

// ─── Tool Definitions ─────────────────────────────────────────────────────────

function buildToolDefinitions(): ToolDef[] {
  return [
    {
      name: "read_note",
      description:
        "Read the full content of a note in the vault. Returns the markdown content.",
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the note (e.g. 'folder/note.md')",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "write_note",
      description:
        "Create or overwrite a note in the vault with the given content.",
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path for the note (e.g. 'folder/note.md'). Will create folders if needed.",
          },
          content: {
            type: "string",
            description: "Markdown content to write",
          },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "append_to_note",
      description: "Append text to an existing note.",
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the note",
          },
          content: {
            type: "string",
            description: "Text to append",
          },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "list_notes",
      description: "List notes in a folder (or the vault root if no folder given).",
      input_schema: {
        type: "object",
        properties: {
          folder: {
            type: "string",
            description: "Folder path, or empty string for root",
          },
        },
        required: ["folder"],
      },
    },
    {
      name: "search_notes",
      description:
        "Search for notes containing a query string. Returns matching file paths and a snippet of matching content.",
      input_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Text to search for (case-insensitive)",
          },
          limit: {
            type: "string",
            description: "Max results to return (default 10)",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "get_active_note",
      description: "Get the path and content of the currently open note.",
      input_schema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "delete_note",
      description: "Move a note to trash.",
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the note to delete",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "rename_note",
      description: "Rename or move a note to a new path.",
      input_schema: {
        type: "object",
        properties: {
          old_path: {
            type: "string",
            description: "Current path of the note",
          },
          new_path: {
            type: "string",
            description: "New path for the note",
          },
        },
        required: ["old_path", "new_path"],
      },
    },
  ];
}

// ─── Tool Execution ───────────────────────────────────────────────────────────

async function executeTool(
  app: App,
  name: string,
  input: Record<string, unknown>
): Promise<string> {
  try {
    switch (name) {
      case "read_note":
        return await toolReadNote(app, String(input.path));

      case "write_note":
        return await toolWriteNote(
          app,
          String(input.path),
          String(input.content)
        );

      case "append_to_note":
        return await toolAppendNote(
          app,
          String(input.path),
          String(input.content)
        );

      case "list_notes":
        return toolListNotes(app, String(input.folder ?? ""));

      case "search_notes":
        return await toolSearchNotes(
          app,
          String(input.query),
          Number(input.limit ?? 10)
        );

      case "get_active_note":
        return await toolGetActiveNote(app);

      case "delete_note":
        return await toolDeleteNote(app, String(input.path));

      case "rename_note":
        return await toolRenameNote(
          app,
          String(input.old_path),
          String(input.new_path)
        );

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function toolReadNote(app: App, path: string): Promise<string> {
  const file = app.vault.getFileByPath(normalizePath(path));
  if (!file) return `Note not found: ${path}`;
  const content = await app.vault.read(file);
  return content;
}

async function toolWriteNote(
  app: App,
  path: string,
  content: string
): Promise<string> {
  const norm = normalizePath(path);
  const existing = app.vault.getFileByPath(norm);

  if (existing) {
    await app.vault.modify(existing, content);
    return `Updated note: ${norm}`;
  }

  // Ensure parent folders exist
  const parts = norm.split("/");
  if (parts.length > 1) {
    const folderPath = parts.slice(0, -1).join("/");
    if (!app.vault.getFolderByPath(folderPath)) {
      await app.vault.createFolder(folderPath);
    }
  }

  await app.vault.create(norm, content);
  return `Created note: ${norm}`;
}

async function toolAppendNote(
  app: App,
  path: string,
  content: string
): Promise<string> {
  const file = app.vault.getFileByPath(normalizePath(path));
  if (!file) return `Note not found: ${path}`;
  const existing = await app.vault.read(file);
  await app.vault.modify(file, existing + "\n" + content);
  return `Appended to: ${path}`;
}

function toolListNotes(app: App, folder: string): string {
  const allFiles = app.vault.getMarkdownFiles();
  const norm = folder ? normalizePath(folder) : "";
  const filtered = norm
    ? allFiles.filter((f) => f.path.startsWith(norm + "/") || f.path.startsWith(norm))
    : allFiles;

  if (filtered.length === 0) return "No notes found.";
  return filtered.map((f) => f.path).join("\n");
}

async function toolSearchNotes(
  app: App,
  query: string,
  limit: number
): Promise<string> {
  const lower = query.toLowerCase();
  const files = app.vault.getMarkdownFiles();
  const results: string[] = [];

  for (const file of files) {
    if (results.length >= limit) break;
    const content = await app.vault.cachedRead(file);
    if (
      file.path.toLowerCase().includes(lower) ||
      content.toLowerCase().includes(lower)
    ) {
      const idx = content.toLowerCase().indexOf(lower);
      const snippet =
        idx >= 0
          ? "…" + content.slice(Math.max(0, idx - 80), idx + 120).replace(/\n/g, " ") + "…"
          : "(filename match)";
      results.push(`${file.path}\n  ${snippet}`);
    }
  }

  return results.length > 0
    ? results.join("\n\n")
    : `No notes found matching: ${query}`;
}

async function toolGetActiveNote(app: App): Promise<string> {
  const file = app.workspace.getActiveFile();
  if (!file) return "No note is currently open.";
  const content = await app.vault.read(file);
  return `Path: ${file.path}\n\n${content}`;
}

async function toolDeleteNote(app: App, path: string): Promise<string> {
  const file = app.vault.getFileByPath(normalizePath(path));
  if (!file) return `Note not found: ${path}`;
  await app.vault.trash(file, true);
  return `Deleted (trashed): ${path}`;
}

async function toolRenameNote(
  app: App,
  oldPath: string,
  newPath: string
): Promise<string> {
  const file = app.vault.getFileByPath(normalizePath(oldPath));
  if (!file) return `Note not found: ${oldPath}`;
  await app.fileManager.renameFile(file, normalizePath(newPath));
  return `Renamed: ${oldPath} → ${newPath}`;
}

// ─── API Client ───────────────────────────────────────────────────────────────

async function callClaude(
  settings: ClaudeSettings,
  messages: Message[],
  tools: ToolDef[]
): Promise<AnthropicResponse> {
  const body = {
    model: settings.model,
    max_tokens: settings.maxTokens,
    system: settings.systemPrompt,
    tools,
    messages,
  };

  // Use Obsidian's requestUrl instead of fetch — on iOS, native fetch is
  // blocked by WKWebView CORS policy; requestUrl routes through the native layer.
  const params: RequestUrlParam = {
    url: "https://api.anthropic.com/v1/messages",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    throw: false,
  };

  const resp = await requestUrl(params);

  if (resp.status !== 200) {
    const msg = resp.json?.error?.message ?? `HTTP ${resp.status}`;
    throw new Error(`API error ${resp.status}: ${msg}`);
  }

  return resp.json as AnthropicResponse;
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class ClaudeSettingTab extends PluginSettingTab {
  plugin: ClaudeCodePlugin;

  constructor(app: App, plugin: ClaudeCodePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Claude Code Settings" });

    new Setting(containerEl)
      .setName("Anthropic API Key")
      .setDesc("Get your key from console.anthropic.com")
      .addText((text) =>
        text
          .setPlaceholder("sk-ant-...")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Claude model to use")
      .addDropdown((drop) =>
        drop
          .addOption("claude-haiku-4-5-20251001", "Claude Haiku 4.5 (fast)")
          .addOption("claude-sonnet-4-6", "Claude Sonnet 4.6 (recommended)")
          .addOption("claude-opus-4-8", "Claude Opus 4.8 (most capable)")
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Max tokens")
      .setDesc("Maximum tokens in response (1000–16000)")
      .addSlider((slider) =>
        slider
          .setLimits(1000, 16000, 1000)
          .setValue(this.plugin.settings.maxTokens)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxTokens = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("System Prompt")
      .setDesc("Customize Claude's behavior and persona")
      .addTextArea((area) =>
        area
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (value) => {
            this.plugin.settings.systemPrompt = value;
            await this.plugin.saveSettings();
          })
      );
  }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default class ClaudeCodePlugin extends Plugin {
  settings: ClaudeSettings;

  async onload() {
    await this.loadSettings();

    this.registerView(
      VIEW_TYPE_CLAUDE,
      (leaf) => new ClaudeView(leaf, this)
    );

    this.addRibbonIcon("bot", "Claude Code", () => this.activateView());

    this.addCommand({
      id: "open-claude-code",
      name: "Open Claude Code",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "send-selection-to-claude",
      name: "Send selection to Claude",
      editorCallback: (editor) => {
        const sel = editor.getSelection();
        if (!sel) {
          new Notice("No text selected");
          return;
        }
        this.activateView().then(() => {
          const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDE);
          if (leaves.length > 0) {
            const view = leaves[0].view as ClaudeView;
            (view as ClaudeView & { inputEl: HTMLTextAreaElement }).inputEl.value = sel;
          }
        });
      },
    });

    this.addSettingTab(new ClaudeSettingTab(this.app, this));
  }

  async activateView() {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_CLAUDE);

    if (existing.length > 0) {
      workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_CLAUDE, active: true });
    workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
