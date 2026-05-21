import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "history.json");

// Ensure data directory and file exist
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR);
if (!existsSync(DB_FILE)) writeFileSync(DB_FILE, "{}", "utf8");

function load() {
  try {
    return JSON.parse(readFileSync(DB_FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(data) {
  writeFileSync(DB_FILE, JSON.stringify(data, null, 2), "utf8");
}

export function getHistory(chatId) {
  const data = load();
  return data[String(chatId)] || [];
}

export function saveHistory(chatId, history) {
  const data = load();
  data[String(chatId)] = history;
  save(data);
}

export function clearHistory(chatId) {
  const data = load();
  delete data[String(chatId)];
  save(data);
}
