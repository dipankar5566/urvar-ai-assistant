---
name: agent-routing
description: Use when asked which agent handles a query, why a message routed to a specific
  agent, how the orchestrator works, or when debugging unexpected routing behaviour.
  Do NOT use for actually running the bot or adding a new agent (use add-agent skill).
---

# Agent Routing

## Overview

Reference for the hub-and-spoke agent architecture — data flow, routing rules per query type, per-agent behaviour differences, token budgets, and the two-AI-service constraint. Use this to understand or debug how queries move through the system.

---

## When to Use

**Use this skill when:**
- "Why did my market question go to sales-marketing?"
- "Which agent should handle X type of query?"
- Debugging unexpected orchestrator routing decisions
- Understanding token limits or the two-AI constraint

**Do NOT use this skill when:**
- Adding a new agent (use `add-agent` skill)
- Running or restarting the bot
- Editing agent system prompts

---

## Core Pattern — Data Flow

```
Telegram user
    ↓
bot.js
  — command handlers (/start /help /clear /report)
  — getHistory(chatId)  →  last 20 messages
  — memory trigger      →  extractAndSaveMemories every 3 turns (non-blocking)
  — createTracker()     →  token usage per conversation
    ↓
orchestrator.js
  — Claude Sonnet 4.6, max_tokens: 1024
  — buildSystemBlocks(chatId)  →  SYSTEM_PROMPT + injected memories
  — cachedTools[]              →  5 tool definitions, last one cache-tagged
  — stop_reason === "tool_use" →  delegates to one specialist
    ↓
agents/*.js   (specialist — Claude Sonnet 4.6, max_tokens: 4096, agentic loop)
    ↓
tools/
  — web_search          →  Tavily API, 15s timeout, basic/advanced depth
  — query_knowledge_base →  OpenAI gpt-4o-mini, ephemeral assistant, file_search
```

---

## Quick Reference — Routing Table

| Query type | Agent called |
|-----------|-------------|
| Market size, trends, demand, customer segments, e-commerce dynamics | `market-research` |
| Competitors, pricing comparison, brand positioning, benchmarking | `competitive-analysis` |
| Social posts, emails, WhatsApp copy, product descriptions | `sales-marketing` |
| Farmer product Q&A, crop advice, dosage questions | `sales-marketing` |
| New products, R&D, formulations, certifications, agronomic science | `rd-product` |
| Finding distributors, retailers, nurseries, FPOs, outreach drafts | `lead-generation` |
| Greetings, direct Urvar facts ("What is Urvar?") | orchestrator answers directly — no tool call |

---

## Agent Behaviour Differences

| Agent | Pre-fetches product catalogue? | Tool search order |
|-------|-------------------------------|-------------------|
| `market-research` | No | `web_search` first |
| `competitive-analysis` | No | `web_search` first |
| `sales-marketing` | **Yes** — injects catalogue into system prompt before loop | `web_search` or KB as needed |
| `rd-product` | **Yes** — injects catalogue into system prompt before loop | `web_search` + KB |
| `lead-generation` | No | `query_knowledge_base` **first**, then `web_search` |

`sales-marketing` and `rd-product` pre-fetch the product catalogue from the KB before starting the agentic loop and inject it as a hardcoded fallback if the KB query fails. This enforces the product guardrail.

`lead-generation` system prompt explicitly says "Use query_knowledge_base FIRST to understand Urvar's product range and unique selling points" before any web search.

---

## Architecture Constraints

- **Claude (Anthropic)** = routing, reasoning, content generation — all specialist agents
- **OpenAI gpt-4o-mini** = RAG retrieval only, via Assistants API + `file_search` tool
- Never swap these roles

**Token budgets:**

| Call | max_tokens |
|------|-----------|
| Orchestrator routing call | 1024 |
| Orchestrator follow-up (after agent result) | 4096 |
| All specialist agents | 4096 |

**Prompt caching:**
- Orchestrator system prompt: cached via array of `{ type, text, cache_control }` blocks
- Orchestrator tools: last tool in `cachedTools[]` has `cache_control: { type: "ephemeral" }`
- Agents: system prompt is a plain string (not cached). Tool results on first loop iteration, last tool only are cached.

**Retries:** All `Anthropic()` clients use `maxRetries: 5` — do not lower.

---

## Examples

**Input:** "Write a Facebook post for our vermicompost"
**Expected routing:** `sales-marketing` (content creation)

**Input:** "What are competitors charging on Amazon for vermicompost?"
**Expected routing:** `competitive-analysis`

**Input:** "What is PROM and how does it work?"
**Expected routing:** `sales-marketing` (farmer product Q&A) — or orchestrator may answer directly if query is simple enough

**Edge case:** "What is Urvar?"
**Expected:** Orchestrator answers directly — no specialist called (matches the "General questions about Urvar or greetings → answer directly" rule in `SYSTEM_PROMPT`)

---

## Common Mistakes

| Mistake | Why it happens | Fix |
|---------|---------------|-----|
| Assuming orchestrator streams output | It doesn't — polls `stop_reason` | Use `createAndPoll` or check `stop_reason` |
| Expecting agents to see full conversation | Orchestrator passes empty `[]` history to agents | Agents only receive the delegated query string |
| Routing misfire (e.g. crop Q→ market-research) | LLM-based routing is probabilistic | Rephrase with more explicit keywords (e.g. "which Urvar product for...") |

---

## Dependencies

- `agents/orchestrator.js` — `SYSTEM_PROMPT` (routing rules text), `tools[]`, `cachedTools`, `buildSystemBlocks()`
- `agents/bot.js` — message entry, history cap (20 msgs), memory trigger (every 3 turns)
- `agents/memory.js` — `getMemories(chatId)` injected into orchestrator system blocks

---

## Notes / Limitations

- Routing is LLM-based — it reads the `SYSTEM_PROMPT` text to decide. If you add a new agent, you must update that text or routing will be unreliable.
- Orchestrator passes empty history `[]` to all specialists — agents have no memory of prior turns, only the current delegated query.
- The weekly scheduler (`scheduler.js`) calls `market-research` and `competitive-analysis` directly via `Promise.all()` — it bypasses the orchestrator entirely.
