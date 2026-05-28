# Urvar AI Assistant — Codebase Guide

## Repo Map

```
urvar-ai-assistant/
├── agents/                    ← Main runtime package (Node.js, ESM)
│   ├── bot.js                 ← Entry point: Telegram bot + command handlers
│   ├── orchestrator.js        ← Central router (Claude Sonnet) → delegates to specialists
│   ├── scheduler.js           ← node-cron weekly report (Mon 9 AM IST)
│   ├── memory.js              ← Long-term fact extraction per chat (Claude Haiku)
│   ├── db.js                  ← Per-chat conversation history (JSON file store)
│   ├── agents/                ← Six specialist agents (each: agentic loop + 2 tools)
│   │   ├── market-research.js
│   │   ├── competitive-analysis.js
│   │   ├── sales-marketing.js
│   │   ├── rd-product.js
│   │   ├── lead-generation.js     ← finds B2B prospects; spawns sales-marketing subagent for outreach copy
│   │   └── crop-doctor.js         ← photo-based crop disease diagnosis; called directly from bot.js (bypasses orchestrator)
│   ├── tools/                 ← Shared tool modules
│   │   ├── web-search.js      ← Tavily API wrapper (15s timeout)
│   │   ├── knowledge-base.js  ← OpenAI vector store query (file_search)
│   │   ├── token-tracker.js   ← Token usage accumulation across agent calls
│   │   ├── image-optimizer.js ← sharp-based image pre-processing (resize, denoise, contrast, color variants, augmentation) used by crop-doctor
│   │   └── crop-classifier.js ← TF.js MobileNetV2 inference on 63-class model (PlantVillage + Beans + Cassava + FiveCrop); gracefully skips if model not trained
│   ├── data/                  ← Runtime state — git-ignored, auto-created on first run
│   │   ├── history.json       ← Conversation history by chatId
│   │   └── memories.json      ← Long-term extracted facts by chatId
│   ├── ecosystem.config.cjs   ← PM2 config (update OS paths before deploying)
│   ├── .env.example
│   └── package.json
├── .claude/
│   ├── settings.json          ← Hook configuration (syntax check + credential guard)
│   ├── hooks/                 ← Hook scripts
│   │   ├── check-syntax.sh    ← node --check after JS edits
│   │   └── guard-credentials.sh ← blocks git commit if API keys detected
│   └── commands/              ← Claude Code slash commands (invoke with / in chat)
│       ├── urvar-product-advisor.md   ← Product catalogue, crop guide, guardrail
│       ├── agent-routing.md           ← Data flow, routing table, per-agent behaviour
│       ├── add-agent.md               ← Scaffolding checklist for new specialists
│       ├── update-knowledge-base.md   ← Re-indexing workflow
│       ├── debug-bot.md               ← Runtime error diagnosis and PM2 commands
│       ├── deploy.md                  ← End-to-end deployment checklist
│       └── optimize-costs.md          ← Token footer, caching strategy, cost hotspots
├── ml/                        ← Python ML training pipeline (run once to produce the TF.js model)
│   ├── train.py               ← Loads 4 datasets (PlantVillage, Beans, Cassava, FiveCrop), trains MobileNetV2, exports TF.js graph model
│   ├── requirements.txt       ← tensorflow, tensorflow-datasets, tensorflowjs
│   ├── labels.json            ← 63-class index → human-readable disease name (committed; overwritten by train.py)
│   ├── venv/                  ← git-ignored; Python virtual environment
│   ├── train.log              ← git-ignored; output of last training run
│   └── models/                ← git-ignored; populated after running train.py
│       ├── plant_village_saved_model/  ← Keras SavedModel (intermediate)
│       └── tfjs_crop_classifier/      ← TF.js graph model loaded by crop-classifier.js
└── RAG/
    ├── docs/                  ← Knowledge base source files — edit these to update bot knowledge
    │   ├── company.md
    │   ├── products.md
    │   ├── pricing.md
    │   ├── customers.md
    │   ├── crop-guide.md
    │   └── urvar-summary.md
    └── Open AI/               ← Vector store indexing scripts (run once after editing docs)
        ├── vector-store.js    ← Uploads docs → OpenAI vector store
        ├── settings.json      ← vectorStoreId + file paths to index
        └── .env.example
```

