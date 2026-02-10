# Cursor IDE — Internal Architecture & Protocol

> **Scope**: Facts sourced exclusively from external documentation, reverse engineering projects, and official Cursor publications. No speculation, no CCProxy test results.

---

## Sources

| Source | URL | Type |
|--------|-----|------|
| TensorZero reverse engineering | https://tensorzero.com/blog/reverse-engineering-cursors-llm-client/ | Reverse engineering (June 2025) |
| Roman Imankulov "Under the Hood" | https://roman.pt/posts/cursor-under-the-hood/ | Reverse engineering (Feb 2025) |
| Shrivu Shankar "How Cursor Works" | https://blog.sshh.io/p/how-cursor-ai-ide-works | Analysis (March 2025) |
| eisbaw/cursor_api_demo | https://github.com/eisbaw/cursor_api_demo | Reverse-engineered Python client (v2.3.41) |
| everestmz/cursor-rpc | https://github.com/everestmz/cursor-rpc | Reverse-engineered Go library |
| Cursor official blog | https://cursor.com/blog/dynamic-context-discovery | Official (Jan 2026) |
| Cursor changelog v1.6 | https://cursor.com/changelog/1-6 | Official (Sep 2025) |
| Pragmatic Engineer on Cursor | https://newsletter.pragmaticengineer.com/p/cursor | Analysis |
| ScriptedAlchemy prompt extraction | https://gist.github.com/ScriptedAlchemy/6dad354fae5092d35fe0455acf147f5b | Reverse engineering |
| Shrivu Shankar prompt extraction | https://gist.github.com/sshh12/25ad2e40529b269a88b80e7cf1c38084 | Reverse engineering (March 2025) |

---

## 1. Native Communication Protocol (ConnectRPC/Protobuf)

When using Cursor's built-in models (not Override Base URL), communication uses a proprietary binary protocol.

### API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `https://api2.cursor.sh` | Primary API |
| `https://api3.cursor.sh` | Telemetry |
| `https://agent.api5.cursor.sh` | Agent API (privacy mode ON) |
| `https://agentn.api5.cursor.sh` | Agent API (privacy mode OFF) |

*Source: eisbaw/cursor_api_demo README*

### Transport

- **Protocol**: HTTP/2 with ConnectRPC (gRPC-Web variant)
- **Encoding**: Binary protobuf with envelope format: `[type:1 byte][length:4 bytes big-endian][payload]`
- **Chat endpoint**: `/aiserver.v1.ChatService/StreamUnifiedChatWithTools`

*Source: eisbaw/cursor_api_demo README*

### Required Headers

```
Authorization: Bearer {token}
Content-Type: application/connect+proto
Connect-Protocol-Version: 1
x-cursor-client-version: {version, e.g. 2.3.41}
x-cursor-client-type: ide
x-cursor-client-os: {linux|darwin|win32}
x-cursor-client-arch: {x86_64|arm64}
x-cursor-client-device-type: desktop
x-cursor-checksum: {jyh_cipher_output}{machine_id}
x-ghost-mode: true
```

*Source: eisbaw/cursor_api_demo README*

### Checksum Algorithm ("Jyh Cipher")

```python
timestamp = int(time.time() * 1000 // 1000000)
bytes = [timestamp >> 40, timestamp >> 32, timestamp >> 24,
         timestamp >> 16, timestamp >> 8, timestamp & 255]
key = 165
for i in range(6):
    bytes[i] = ((bytes[i] ^ key) + i) % 256
    key = bytes[i]
checksum = base64_urlsafe(bytes) + machine_id
```

*Source: eisbaw/cursor_api_demo README*

### Authentication Token Storage

Tokens are read from Cursor's local SQLite database:

| Platform | Path |
|----------|------|
| Linux | `~/.config/Cursor/User/globalStorage/state.vscdb` |
| macOS | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |
| Windows | `%APPDATA%\Cursor\User\globalStorage\state.vscdb` |

Keys: `cursorAuth/accessToken`, `storage.serviceMachineId`

*Source: eisbaw/cursor_api_demo README*

### Protobuf Message Types

The `aiserver.v1` schema defines:

- **`GetChatRequest`** — Contains `ModelDetails` and `Conversation` (list of messages)
- **`ConversationMessage`** — Fields: `Text`, `Type` (e.g., `MESSAGE_TYPE_HUMAN`)
- **`ModelDetails`** — Field: `ModelName` (e.g., `"gpt-4"`, `"claude-4.5-opus-high-thinking"`)
- **`StreamChat`** — Returns streaming responses with chat content

*Source: everestmz/cursor-rpc*

### Available Model Names (via native protocol)

```
claude-4.5-opus-high-thinking
claude-4.5-opus-high
claude-4.5-sonnet-thinking
claude-4-sonnet
gpt-4o
gpt-5.1-codex
default   (server picks)
```

