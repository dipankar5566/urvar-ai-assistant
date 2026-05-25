---
name: update-knowledge-base
description: Use when asked to update what the bot knows, edit product info, add new
  documentation, or re-index the knowledge base. Do NOT use for querying the KB at
  runtime or changing how knowledge-base.js works in code.
---

# Update Knowledge Base

## Overview

Step-by-step workflow for editing source docs in `RAG/docs/` and re-uploading them to the OpenAI vector store so the bot reflects the changes at runtime.

---

## When to Use

**Use this skill when:**
- "Update the pricing info the bot knows"
- "Add a new document to the knowledge base"
- "The bot is giving outdated or wrong product info"
- "Re-index the knowledge base after editing docs"

**Do NOT use this skill when:**
- Querying what the KB currently contains (ask the bot directly)
- Changing how `agents/tools/knowledge-base.js` queries the vector store (that's a code change)

---

## Core Pattern — Step-by-Step

### Step 1 — Edit the source document

All knowledge base source files live in `RAG/docs/`:

| File | Contains |
|------|---------|
| `company.md` | Company profile, mission, vision, certifications, regulatory context |
| `products.md` | Full product specs, nutrient analysis, application rates, storage |
| `pricing.md` | Pricing template (MRP, Amazon, Flipkart, wholesale) |
| `customers.md` | Customer segments, seasonal patterns, FAQs |
| `crop-guide.md` | Crop-specific programs, deficiency symptom tables, dosages |
| `urvar-summary.md` | Executive overview of the company and product range |

Edit the relevant file(s) in your editor. These are plain markdown — no special format required.

---

### Step 2 — (Only if adding a new file) Update `settings.json`

**Path:** `RAG/Open AI/settings.json`

Add an entry to the `files[]` array:
```json
{ "filePath": "/absolute/path/to/RAG/docs/new-doc.md" }
```

> **Warning:** The existing entries in `settings.json` use Windows paths (`E:\AI Assistant\RAG\docs\...`). Before running the indexer, update **all** paths to the correct absolute path for the current OS. On macOS the path will look like `/Users/dipankarchanda/Urvar/ai/urvar-ai-assistant/RAG/docs/filename.md`.

Skip this step if you only edited an existing file.

---

### Step 3 — Re-index

```bash
cd "RAG/Open AI"

# First time only — copy env and install deps:
cp .env.example .env    # then add your OPENAI_API_KEY to .env
npm install

# Every subsequent time:
npm start
```

Watch the console for:
```
Uploaded file to vector store: <path> -> { id: 'file-...', ... }
```

Any error here means the file was not indexed — check the path, API key, and file content.

---

### Step 4 — Verify

No bot restart needed — the vector store is live immediately after indexing.

Test by sending the bot a question that should reflect the updated content. If the answer is still stale, wait 30 seconds and retry (OpenAI vector store propagation can take a moment).

---

## Quick Reference

| Situation | Action |
|-----------|--------|
| Edit existing doc | Edit file → `npm start` from `RAG/Open AI/` |
| Add new doc | Create file + add to `settings.json` files[] → `npm start` |
| Check what vector stores exist | Uncomment `get()` call in `vector-store.js`, run once, then re-comment |
| Re-create the vector store from scratch | Uncomment `create()` in `vector-store.js`, run once, update `vectorStoreId` in `settings.json` |
| Bot still hallucinating a product after re-index | Also check hardcoded fallback in `agents/agents/sales-marketing.js` and `rd-product.js` — update those strings too |

---

## Examples

**Input:** "Update the pricing info in the bot"

**Expected steps:**
1. Edit `RAG/docs/pricing.md` with correct MRP / wholesale prices
2. Run `cd "RAG/Open AI" && npm start`
3. Confirm upload log shows no errors
4. Test: ask the bot "what is the price of vermicompost?"

**Edge case:** "The bot mentioned a product called 'BioMax' that we don't sell"

**Expected:**
The hallucination may come from two places:
1. Stale vector store — re-index after verifying `RAG/docs/products.md` has the correct list
2. Hardcoded fallback strings in `agents/agents/sales-marketing.js` (line ~47) and `rd-product.js` (line ~46) — update those 8-product strings if they're wrong

---

## Common Mistakes

| Mistake | Why it happens | Fix |
|---------|---------------|-----|
| Edit docs but bot still gives old answer | Forgot to re-index | Run `npm start` from `RAG/Open AI/` |
| `npm start` fails with "file not found" | Path in `settings.json` is wrong (Windows path on macOS) | Update file paths to current OS absolute paths |
| Running `npm start` from repo root | Wrong working directory | Must `cd "RAG/Open AI"` first |
| Expecting restart needed after indexing | No restart needed | Changes are live immediately after `npm start` completes |
| Re-indexing but hallucination persists | Hardcoded fallback not updated | Also update fallback strings in `sales-marketing.js` and `rd-product.js` |

---

## Dependencies

- `RAG/Open AI/settings.json` — `vectorStoreId` + `files[]` array
- `RAG/Open AI/vector-store.js` — indexing script (`indexFiles()` is the active function)
- `RAG/Open AI/.env` — needs `OPENAI_API_KEY`
- `agents/tools/knowledge-base.js` — reads `vectorStoreId` from `settings.json` at query time

---

## Notes / Limitations

- `vectorStoreId` (`vs_694fef409cb48191ae994fefb67b1b97`) is the live production store — `npm start` adds/updates files in it without recreating it
- Deleting a file from the vector store is not handled by `vector-store.js` — use the OpenAI dashboard or write a custom script calling `openai.vectorStores.files.del()`
- The `knowledge-base.js` tool creates a temporary `gpt-4o-mini` assistant per query and deletes it immediately — there is no persistent assistant to update
- The RAG package (`RAG/Open AI/`) has its own `package.json` and `node_modules` — it is separate from the main `agents/` package