---

## Architecture

### Overview: Hub-and-Spoke

```
Telegram user
     ↓
  bot.js          (entry point — handles commands, history, memory, Telegram limits)
     ↓
orchestrator.js   (Claude Sonnet with tool_use — routes to one specialist per query)
     ↓
agents/*.js       (six specialists — each runs an agentic loop with web_search + query_knowledge_base; crop-doctor also accepts image data)
     ↓
tools/*.js        (Tavily web search  |  OpenAI RAG knowledge base  |  sharp image optimizer  |  TF.js CNN classifier for crop-doctor)
```

### Rules

**Routing**: The orchestrator receives every user message. It uses `claude-sonnet-4-6` with 5 tool definitions (one per specialist) to decide who handles it. If the query is a simple greeting or direct question about Urvar, the orchestrator answers without calling a specialist. Never call a specialist agent directly from `bot.js`. Agents may call other agents internally as subagents (e.g. `lead-generation.js` spawns `runSalesMarketingAgent` after finding leads).

**Agentic loops**: Every specialist agent loops `while (response.stop_reason === "tool_use")`, appending tool results and re-submitting to the API. Do not break this loop early or short-circuit it with a turn cap.

**Two AI services**: Claude (Anthropic SDK) handles all reasoning, routing, and content generation. OpenAI handles RAG via the Assistants API + file_search tool. Do not use OpenAI for reasoning or Claude for vector search.

**Token budgets**:
- Orchestrator initial routing call: `max_tokens: 1024`
- Orchestrator follow-up (after receiving agent result): `max_tokens: 4096`
- All specialist agents: `max_tokens: 4096`

**Retries**: All `Anthropic()` clients use `maxRetries: 5`. Do not lower this — API 529 overload errors are common in production.

### Prompt Caching (two-tier)

**Orchestrator system prompt** — array of cache-control blocks:
```js
[
  { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
  { type: "text", text: memoryText }   // only when memories exist
]
```
Tool definitions array has `cache_control: { type: "ephemeral" }` on the last tool only (`cachedTools`).

**Specialist agents** — system prompt is a plain string (not cached). Tool results are cached on the **first loop iteration (`loopIteration === 0`) and only on the last tool in that batch** (`isLastTool`):
```js
const shouldCache = loopIteration === 0 && isLastTool;
toolResults.push({
  type: "tool_result",
  tool_use_id: toolUse.id,
  content: shouldCache
    ? [{ type: "text", text: resultText, cache_control: { type: "ephemeral" } }]
    : resultText,
});
```
Do not change this caching strategy without understanding the token cost implications.

### Memory System

- Every 3 turns, `extractAndSaveMemories()` is called non-blocking (`.catch(() => {})`)
- Uses `claude-haiku-4-5-20251001` to extract business-relevant facts as a JSON array
- Assistant reply is truncated to 1000 chars before sending to Haiku
- Max 100 memories per chatId; oldest are evicted first
- `/clear` command wipes **both** history and memories for that chatId
- The orchestrator injects memories into its system prompt as an extra text block

### Conversation History

- `db.js` stores the last **20 messages** per chatId in `data/history.json`
- `data/` and `history.json` are auto-created on first run — no manual setup needed
- Do not increase the 20-message cap without profiling token cost

### Telegram Message Splitting

Telegram has a 4096-character message limit. `splitMessage()` breaks at the last newline within the limit for clean splits. This function is **duplicated** in `bot.js` and `scheduler.js` — known tech debt. If you need to touch it, consolidate into a shared utility rather than adding a third copy.

### Scheduler

