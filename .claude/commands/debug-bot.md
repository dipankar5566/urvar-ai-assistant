---
name: debug-bot
description: Use when the bot is down, returning errors, not responding, timing out,
  or behaving unexpectedly. Covers runtime error diagnosis for all error types:
  API overload, Tavily timeout, OpenAI KB failures, missing env vars, and PM2 crashes.
  Do NOT use for understanding agent routing or adding new agents.
---

# Debug Bot

## Overview

Diagnostic guide for runtime failures — maps each error type to its source file, exact error condition, user-visible message, and fix. Start with PM2 status, then narrow down by symptom.

---

## When to Use

**Use this skill when:**
- Bot sends "⏳ Claude is temporarily busy" or "⚠️ Something went wrong"
- Bot is not responding at all (no reply in Telegram)
- Web search silently fails or times out
- Knowledge base returns "No relevant information" unexpectedly
- PM2 process keeps restarting or shows errored state

**Do NOT use this skill when:**
- Query routed to the wrong agent (use `agent-routing` skill)
- Adding a new agent (use `add-agent` skill)
- Updating what the bot knows (use `update-knowledge-base` skill)

---

## Core Pattern — Error Map

| Error | Detected in | Condition | User sees | Fix |
|-------|------------|-----------|-----------|-----|
| Claude API overload | `bot.js:151` | `err?.status === 529` or `err?.error?.error?.type === "overloaded_error"` | "⏳ Claude is temporarily busy" | Retry; `maxRetries: 5` already handles transient spikes — message appears only after all 5 retries fail |
| Any other agent error | `bot.js:148-157` | all other throws | "⚠️ Something went wrong" | Check PM2 logs for full error |
| Tavily timeout | `tools/web-search.js:27` | `err.name === "AbortError"` after 15s | Agent error string in tool result | Check TAVILY_API_KEY; test Tavily API directly |
| Tavily API error | `tools/web-search.js:34` | `!response.ok` | `"Tavily API error ${status}: ..."` | Check API key validity and account quota |
| Missing TAVILY_API_KEY | `tools/web-search.js:7` | key is falsy | throws on first web search | Add key to `agents/.env` |
| Missing TELEGRAM_BOT_TOKEN | `bot.js:13` | key is falsy | `process.exit(1)` at startup — bot never starts | Add key to `agents/.env` |
| KB: vectorStoreId missing | `tools/knowledge-base.js:26` | `settings.json` unreadable or `vectorStoreId` absent | agent returns error string | Check `RAG/Open AI/settings.json` exists and has `vectorStoreId` |
| KB: OpenAI assistant create fails | `tools/knowledge-base.js:28` | OpenAI API error | agent returns `{ error: ... }` | Check OPENAI_API_KEY; verify OpenAI account quota |
| KB: assistant cleanup | `tools/knowledge-base.js:57` | `finally` block | silent | No action — `finally` always runs even on error |
| PM2 crash loop | `ecosystem.config.cjs` | `max_restarts: 20` exceeded | bot goes offline entirely | `pm2 logs urvar-bot --err` to find root cause; fix then `pm2 restart urvar-bot` |

---

## Quick Reference — Symptom → First Action

| Symptom | Most likely cause | First check |
|---------|------------------|-------------|
| "⏳ Claude is temporarily busy" | Anthropic 529 overload | Retry; check [status.anthropic.com](https://status.anthropic.com) |
| "⚠️ Something went wrong" | Any unhandled error | `pm2 logs urvar-bot --err` |
| Bot completely silent (no reply) | Polling crashed or PM2 down | `pm2 status` |
| Slow responses, agent returns no web data | Tavily timeout or bad key | Check TAVILY_API_KEY in `agents/.env` |
| Product/company questions return "No relevant information" | KB not indexed or wrong vectorStoreId | Run `/update-knowledge-base` skill |
| Bot never started after deploy | Missing env var | Check `agents/.env` has all 5 keys |
| Process restarts repeatedly | Uncaught exception at startup | `pm2 logs urvar-bot --err --lines 50` |

---

## PM2 Diagnostic Commands

```bash
pm2 status                        # is urvar-bot online / errored / stopped?
pm2 logs urvar-bot                # tail all logs (stdout + stderr)
pm2 logs urvar-bot --err          # stderr only — crashes and thrown errors
pm2 logs urvar-bot --lines 100    # last 100 lines of combined logs
pm2 restart urvar-bot             # restart after fixing the issue
pm2 stop urvar-bot                # clean stop
```

Log file locations are set in `agents/ecosystem.config.cjs` under `out_file` (stdout) and `error_file` (stderr). Update those paths from the Windows defaults before deploying.

---

## Examples

**Input:** "The bot just stopped responding to messages"

**Expected steps:**
1. `pm2 status` — check if `urvar-bot` shows `online`, `errored`, or `stopped`
2. If errored/stopped: `pm2 logs urvar-bot --err` — read the last exception
3. Fix the underlying cause (missing key, bad file path, API error)
4. `pm2 restart urvar-bot`
5. Send a test message in Telegram to confirm recovery

**Edge case:** "Bot replies to /start but not to regular messages"

Polling is alive but the message handler is throwing. The `/start` handler (`bot.onText`) is separate from the `bot.on("message")` handler. Check `pm2 logs urvar-bot --err` for errors thrown inside `runOrchestrator` or the agent calls.

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Assuming 529 means the bot is broken | It's transient overload — `maxRetries: 5` already retried 5 times; just wait and retry |
| Checking `out_file` log for errors | Errors go to `error_file` (stderr) — use `pm2 logs urvar-bot --err` |
| Restarting PM2 without fixing root cause | After `max_restarts: 20` PM2 stops retrying — fix first, then restart |

---

## Dependencies

- `agents/bot.js:13,148-157` — env check on startup, main error catch block
- `agents/tools/web-search.js:7,27,34` — Tavily error throw locations
- `agents/tools/knowledge-base.js:26,28,57` — KB error throws and `finally` cleanup
- `agents/ecosystem.config.cjs` — PM2 app name `urvar-bot`, `max_restarts: 20`, log paths

---

## Notes / Limitations

- `maxRetries: 5` is set on all Anthropic clients — the "temporarily busy" message only appears after all 5 retry attempts fail
- The OpenAI client in `knowledge-base.js` has **no** `maxRetries` — OpenAI errors surface immediately without retry
- `bot.js` calls `console.error("Error handling message:", err)` — the full error object is always in PM2 logs even when Telegram shows a generic message
