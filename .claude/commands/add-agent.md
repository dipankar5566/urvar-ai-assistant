---
name: add-agent
description: Use when asked to add a new specialist agent, create a new expert role,
  or extend the orchestrator with a new capability. Do NOT use for modifying an existing
  agent's system prompt, changing tool behaviour, or debugging routing.
---

# Add Agent

## Overview

Exact checklist for scaffolding a new specialist agent in the hub-and-spoke architecture. Covers file creation, the optional product-catalogue pre-fetch pattern, and the four required edits to `orchestrator.js`.

---

## When to Use

**Use this skill when:**
- "Add a customer support agent"
- "Create a new agent for finance / inventory / logistics"
- "Extend the bot with a new specialist capability"

**Do NOT use this skill when:**
- Modifying an existing agent's system prompt or tools
- Debugging why a query routed to the wrong agent (use `agent-routing` skill)

---

## Core Pattern — Step-by-Step

### Step 1 — Create the agent file

**Path:** `agents/agents/{kebab-name}.js`

```js
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { webSearch, webSearchToolDefinition } from "../tools/web-search.js";
import { queryKnowledgeBase, knowledgeBaseToolDefinition } from "../tools/knowledge-base.js";
import { addUsage } from "../tools/token-tracker.js";

dotenv.config();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 5 });

const SYSTEM_PROMPT = `...plain string, no cache_control blocks...`;
const tools = [webSearchToolDefinition, knowledgeBaseToolDefinition];

export async function run{Name}Agent(userMessage, history = [], tracker = null) {
  const messages = [...history, { role: "user", content: userMessage }];

  let response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,   // or `system` variable if using pre-fetch (Step 2)
    tools,
    messages,
  });
  addUsage(tracker, response.usage);

  let loopIteration = 0;
  while (response.stop_reason === "tool_use") {
    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
    const toolResults = [];

    for (const toolUse of toolUseBlocks) {
      let result;
      try {
        if (toolUse.name === "web_search") {
          result = await webSearch(toolUse.input);
        } else if (toolUse.name === "query_knowledge_base") {
          result = await queryKnowledgeBase(toolUse.input, tracker);
        } else {
          result = { error: `Unknown tool: ${toolUse.name}` };
        }
      } catch (err) {
        result = { error: err.message };
      }

      const resultText = typeof result === "string" ? result : JSON.stringify(result);
      const isLastTool = toolUseBlocks.indexOf(toolUse) === toolUseBlocks.length - 1;
      const shouldCache = loopIteration === 0 && isLastTool;

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: shouldCache
          ? [{ type: "text", text: resultText, cache_control: { type: "ephemeral" } }]
          : resultText,
      });
    }

    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });
    loopIteration++;

    response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });
    addUsage(tracker, response.usage);
  }

  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
```

> Copy the agentic loop from `agents/agents/market-research.js` — preserve `loopIteration`, `shouldCache`, and `isLastTool` exactly.

---

### Step 2 — (Conditional) Add product catalogue pre-fetch

**Only needed** if the agent gives product recommendations or farmer-facing advice (as `sales-marketing` and `rd-product` do). Place this block **before** the agentic loop, and replace the `system: SYSTEM_PROMPT` in both `messages.create` calls with `system`:

```js
let catalogueSection;
try {
  const catalogue = await queryKnowledgeBase(
    { query: "What products does Urvar Natural sell? List all product names and pack sizes." },
    tracker
  );
  const useful =
    catalogue &&
    !catalogue.includes("No relevant information") &&
    !catalogue.includes("No information found") &&
    catalogue.length > 80;
  catalogueSection = useful
    ? `\n\n## Urvar Product Catalogue (from knowledge base)\n${catalogue}\n\nYou may ONLY recommend Urvar products listed above. Never suggest products Urvar does not manufacture.`
    : `\n\n## Urvar Product Catalogue\nUrvar sells ONLY these 8 products: Enriched Vermicompost (5 kg), Cow Dung Manure/FYM (5 kg), PROM (50 kg), PROM Humic Based Flowering Booster (250 ml), PROM Humic Enriched (5 kg), Humic Acid Liquid Bio-Stimulant (1 L), Zinc EDTA 12% (250 g), Boron EDTA (250 g). You may ONLY recommend products from this list.`;
} catch {
  catalogueSection = `\n\n## Urvar Product Catalogue\nUrvar sells ONLY these 8 products: Enriched Vermicompost (5 kg), Cow Dung Manure/FYM (5 kg), PROM (50 kg), PROM Humic Based Flowering Booster (250 ml), PROM Humic Enriched (5 kg), Humic Acid Liquid Bio-Stimulant (1 L), Zinc EDTA 12% (250 g), Boron EDTA (250 g). You may ONLY recommend products from this list.`;
}
const system = SYSTEM_PROMPT + catalogueSection;
```

**Skip this step** for market research, competitive analysis, or lead generation agents.

---

### Step 3 — Register in `orchestrator.js` (4 exact edits)

**Edit 1 — Add import at top:**
```js
import { run{Name}Agent } from "./agents/{kebab-name}.js";
```

**Edit 2 — Add tool definition to `tools[]` array:**
```js
{
  name: "call_{snake_name}_agent",
  description: "Delegate to the {Name} specialist agent. Use for [describe when].",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The full question or task to hand off." },
    },
    required: ["query"],
  },
},
```

**Edit 3 — Add routing rule line to `SYSTEM_PROMPT`:**
```
- [Describe query type] → call_{snake_name}_agent
```

**Edit 4 — Add dispatch branch in the tool loop:**
```js
} else if (toolUse.name === "call_{snake_name}_agent") {
  result = await run{Name}Agent(toolUse.input.query, [], tracker);
}
```

> `cachedTools` is auto-derived from `tools` — no edit needed. Note: adding a tool shifts the cache tag to the new last item.

---

## Quick Reference

| Scenario | Action |
|----------|--------|
| Agent gives product / farmer advice | Add pre-fetch (Step 2) |
| Agent does market / competitor research | Skip pre-fetch |
| Agent finds B2B leads | Skip pre-fetch; add "Use query_knowledge_base FIRST" to system prompt |

---

## Examples

**Input:** "Add a customer support agent that handles complaints and returns"

**Expected:**
- Create `agents/agents/customer-support.js` with pre-fetch (customer-facing product content)
- System prompt: handles complaints, returns, negative reviews, support escalations
- Register with `call_customer_support_agent`
- Routing rule: "customer complaints, returns, support tickets, negative reviews → call_customer_support_agent"

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Forgetting `maxRetries: 5` | Always include on every `new Anthropic({...})` |
| Using a default export | Named export only — `export async function run{Name}Agent` |
| Caching the system prompt inside the agent | Only `orchestrator.js` does this — agents use plain string |
| Not updating `SYSTEM_PROMPT` in orchestrator | Routing is LLM-based; the description text determines when tool is called |
| Adding pre-fetch for a non-product agent | Only add when agent gives farmer/customer-facing product advice |
| Hardcoding `system: SYSTEM_PROMPT` after adding pre-fetch | Change both `messages.create` calls to use `system` (the concatenated variable) |

---

## Dependencies

- `agents/agents/market-research.js` — copy agentic loop from here (reference implementation)
- `agents/orchestrator.js` — 4 edits required (import, tool def, system prompt line, dispatch branch)
- `agents/tools/web-search.js` — `webSearch`, `webSearchToolDefinition`
- `agents/tools/knowledge-base.js` — `queryKnowledgeBase`, `knowledgeBaseToolDefinition`
- `agents/tools/token-tracker.js` — `addUsage`

---

## Notes / Limitations

- Orchestrator passes empty history `[]` to all agents — new agents will not see prior conversation turns
- The `cachedTools` array always tags the **last** tool — adding a sixth agent tool shifts the cache tag away from lead-generation to the new tool
- Agent system prompts are plain strings — do not add `cache_control` blocks to them (only orchestrator does this)