- Runs market-research and competitive-analysis agents in `Promise.all()` every Monday at 9 AM IST
- No token tracker is passed for scheduled reports — usage is not counted there
- Only those two agents are called for weekly reports; all five are available via chat

---

## Naming Conventions

| Scope | Convention | Example |
|-------|-----------|---------|
| Files | kebab-case | `market-research.js`, `token-tracker.js` |
| Exported functions | camelCase verb | `runMarketResearchAgent()`, `webSearch()` |
| Tool definition objects | camelCase + `ToolDefinition` suffix | `webSearchToolDefinition` |
| Tool names in Claude schema | snake_case | `call_market_research_agent`, `web_search` |
| Module-level constants | UPPER_SNAKE_CASE | `SYSTEM_PROMPT`, `MARKET_PROMPT` |
| Local / instance vars | camelCase | `chatId`, `loopIteration`, `tracker` |
| Agent entry functions | `run{AgentName}Agent(userMessage, history, tracker)` | `runLeadGenerationAgent(...)` |

All files use **named exports only** — no default exports in this codebase. Import order convention: SDK imports → standard library → npm packages → local modules.

---

## Adding a New Specialist Agent

1. Create `agents/agents/{name}.js` — export `run{Name}Agent(userMessage, history = [], tracker = null)`
2. Copy the agentic loop structure from any existing agent (e.g. `market-research.js`)
3. Import `webSearchToolDefinition` and `knowledgeBaseToolDefinition` from `../tools/`
4. In `orchestrator.js`:
   - Add the import at the top
   - Add a new tool definition object to the `tools` array with `name: "call_{name}_agent"`
   - Add an `else if (toolUse.name === "call_{name}_agent")` branch in the dispatch loop
   - Add routing guidance to `SYSTEM_PROMPT`
5. `cachedTools` is derived from `tools` automatically — no extra step needed

---

## Knowledge Base

- **Source of truth**: `RAG/docs/*.md` — edit these files to update what the bot knows about Urvar products, pricing, customers, and crops
- **Re-indexing**: After editing any doc, update file paths in `RAG/Open AI/settings.json` (note: paths were originally Windows paths — update to your OS), then run:
  ```
  cd "RAG/Open AI" && npm start
  ```
- **Vector store ID** is stored in `RAG/Open AI/settings.json` under `vectorStoreId` — `knowledge-base.js` reads it at runtime. Do not hardcode it in agent files.
- The `knowledge-base.js` tool creates a temporary `gpt-4o-mini` assistant per query and deletes it in `finally` — stateless by design.

---

## Environment Variables

Copy `agents/.env.example` → `agents/.env` before running.