*Source: eisbaw/cursor_api_demo README*

---

## 2. System Prompt Structure

The system prompt is **static** (no user- or codebase-specific text). This is intentional for prompt caching — identical system prompts across requests allow Anthropic/OpenAI prompt cache hits, reducing cost and time-to-first-token.

*Source: Shrivu Shankar analysis, confirmed by TensorZero observations*

### Full Structure (captured March 2025, Agent mode)

```
You are a powerful agentic AI coding assistant, powered by {model_name}.
You operate in Cursor, the world's best IDE.
You are pair programming with a USER to solve their coding task.

<<communication>>
  - Be conversational but professional
  - Never lie or make up facts
  - Refrain from apologizing all the time
  - NEVER refer to tool names when speaking to the user
  - Before calling each tool, first explain to the user why
  - Use backticks for file, directory, function, class names in markdown
<</communication>>

<<tool_calling>>
  You have tools at your disposal to solve the coding task.
  Follow these rules regarding tool calls...
<</tool_calling>>

<<search_and_reading>>
  Bias towards NOT asking the user for help if you can find the answer yourself.
  If partially confident, gather more information before responding.
<</search_and_reading>>

<<making_code_changes>>
  NEVER output code to the USER directly.
  Use the edit_file tool with // ... existing code ... markers.
  "These edit codeblocks are also read by a less intelligent language model,
   colloquially called the apply model, to update the file."
  "You will not mention the apply model."
<</making_code_changes>>

<<debugging>>
  Only make code changes if certain you can solve the problem.
  Address the root cause instead of the symptoms.
  DO NOT loop more than 3 times on fixing linter errors.
<</debugging>>

<<calling_external_apis>>
  Use best suited external APIs and packages.
  DO NOT hardcode an API key.
<</calling_external_apis>>

<<user_info>>
  The user's OS version is {os_version}.
  The absolute path of the user's workspace is {workspace_path}.
  The user's shell is {shell_path}.
<</user_info>>
```

**Token count**: ~642 tokens for the system prompt.

*Source: TensorZero blog (full captured prompt), Shrivu Shankar gist, Roman Imankulov observation*

### Ask Mode vs Agent Mode

The system prompt differs between modes. Ask mode uses a shorter prompt without agent-specific tool instructions:

```
<<making_code_changes>>
  The user is likely just asking questions and not looking for edits.
  Only suggest edits if you are certain that the user is looking for edits.
  When the user is asking for edits to their code, output a simplified version
  of the code block that highlights the changes...
<</making_code_changes>>
```

*Source: TensorZero blog (Ask mode capture vs Agent mode capture)*

---

## 3. User Message Structure

Each user turn from Cursor consists of two user messages:

### Message 1: Custom Instructions

```xml
<<custom_instructions>>
  [Rules from Cursor Settings > "Rules for AI"]
  [Contents of .cursorrules file]

  <<available_instructions>>
    [List of .cursor/rules/ files — name + description only]
    rule-name: Rule description text
    another-rule: Another description
  <</available_instructions>>
<</custom_instructions>>
```

Rules from `.cursor/rules/` are **not** sent in full — only names and descriptions. The agent must call `fetch_rules(rule_names=[...])` to read full content.

*Source: Roman Imankulov "Under the Hood"*

### Message 2: User Query with Context

```xml
<<additional_data>>

  <<current_file>>
    Path: {active_file_path}
    Line: {cursor_line_number}
    Line Content: `{line_content}`
  <</current_file>>

  <<attached_files>>
    <<file_contents>>
      ```path={file_path}, lines={start}-{end}
      {full or partial file content}
      ```
    <</file_contents>>

    <<manually_added_selection>>
      ```path={file_path}, lines={start}-{end}
      {user-selected code}
      ```
    <</manually_added_selection>>
  <</attached_files>>

  <<linter_errors>>
    {active linter errors in open files}
  <</linter_errors>>

<</additional_data>>

<<user_query>>
  {what the user actually typed}
<</user_query>>
```

*Source: TensorZero blog (full captured user message), Roman Imankulov*

### Code Citation Format

Cursor instructs the model to cite code using this specific format:

````
```startLine:endLine:filepath
// code here
```
````

