---
name: optimize-costs
description: Use when token costs are too high, the cache hit rate is low, you want
  to understand the token usage footer in Telegram replies, or you need to reduce
  API spend across Claude and OpenAI. Do NOT use for debugging runtime errors (use
  debug-bot skill).
---

# Optimize Costs

## Overview

Guide to reading the token summary footer, understanding the two-tier prompt caching strategy, and identifying the real cost hotspots — particularly the OpenAI KB pre-fetch pattern that runs 3 API calls per agent query.

---

## When to Use

**Use this skill when:**
- "Why is this bot so expensive to run?"
- "How do I read the token numbers at the bottom of replies?"
- "How do I improve cache hit rate?"
- "Which agent operations cost the most?"

**Do NOT use this skill when:**
- Debugging errors or outages (use `debug-bot` skill)
- Understanding routing behaviour (use `agent-routing` skill)

---

## Core Pattern — Reading the Token Footer

Every bot reply ends with:
```
🔢 1,234 in | 456 out | 789 cached
```

| Field | Meaning | Notes |
|-------|---------|-------|
| `in` | Input tokens billed this turn | System prompt + history + tool results |
| `out` | Output tokens billed this turn | All generated text from all agents |
| `cached` | Cache read tokens (free/discounted) | Only appears when `cache_read_input_tokens > 0` |

> **Silent field:** `cache_creation_input_tokens` (cost of writing to cache) is tracked internally but never shown in the footer. It appears on the first call after a cold start and is visible only in the Anthropic dashboard.

**Healthy vs unhealthy:**
- Healthy: `cached` is large relative to `in` — system prompt and tool results are being reused
- Unhealthy: no `cached` shown — cache is cold or not warming between turns

---

## Caching Strategy (two-tier)

| What is cached | Where | How |
|---------------|-------|-----|
| Orchestrator system prompt | `orchestrator.js:120-133` | Array of `{ type, text, cache_control: { type: "ephemeral" } }` blocks |
| Orchestrator tool definitions | `orchestrator.js:116-118` | `cachedTools[]` — last tool in the array gets `cache_control` |
| Agent tool results | All agents, `loopIteration === 0 && isLastTool` | Tool result wrapped as `[{ type: "text", text, cache_control }]` instead of plain string |
| Agent system prompts | — | **Not cached** — plain string in all specialist agents |

Cache TTL is approximately **5 minutes**. After that, the next call pays full input cost to warm the cache again.

---

## Cost Hotspots

