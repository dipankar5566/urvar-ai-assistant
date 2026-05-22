import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import { runOrchestrator } from "./orchestrator.js";
import { getHistory, saveHistory, clearHistory } from "./db.js";
import { extractAndSaveMemories, clearMemories } from "./memory.js";

dotenv.config();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN in .env");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

const WELCOME_MESSAGE = `👋 Welcome to *Urvar AI Assistant*!

I'm your intelligent business assistant for *Urvar Natural Pvt. Ltd.* — powered by a team of specialist AI agents.

*What I can help you with:*
📊 *Market Research* — market size, trends, customer segments, pricing
🔍 *Competitive Analysis* — competitor benchmarking, positioning, opportunities

*Commands:*
/start — Show this welcome message
/help — Show available capabilities
/clear — Reset conversation history

Just type your question and I'll route it to the right expert. Try:
_"Who are the top vermicompost competitors in India?"_
_"What is the market size for organic fertilizer in India?"_`;

const HELP_MESSAGE = `*Urvar AI Assistant — Help*

*Specialist Agents:*

📊 *Market Research Agent*
Ask about: market size, growth trends, demand patterns, customer segments, pricing benchmarks, Amazon/Flipkart dynamics, regulatory environment

🔍 *Competitive Analysis Agent*
Ask about: competitor profiles, competitor products & pricing, market gaps, differentiation strategy, benchmarking

*Tips:*
• Be specific — "vermicompost competitors in West Bengal" works better than "competitors"
• Ask follow-up questions — I remember the conversation context
• Use /clear to start a fresh analysis

*Commands:* /start /help /clear`;

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
    const reply = await runOrchestrator(text, history, chatId);

    // Update history with this exchange
    history.push({ role: "user", content: text });
    history.push({ role: "assistant", content: reply });

    // Keep last 20 messages to avoid token overflow
    if (history.length > 20) history.splice(0, history.length - 20);
    saveHistory(chatId, history);

    // Extract and save memorable facts in the background (non-blocking)
    extractAndSaveMemories(chatId, text, reply).catch(() => {});

    clearInterval(typingInterval);

    // Telegram max message length is 4096 chars — split if needed
    if (reply.length <= 4096) {
      await bot.sendMessage(chatId, reply, { parse_mode: "Markdown" });
    } else {
      const chunks = splitMessage(reply, 4096);
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
