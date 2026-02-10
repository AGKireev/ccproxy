# Cursor IDE — Summarization & Context Management: External Facts

> **Scope**: Facts sourced exclusively from official Cursor documentation, blog posts, and changelogs. No speculation, no CCProxy test results.

---

## Sources

| Source | URL | Type |
|--------|-----|------|
| Cursor blog: Dynamic context discovery | https://cursor.com/blog/dynamic-context-discovery | Official (Jan 6, 2026) |
| Cursor changelog v1.6 | https://cursor.com/changelog/1-6 | Official (Sep 12, 2025) |
| Cursor docs: Summarization | https://docs.cursor.com/en/agent/chat/summarization | Official docs |
| Cursor docs: Models | https://docs.cursor.com/models | Official docs |
| Cursor learn: Context | https://cursor.com/learn/context | Official educational |
| Cursor blog: Instant Apply | https://cursor.com/blog/instant-apply | Official blog |

---

## 1. Automatic Summarization

### When it triggers

Cursor automatically summarizes long conversations **when the context window limit is reached**.

> "Cursor automatically summarizes long conversation for you when reaching the context window limit."

*Source: Cursor changelog v1.6 (September 2025)*

### What happens

When summarization is triggered:

1. The conversation history is compressed into a summary
2. The agent receives a fresh context window with the summary
3. The full chat history is preserved as a **file** that the agent can reference

> "When the model's context window fills up, Cursor triggers a summarization step to give the agent a fresh context window with a summary of its work so far."

*Source: Cursor blog "Dynamic context discovery" (January 2026)*

### Quality concerns

Summarization is described as "a lossy compression of context" where "the agent might have forgotten crucial details about its task."

*Source: Cursor blog "Dynamic context discovery"*

---

## 2. Manual Summarization (`/summarize`)

Introduced in Cursor v1.6 (September 2025):

> "You can now summarize context on-demand with the `/summarize` slash command. This can be useful when you don't want to create a new chat, but want to free up space in the context window."

*Source: Cursor changelog v1.6*

---

## 3. Chat History as Files (Recovery Mechanism)

After summarization, Cursor provides the agent with a reference to the full chat history as a file:

> "After the context window limit is reached, or the user decides to summarize manually, we give the agent a reference to the history file. If the agent knows that it needs more details that are missing from the summary, it can search through the history to recover them."

This means post-summarization, the agent can:
- Search the history file for missing details
- Use tools like `read_file` or `grep_search` on the history
- Recover crucial context that was lost in compression

*Source: Cursor blog "Dynamic context discovery"*

---

## 4. Dynamic Context Discovery (January 2026)

Cursor's official term for their token-efficiency strategy. Five specific techniques:

### 4.1 Long tool responses → files

Instead of including large tool responses (shell output, MCP results) directly in context:

> "The common approach coding agents take is to truncate long shell commands or MCP results. This can lead to data loss. In Cursor, we instead write the output to a file and give the agent the ability to read it. The agent calls `tail` to check the end, and then read more if it needs to."

**Result**: "Fewer unnecessary summarizations when reaching context limits."

*Source: Cursor blog "Dynamic context discovery"*

### 4.2 Chat history as reference during summarization

(Covered in section 3 above)

### 4.3 Agent Skills

Skills (`SKILL.md` files) include a name and description in static context. The agent discovers and loads relevant skills dynamically using tools like `grep` and semantic search.

*Source: Cursor blog "Dynamic context discovery"*

### 4.4 MCP tool descriptions → folders

MCP tool descriptions are synced to a folder. The agent receives only tool names in static context and looks up full descriptions on demand.

> "In an A/B test, we found that in runs that called an MCP tool, this strategy **reduced total agent tokens by 46.9%** (statistically significant, with high variance based on the number of MCPs installed)."

**Implementation detail**: One folder per MCP server. The agent can use `rg` parameters or `jq` to filter tool descriptions.

**Additional benefit**: The agent can communicate MCP status (e.g., "server needs re-authentication") proactively.

*Source: Cursor blog "Dynamic context discovery"*

### 4.5 Terminal sessions → files

Integrated terminal output is synced to the local filesystem:

> "This makes it easy to ask 'why did my command fail?' and allow the agent to understand what you're referencing. Since terminal history can be long, the agent can grep for only the relevant outputs."

> "This mirrors what CLI-based coding agents see, with prior shell output in context, but discovered dynamically rather than injected statically."

*Source: Cursor blog "Dynamic context discovery"*

---

## 5. Context Windows by Model

From Cursor's official docs (as of February 2026):

| Model | Default Context | Max Mode |
|-------|----------------|----------|
| Claude 4.5 Sonnet | 200K | 1M |
| Claude 4.6 Opus | 200K | 1M |
| Claude 4.6 Opus (Fast mode) | 200K | 1M |
| Composer 1 | 200K | — |
| Gemini 3 Flash | 200K | 1M |
| Gemini 3 Pro | 200K | 1M |
| GPT-5.2 | 272K | — |
| GPT-5.2 Codex | 272K | — |
| Grok Code | 256K | — |

**Default Context** is what Cursor uses normally. **Max Mode** enables the model's maximum context window (where available).

*Source: Cursor docs homepage model table (fetched February 2026)*

---

## 6. Agent Harness Optimization

Cursor optimizes its agent harness (instructions and tools) **individually for every new frontier model**:

> "Cursor's agent harness, the instructions and tools we provide the model, is optimized individually for every new frontier model we support."

Dynamic context discovery improvements apply across all models:

> "There are context engineering improvements we can make, such as how we gather context and optimize token usage over a long trajectory, that apply to all models inside our harness."

*Source: Cursor blog "Dynamic context discovery"*

---

## 7. Design Philosophy

Cursor's approach favors providing fewer details up front:

> "As models have become better as agents, we've found success by providing fewer details up front, making it easier for the agent to pull relevant context on its own."

The underlying primitive is **files**:

> "It's not clear if files will be the final interface for LLM-based tools. But as coding agents quickly improve, files have been a simple and powerful primitive to use, and a safer choice than yet another abstraction that can't fully account for the future."

*Source: Cursor blog "Dynamic context discovery"*

---

## 8. Prompt Caching

Cursor's system prompt is static (no user- or codebase-specific content) to take advantage of prompt caching:

> "The entire system prompt and tool descriptions are static (i.e. there's no user or codebase personalized text), this is so that Cursor can take full advantage of prompt caching for reduced costs and time-to-first-token latency. This is critical for agents which make an LLM call on every tool use."

*Source: Shrivu Shankar analysis (March 2025)*

---

## 9. Subagents (January 2026)

Cursor v2.4 introduced subagents — independent agents with their own context windows:

- Subagents run in parallel, specialized for discrete tasks
- Default subagents: codebase research, terminal commands, parallel work streams
- Custom subagents can be configured with custom prompts, tool access, and models
- Each subagent has its own context window (does not share with parent)

This is a form of context management: by delegating to subagents, the main agent's context window is not consumed by tool output from delegated tasks.

*Source: Cursor changelog (January 2026)*

---

## 10. What Is NOT Documented

The following aspects of Cursor's summarization are **not described** in any official or reverse-engineered source reviewed:

- Which specific model performs the summarization (the user-selected model? cursor-small? a dedicated model?)
- The exact token threshold at which auto-summarization triggers (a percentage of the context window? a fixed number?)
- Whether auto-summarization behaves differently for Override OpenAI Base URL connections vs native connections
- The prompt used internally for summarization
- Whether `/summarize` works when using Override OpenAI Base URL
- Whether summarization counts against usage limits or request quotas
- How summarization interacts with thinking/reasoning tokens
