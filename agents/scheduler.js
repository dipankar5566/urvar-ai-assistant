import cron from "node-cron";
import { runMarketResearchAgent } from "./agents/market-research.js";
import { runCompetitiveAnalysisAgent } from "./agents/competitive-analysis.js";

const MARKET_PROMPT = `Provide a weekly market intelligence briefing for Urvar Natural Pvt. Ltd., a bio-fertilizer and vermicompost manufacturer in Kolkata. Cover:
1. Latest news and trends in the Indian organic fertilizer and bio-fertilizer market this week
2. Any regulatory or policy updates relevant to organic farming in India (PM-KISAN, PKVY, state subsidies)
3. Pricing trends on Amazon India and Flipkart for vermicompost and bio-fertilizers
4. Key growth opportunities a small manufacturer in West Bengal should act on
Keep it concise and actionable.`;

const COMPETITIVE_PROMPT = `Provide a weekly competitive intelligence briefing for Urvar Natural Pvt. Ltd., a bio-fertilizer and vermicompost manufacturer in Kolkata. Cover:
1. Any competitor updates, new product launches, or pricing changes on Amazon India and Flipkart in the vermicompost and bio-fertilizer category
2. Competitor marketing or promotional activity spotted this week
3. Market gaps or weaknesses in competitor offerings that Urvar can exploit
4. Top 3 actionable competitive insights for the week
Keep it concise and actionable.`;

export function startScheduler(bot) {
  // Every Monday at 9:00 AM IST
  cron.schedule("0 9 * * 1", () => sendWeeklyReport(bot), {
    timezone: "Asia/Kolkata",
  });
  console.log("[Scheduler] Weekly report scheduled for Mondays at 9:00 AM IST");
}

// targetChatId defaults to the configured group — pass msg.chat.id for /report command
export async function sendWeeklyReport(bot, targetChatId = process.env.TELEGRAM_GROUP_ID) {
  if (!targetChatId) {
    console.error("[Scheduler] No target chat ID — set TELEGRAM_GROUP_ID in .env or pass a chatId");
    return;
  }

  try {
    await bot.sendMessage(targetChatId, "📊 *Weekly Business Report*\n_Generating your briefing..._", {
      parse_mode: "Markdown",
    });

    // Run both agents in parallel to halve generation time
    const [marketReport, competitiveReport] = await Promise.all([
      runMarketResearchAgent(MARKET_PROMPT),
      runCompetitiveAnalysisAgent(COMPETITIVE_PROMPT),
    ]);

    const date = new Date().toLocaleDateString("en-IN", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const report =
      `📊 *Weekly Business Report — ${date}*\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📈 *Market Intelligence*\n\n${marketReport}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🔍 *Competitive Intelligence*\n\n${competitiveReport}`;

    for (const chunk of splitMessage(report, 4096)) {
      await bot.sendMessage(targetChatId, chunk, { parse_mode: "Markdown" });
    }
  } catch (err) {
    console.error("[Scheduler] Failed to send weekly report:", err.message);
    try {
      await bot.sendMessage(targetChatId, "⚠️ Weekly report failed to generate. Check the bot logs.");
    } catch {
      // best-effort error notification
    }
  }
}

// Same algorithm as bot.js — breaks at newlines for clean splits
function splitMessage(text, maxLength) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxLength;
    if (end < text.length) {
      const lastNewline = text.lastIndexOf("\n", end);
      if (lastNewline > start) end = lastNewline + 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}