| Operation | Cost driver | Frequency |
|-----------|------------|-----------|
| `lead-generation` queries | Spawns `sales-marketing` as a subagent after finding leads — runs two full agentic loops (its own + the subagent's). `sales-marketing` also runs its KB pre-fetch (3 OpenAI calls). Expect ~2× typical agent cost. | Every lead-gen query |
| KB pre-fetch in `sales-marketing` / `rd-product` | 3 OpenAI API calls per query: `assistants.create` → `threads.runs.createAndPoll` → `assistants.del` | Every query to either agent |
| `query_knowledge_base` tool call inside agentic loop | Same 3-call pattern — a fresh temporary assistant each time | Every time the agent decides to call KB |
| Long conversation history | `in` tokens grow with each turn (history capped at 20 msgs in `db.js`) | Gets expensive in long sessions |
| `search_depth: "advanced"` | Returns more content per result → larger tool result → more tokens | Only when agent requests it |
| Weekly scheduled reports | Calls market-research + competitive-analysis in `Promise.all()` with no tracker — costs invisible in Telegram | Every Monday 9 AM IST |

---

## Optimization Tips

**1. Cache warm-up takes a full turn**
Cache saves only appear from the second message onwards in a conversation. Very short one-off queries don't benefit. Longer sessions accumulate significant savings.

**2. Use `search_depth: "basic"` (already the default)**
`"advanced"` depth returns more content and costs more tokens in the tool result. Only change it for genuinely deep research tasks.

**3. Reduce `max_results`**
Default is 5. For simple lookups, 3 results is enough — fewer results = fewer tokens in the tool result. Change in `tools/web-search.js:6` or by passing `max_results: 3` when calling `webSearch`.

**4. KB pre-fetch cost in `sales-marketing` / `rd-product`**
These agents query the KB once before the agentic loop to fetch the product catalogue. This is 3 OpenAI API calls before the first user-facing work begins. If OpenAI costs are a concern, the hardcoded fallback catalogue (already in both agents) can replace the pre-fetch entirely — remove the try/catch block and set `const system = SYSTEM_PROMPT + hardcodedFallback` directly.

**5. Weekly reports have invisible cost**
`scheduler.js` calls agents without passing a `tracker` — usage is not counted in any Telegram footer. The true cost of weekly reports only appears in Anthropic and OpenAI dashboards.

**6. OpenAI assistant caching opportunity (not yet implemented)**
`knowledge-base.js` creates and deletes a temporary assistant on every single query. Reusing a persistent assistant ID would save 2 of the 3 API calls per KB query — a significant reduction if KB is queried frequently.

---

## Quick Reference

| To reduce cost | Action |
|----------------|--------|
| See full cost including OpenAI | Check Anthropic + OpenAI dashboards (footer is Claude-only) |
| Fewer Tavily tokens | Lower `max_results` from 5 to 3 |
| Avoid deep search cost | Keep `search_depth: "basic"` (default) |
| Remove KB pre-fetch overhead | Replace try/catch pre-fetch with hardcoded fallback in `sales-marketing.js` and `rd-product.js` |
| Warm cache faster | Keep conversations going — cache hits appear from turn 2 onward |

---

## Examples

**Input:** "I see `🔢 8,432 in | 612 out` with no `cached` — why?"

**Expected:** Cache is cold — either the first turn of a new conversation, or more than 5 minutes have passed since the last message. Cache will warm on the next turn. If `cached` never appears even mid-conversation, check that `cache_control` blocks are still present in `orchestrator.js` lines 116-118 and 120-133.

**Edge case:** "Costs spiked this week even though usage looks the same"

**Expected:** Check if `scheduler.js` ran successfully (weekly reports cost is invisible in footers). Also check if any queries went to `lead-generation` — each lead-gen query spawns a full `sales-marketing` subagent run, roughly doubling the per-query cost. Also check `sales-marketing` and `rd-product` traffic — those each run 3+ OpenAI calls per query due to the KB pre-fetch.

---

## Common Mistakes

| Mistake | Why it happens | Fix |
|---------|---------------|-----|
| Assuming `cached` = total cache size | `cached` = cache **reads** only; cache **writes** (`cache_creation_input_tokens`) are tracked but not shown | Check Anthropic dashboard for write costs |
| Expecting weekly report costs in footer | Scheduler passes no tracker | Check provider dashboards for Monday AM spend |
| Thinking OpenAI KB costs appear in the footer | Footer is Claude (Anthropic) only | OpenAI costs are separate — check OpenAI dashboard |
| Thinking cache is always on | Cache TTL is ~5 min — cold after idle | Keep sessions active or accept full input cost on first turn |

---

## Dependencies

- `agents/tools/token-tracker.js` — `formatSummary()` output format, 4 tracked fields
- `agents/tools/knowledge-base.js` — 3-call-per-query pattern, no `maxRetries` on OpenAI client
- `agents/orchestrator.js:116-118,120-133` — caching implementation
- `agents/agents/lead-generation.js:109-122` — subagent spawn pattern (calls `runSalesMarketingAgent` after loop)
- `agents/agents/sales-marketing.js:38-51` — KB pre-fetch pattern
- `agents/agents/rd-product.js:38-50` — KB pre-fetch pattern
- `agents/scheduler.js:40-43` — `Promise.all()` without tracker

---

## Notes / Limitations

- The OpenAI client in `knowledge-base.js` has **no** `maxRetries` — unlike Anthropic clients which use `maxRetries: 5`. OpenAI errors surface immediately.
- `cache_creation_input_tokens` is a real cost (writing to cache) that is tracked in `token-tracker.js` but intentionally omitted from the Telegram footer — visible only in the Anthropic dashboard
- Cache TTL is approximately 5 minutes — the exact value is controlled by Anthropic and may change
- The token footer accumulates across the full request (orchestrator + specialist agent + all tool calls) — a single Telegram reply may represent 10+ individual API calls
