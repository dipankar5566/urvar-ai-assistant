---
name: deploy
description: Use when deploying the bot to a new machine, restarting it in production,
  configuring PM2 for auto-start on reboot, or setting up the environment from scratch.
  Do NOT use for updating the knowledge base (use update-knowledge-base skill) or
  adding new agents (use add-agent skill).
---

# Deploy

## Overview

End-to-end deployment checklist — environment setup, PM2 config path fixes, first launch, and enabling auto-restart on system reboot. The main gotcha is that `ecosystem.config.cjs` currently has Windows paths that must be updated before first run.

---

## When to Use

**Use this skill when:**
- Deploying the bot to a new server or machine
- Setting up the bot after cloning the repo
- Configuring PM2 for 24/7 operation
- Restarting the bot after code or config changes

**Do NOT use this skill when:**
- Updating what the bot knows (use `update-knowledge-base` skill)
- Adding a new specialist agent (use `add-agent` skill)
- Debugging a running bot (use `debug-bot` skill)

---

## Core Pattern — Step-by-Step

### Step 1 — Install PM2 (if not already installed)

```bash
npm install -g pm2
```

---

### Step 2 — Fix paths in `ecosystem.config.cjs`

The file currently has Windows paths (`e:\AI Assistant\...`). Update to absolute paths for the target OS:

```js
module.exports = {
  apps: [{
    name: "urvar-bot",
    script: "bot.js",
    cwd: "/absolute/path/to/urvar-ai-assistant/agents",
    restart_delay: 5000,
    max_restarts: 20,
    watch: false,
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    out_file: "/absolute/path/to/logs/bot-out.log",
    error_file: "/absolute/path/to/logs/bot-error.log",
  }]
};
```

> **Why `.cjs`?** PM2 requires a CommonJS config file. The main `agents/` package uses `"type": "module"` (ESM), so the config must use the `.cjs` extension to opt out — do not rename it.

---

### Step 3 — Create the logs directory

```bash
mkdir -p /absolute/path/to/logs
```

---

### Step 4 — Set up environment variables

```bash
cd agents
cp .env.example .env
```

Edit `agents/.env` and fill in all 5 values:

| Variable | Where to get it |
|----------|----------------|
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `OPENAI_API_KEY` | platform.openai.com |
| `TAVILY_API_KEY` | app.tavily.com |
| `TELEGRAM_BOT_TOKEN` | @BotFather on Telegram |
| `TELEGRAM_GROUP_ID` | Send a message to your group, then call `getUpdates` on the bot token |

---

### Step 5 — Install dependencies

```bash
cd agents
npm install
```

The `data/` directory (`history.json`, `memories.json`) is auto-created on first run — no manual setup needed.

---

### Step 6 — Start with PM2

```bash
cd agents
pm2 start ecosystem.config.cjs
pm2 status   # confirm urvar-bot shows "online"
```

---

### Step 7 — Verify

Send `/start` to the bot in Telegram. It should reply with the welcome message within a few seconds.

---

### Step 8 — Enable auto-restart on reboot (recommended)

```bash
pm2 save        # saves the current process list
pm2 startup     # prints a shell command — copy and run it as root/sudo
```

---

## Quick Reference

| Task | Command |
|------|---------|
| Start bot | `pm2 start ecosystem.config.cjs` |
| Stop bot | `pm2 stop urvar-bot` |
| Restart bot | `pm2 restart urvar-bot` |
| View live status | `pm2 status` |
| Tail logs | `pm2 logs urvar-bot` |
| Errors only | `pm2 logs urvar-bot --err` |
| Save process list | `pm2 save` |
| Enable on reboot | `pm2 startup` → run printed command |

---

## Examples

**Input:** "Deploy the bot on a new Ubuntu server"

**Expected steps:**
1. `npm install -g pm2`
2. Clone repo, update `ecosystem.config.cjs` with Linux absolute paths
3. `mkdir -p /home/user/logs`
4. `cp agents/.env.example agents/.env` → fill all 5 keys
5. `cd agents && npm install`
6. `pm2 start ecosystem.config.cjs`
7. Send `/start` in Telegram → confirm reply
8. `pm2 save && pm2 startup` → run the printed command

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Leaving Windows paths in `ecosystem.config.cjs` | Update `cwd`, `out_file`, `error_file` to OS-correct absolute paths |
| Running `pm2 start` from wrong directory | Must be inside `agents/` or use the absolute `cwd` in the config |
| Forgetting `pm2 save` after first start | Without save, PM2 won't restore the process after a reboot |
| Renaming `ecosystem.config.cjs` to `.js` | PM2 needs CommonJS config in an ESM project — keep `.cjs` |
| Not creating the logs directory | PM2 will fail silently if `out_file`/`error_file` paths don't exist |

---

## Dependencies

- `agents/ecosystem.config.cjs` — PM2 config (paths must be updated, app name: `urvar-bot`)
- `agents/.env.example` → `agents/.env` — all 5 env vars required
- `agents/package.json` — `npm install` target (`"type": "module"`, entry: `bot.js`)

---

## Notes / Limitations

- `max_restarts: 20` — after 20 rapid crashes PM2 stops retrying. Fix the underlying error then `pm2 restart urvar-bot`
- `watch: false` — file watching is disabled. After code changes, run `pm2 restart urvar-bot` manually
- The RAG indexing package (`RAG/Open AI/`) has its own separate `package.json` — run `npm install` there too if re-indexing is needed on this machine
- `TELEGRAM_GROUP_ID` is optional — only needed for the automated weekly report (Monday 9 AM IST). The bot works without it.