Example: `` ```12:15:app/components/Todo.tsx ``

*Source: TensorZero blog (captured system prompt)*

---

## 4. Agent Tools (Function Calling)

When in Agent mode, Cursor provides these tools to the LLM:

| Tool | Description | Notes |
|------|-------------|-------|
| `codebase_search` | Semantic search across indexed codebase | Uses vector embeddings |
| `read_file` | Read file contents or outline | "Ensure full context by reading more if necessary" |
| `run_terminal_cmd` | Execute shell commands | Manage shell states, handle background tasks |
| `list_dir` | List directory contents | For file structure exploration |
| `grep_search` | Ripgrep regex search | Capped at 50 matches |
| `edit_file` | Propose file edits | Uses `// ... existing code ...` markers |
| `file_search` | Fuzzy file path search | When partial path is known |
| `delete_file` | Delete a file | With safeguards against failures |
| `reapply` | Retry last edit | "Calls a smarter model to apply the last edit" |
| `fetch_rules` | Load cursor rules by name | Dynamic context discovery |
| `diff_history` | View recent file changes | Added/removed lines |

Most tools include a parameter like "One sentence explanation...why this command needs to be run" — a non-functional parameter that forces the LLM to reason about its tool call arguments before making them. This is a documented technique for improving tool call quality.

*Source: Roman Imankulov (full tool table), Shrivu Shankar (tool analysis)*

---

## 5. The Apply Model

Cursor uses a two-model architecture for code editing:

1. **Main model** (Claude/GPT, user-selected) — Plans the edit, produces a "semantic diff" with `// ... existing code ...` markers
2. **Apply model** (Cursor's proprietary fast model) — Takes the semantic diff, produces the actual file contents

The apply model:
- Runs at ~1000 tokens/second using speculative decoding (~13× faster than standard inference)
- Surpasses GPT-4 and GPT-4o performance on large code edits
- Operates in two stages internally: planning and applying
- Is referred to in the system prompt as "a less intelligent language model, colloquially called the apply model"
- The system prompt explicitly instructs the main model: "You will not mention the apply model"

The `reapply` tool exists to "call a smarter model to apply the last edit" — a dynamic upgrade path when the standard apply model produces incorrect results.

*Source: Cursor blog "Editing Files at 1000 Tokens per Second", Shrivu Shankar analysis*

### Implications

- Users cannot prompt or configure the apply model
- "Random comments" and "code deletions" often come from the apply model, not the main LLM
- The apply model is slower and more error-prone on large files (>500 lines)
- Linter feedback after apply is returned to the main model for self-correction

*Source: Shrivu Shankar "How Cursor Works"*

---

## 6. Cursor's Internal Model Hierarchy

| Model | Role | Speed | User access |
|-------|------|-------|-------------|
| User-selected (Claude, GPT, etc.) | Main reasoning, planning, tool calling | Standard | Selectable in UI |
| Apply model (proprietary) | Code diff application | ~1000 tok/s | Not configurable |
| cursor-small (proprietary) | Fast completions, Tab autocomplete | Fast | Unlimited access |

`cursor-small` is described as "not as smart as GPT-4, but significantly faster" with unlimited usage.

*Source: Cursor docs (models page), Shrivu Shankar analysis*

---

## 7. Semantic Codebase Search

Cursor indexes the entire repository for semantic search:

- Each file is embedded into a vector using an encoder LLM at index time
- At query time, another LLM re-ranks and filters results based on relevance
- Uses Merkle trees to avoid re-indexing unchanged files
- Source code is not stored on Cursor's servers (embeddings only)

*Source: Pragmatic Engineer newsletter, adityarohilla.com Cursor internals article*

---

## 8. Request Routing Architecture

All requests — including those from Override OpenAI Base URL — are routed through Cursor's backend servers:

```
Cursor IDE (Electron)
    │
    ├── CORS preflight (OPTIONS) ──▶ Direct to endpoint (from Electron)
    │
    └── Chat requests ──▶ Cursor Backend (api2.cursor.sh) ──▶ Your endpoint / LLM provider
```

The CORS preflight comes directly from the Electron app (local browser context). All subsequent chat requests are proxied through Cursor's backend servers.

This means:
- API keys are forwarded to Cursor's servers with each request (Cursor states they are not stored)
- Your endpoint must be publicly accessible (Cursor's servers must reach it)
- Cursor can collect data on inferences and codebase usage

*Source: TensorZero blog ("Cursor first sends a request to its own servers, where additional processing happens before making the LLM call"), forum discussion on "local mode"*

### CORS Requirements

The endpoint must handle CORS preflight correctly. Required response headers for `OPTIONS`:

```
Access-Control-Allow-Origin: {reflect request origin}
Access-Control-Allow-Credentials: true
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type
Access-Control-Max-Age: 86400
```

Return `204 No Content` for OPTIONS requests.

*Source: TensorZero blog (full nginx CORS configuration provided)*

---

## 9. Cursor Scale (as of 2025)

- 100× growth in a year
- 1M+ queries per second for the data layer
- Billions of code completions served daily
- "Anyrun" orchestrator (Rust service) handles cloud agents using Amazon EC2 + AWS Firecracker for process isolation

*Source: Pragmatic Engineer newsletter*
