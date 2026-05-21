import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_FILE = path.join(__dirname, "data", "memories.json");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function loadMemories() {
  if (!existsSync(MEMORY_FILE)) return {};
  try {
    return JSON.parse(readFileSync(MEMORY_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveMemories(data) {
  writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2), "utf8");
}

export function getMemories(chatId) {
  const data = loadMemories();
  return data[String(chatId)] || [];
}

export function clearMemories(chatId) {
  const data = loadMemories();
  delete data[String(chatId)];
  saveMemories(data);
}

export async function extractAndSaveMemories(chatId, userMessage, assistantReply) {
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 512,
    system: `You extract memorable business facts from conversations for Urvar Natural Pvt. Ltd., a bio-fertilizer company.

Extract ONLY facts worth remembering long-term:
- Business decisions or strategies agreed upon
- Specific targets mentioned (price points, geographies, customer segments)
- Competitor insights discussed
- Market data or trends noted
- Product or R&D directions decided

Return a JSON array of short factual strings. Return [] if nothing is worth remembering.
Example: ["Targeting organic farmers in West Bengal", "Price point set at ₹299 for 1kg pack", "Main competitor is Biofit Organics"]`,
    messages: [
      {
        role: "user",
        content: `User said: "${userMessage}"\n\nAssistant replied: "${assistantReply.slice(0, 1000)}"\n\nWhat facts from this exchange are worth remembering long-term?`,
      },
    ],
  });

  let facts = [];
  try {
    const text = response.content[0].text.trim();
    const match = text.match(/\[[\s\S]*\]/);
    if (match) facts = JSON.parse(match[0]);
  } catch {
    return;
  }

  if (!facts.length) return;

  const data = loadMemories();
  const existing = data[String(chatId)] || [];
  const timestamp = new Date().toISOString();

  for (const fact of facts) {
    if (typeof fact === "string" && fact.trim()) {
      existing.push({ fact: fact.trim(), createdAt: timestamp });
    }
  }

  // Keep last 100 memories per chat
  if (existing.length > 100) existing.splice(0, existing.length - 100);

  data[String(chatId)] = existing;
  saveMemories(data);
}