| Variable | Required | Used in |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` | Yes | All agents, orchestrator, memory |
| `OPENAI_API_KEY` | Yes | `tools/knowledge-base.js`, `RAG/Open AI/vector-store.js` |
| `TAVILY_API_KEY` | Yes | `tools/web-search.js` |
| `TELEGRAM_BOT_TOKEN` | Yes | `bot.js` |
| `TELEGRAM_GROUP_ID` | Optional | `scheduler.js` (auto weekly reports) |

The RAG package (`RAG/Open AI/`) has its own `.env.example` with only `OPENAI_API_KEY` needed.

---

## Models in Use

| Model | File | Purpose |
|-------|------|---------|
| `claude-sonnet-4-6` | `orchestrator.js` + all 5 agents | Routing, reasoning, content generation |
| `claude-haiku-4-5-20251001` | `memory.js` | Cheap fact extraction from conversation turns |
| `gpt-4o-mini` | `tools/knowledge-base.js` | RAG retrieval from OpenAI vector store |

---

## Slash Commands (Skills)

Seven Claude Code slash commands live in `.claude/commands/`. Type `/` in Claude Code chat to invoke any of them.

| Command | Use it when |
|---------|-------------|
| `/urvar-product-advisor` | Answering product questions, dosage, crop advice, or writing farmer-facing content |
| `/agent-routing` | Debugging routing decisions or understanding which agent handles what |
| `/add-agent` | Scaffolding a new specialist agent end-to-end |
| `/update-knowledge-base` | Editing `RAG/docs/` and re-indexing the OpenAI vector store |
| `/debug-bot` | Bot is down, returning errors, or PM2 keeps restarting |
| `/deploy` | Deploying to a new machine or setting up PM2 from scratch |
| `/optimize-costs` | Token costs are high, cache hit rate is low, or reading the token footer |

---

## Hooks

Two Claude Code hooks run automatically during sessions (configured in `.claude/settings.json`):

| Event | Trigger | What it does |
|-------|---------|-------------|
| `PostToolUse` | `Edit` or `Write` on a `.js` file | Runs `node --check` — exits non-zero if syntax is invalid so Claude self-corrects |
| `PreToolUse` | `Bash` command containing `git commit` | Scans staged diff for credential patterns (Tavily, Telegram, Anthropic, OpenAI keys) — blocks commit if found |

Both hooks fail open (exit 0) if `jq` is not installed. Install via `brew install jq`.

---

## Running Locally

```bash
cd agents
cp .env.example .env   # fill in API keys
npm install
node bot.js
```

Exercise all routing paths manually:
- Market query → should call `market-research` agent
- Competitor question → should call `competitive-analysis` agent
- "Write an Instagram post" → should call `sales-marketing` agent
- Crop product advice → should also route to `sales-marketing`
- R&D / formulation question → should call `rd-product` agent
- "Find distributors in Kolkata" → should call `lead-generation` agent
- "Hi, what is Urvar?" → orchestrator should answer directly without calling a specialist

Test the scheduler manually:
```
/report   (in Telegram chat)
```

## ML Training Pipeline

Run once to produce the TF.js model used by `crop-classifier.js`. Requires Python 3.10+.

```bash
cd ml
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
python3 train.py                # downloads datasets, trains 63-class model, exports TF.js
```

**Datasets used (63 classes total):**
| Dataset | Source | Classes |
|---------|--------|---------|
| PlantVillage | TF Datasets (`plant_village`) | 38 (indices 0–37) |
| Beans | TF Datasets (`beans`) | 3 (indices 38–40) |
| Cassava | TF Datasets (`cassava`) | 5 (indices 41–45) |
| FiveCrop (Rice/Wheat/Corn/Potato/Sugarcane) | Kaggle `shubham2703/five-crop-diseases-dataset` → `ml/data/` (git-ignored) | 17 (indices 46–62) |

The FiveCrop dataset must be downloaded manually before training:
```bash
pip install kaggle
kaggle datasets download -d shubham2703/five-crop-diseases-dataset -p ml/data/five-crop-diseases --unzip
```

Outputs written to `ml/models/` (git-ignored). After training, the bot automatically uses the model — no config change needed. If `ml/models/tfjs_crop_classifier/` is absent, `crop-classifier.js` skips inference and crop-doctor falls back to vision-only diagnosis.

The current committed model was trained on PlantVillage only (38 classes, 97.74% val accuracy). Re-run `train.py` to upgrade to 63 classes — back up `ml/models/tfjs_crop_classifier/` first if needed.

To verify datasets load correctly before a full training run:

```python
import tensorflow_datasets as tfds
ds, info = tfds.load("plant_village", split="train[:1%]", as_supervised=True, with_info=True)
print(len(info.features["label"].names), "classes")
for img, label in ds.take(1):
    print(img.shape, info.features["label"].names[label.numpy()])
```

---

## PM2 / Production

`ecosystem.config.cjs` uses `.cjs` extension intentionally — PM2 requires CommonJS config even in ESM projects.

Paths in `ecosystem.config.cjs` are set to macOS paths for this machine. Update `cwd`, `out_file`, and `error_file` when deploying to a different machine.

```bash
npx pm2 start ecosystem.config.cjs
npx pm2 logs urvar-bot
```
