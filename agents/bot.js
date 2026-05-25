import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import { runOrchestrator } from "./orchestrator.js";
import { createTracker, formatSummary } from "./tools/token-tracker.js";
import { getHistory, saveHistory, clearHistory } from "./db.js";
import { extractAndSaveMemories, clearMemories } from "./memory.js";
import { startScheduler, sendWeeklyReport } from "./scheduler.js";

dotenv.config();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN in .env");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
const turnCounters = new Map();
startScheduler(bot);

const WELCOME_MESSAGE = `👋 Welcome to *Urvar AI Assistant*!

I'm your intelligent business assistant for *Urvar Natural Pvt. Ltd.* — powered by a team of specialist AI agents.

*What I can help you with:*
📊 *Market Research* — market size, trends, customer segments, pricing
🔍 *Competitive Analysis* — competitor benchmarking, positioning, opportunities
✍️ *Sales & Marketing* — product copy, social posts, emails, WhatsApp messages
🔬 *R&D / Product Development* — formulations, new products, certifications
🎯 *Lead Generation* — find distributors, agri-retailers, nurseries & cooperatives to pitch — with outreach messages
📅 *Weekly Reports* — auto-sent every Monday at 9 AM | /report for instant briefing

*Commands:*
/start — Show this welcome message
/help — Show available capabilities
/clear — Reset conversation history
/report — Generate an instant business intelligence report

Just type your question and I'll route it to the right expert. Try:
_"Write an Instagram post for our vermicompost product"_
_"What new products should we develop?"_
_"Who are our top competitors in India?"_`;

const HELP_MESSAGE = `*Urvar AI Assistant — Help*

*Specialist Agents:*

📊 *Market Research Agent*
Ask about: market size, growth trends, demand patterns, customer segments, pricing benchmarks, Amazon/Flipkart dynamics, regulatory environment

🔍 *Competitive Analysis Agent*
Ask about: competitor profiles, competitor products & pricing, market gaps, differentiation strategy, benchmarking

✍️ *Sales & Marketing Agent*
Ask to: write product descriptions, Instagram/Facebook posts, WhatsApp messages, email campaigns, reply to customer queries, suggest promotions

🔬 *R&D / Product Development Agent*
Ask about: new product ideas, vermicompost formulations, NPK benchmarks, organic certifications (PGS-India, NPOP), crop-specific application rates, production improvements

🎯 *Lead Generation Agent*
Ask to: find distributors in a region, find nurseries or agri-retailers to pitch, discover Farmer Producer Organizations (FPOs), generate an outreach WhatsApp message or email for a lead type

📅 *Weekly Business Report*
/report — Instantly generate a market + competitive intelligence briefing
Auto-sends to the team group every Monday at 9:00 AM IST

*Tips:*
• Be specific — "write an Instagram post for farmers in Bengal" works better than "write a post"
• Ask follow-up questions — I remember context within the conversation
• Use /clear to reset history and memory

*Commands:* /start /help /clear /report`;

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  clearHistory(chatId);
  bot.sendMessage(chatId, WELCOME_MESSAGE, { parse_mode: "Markdown" });
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, HELP_MESSAGE, { parse_mode: "Markdown" });
});

bot.onText(/\/clear/, (msg) => {
  const chatId = msg.chat.id;
  clearHistory(chatId);
  clearMemories(chatId);
  bot.sendMessage(chatId, "✅ Conversation history and memory cleared. Start fresh!", { parse_mode: "Markdown" });
});

bot.onText(/\/report/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendChatAction(chatId, "typing");
  const typingInterval = setInterval(() => bot.sendChatAction(chatId, "typing"), 4000);
  try {
    await sendWeeklyReport(bot, chatId);
  } finally {
    clearInterval(typingInterval);
  }
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  // Ignore commands — handled above
  if (!text || text.startsWith("/")) return;

  // Show typing indicator
  bot.sendChatAction(chatId, "typing");
  const typingInterval = setInterval(() => bot.sendChatAction(chatId, "typing"), 4000);

  const history = getHistory(chatId);

  try {
    const tracker = createTracker();
    const reply = await runOrchestrator(text, history, chatId, tracker);

    // Update history with this exchange (without token summary)
    history.push({ role: "user", content: text });
    history.push({ role: "assistant", content: reply });

    // Keep last 20 messages to avoid token overflow
    if (history.length > 20) history.splice(0, history.length - 20);
    saveHistory(chatId, history);

    // Extract memorable facts every 3 turns (non-blocking)
    const turnCount = (turnCounters.get(chatId) || 0) + 1;
    turnCounters.set(chatId, turnCount);
    if (turnCount % 3 === 0) {
      extractAndSaveMemories(chatId, text, reply).catch(() => {});
    }

    clearInterval(typingInterval);

    // Append token usage summary before sending (not stored in history)
    const replyWithUsage = reply + formatSummary(tracker);

    // Telegram max message length is 4096 chars — split if needed
    if (replyWithUsage.length <= 4096) {
      await bot.sendMessage(chatId, replyWithUsage, { parse_mode: "Markdown" });
    } else {
      const chunks = splitMessage(replyWithUsage, 4096);
      for (const chunk of chunks) {
        await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
      }
    }
  } catch (err) {
    clearInterval(typingInterval);
    console.error("Error handling message:", err);
    const isOverloaded = err?.status === 529 || err?.error?.error?.type === "overloaded_error";
    await bot.sendMessage(
      chatId,
      isOverloaded
        ? "⏳ Claude is temporarily busy. Please try your message again in a few seconds."
        : "⚠️ Something went wrong while processing your request. Please try again.",
    );
  }
});

function splitMessage(text, maxLength) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxLength;
    if (end < text.length) {
      // Try to break at a newline for cleaner splits
      const lastNewline = text.lastIndexOf("\n", end);
      if (lastNewline > start) end = lastNewline + 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

console.log("🤖 Urvar AI Bot is running... (Ctrl+C to stop)");
