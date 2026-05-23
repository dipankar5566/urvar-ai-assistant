import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import path from "path";
import { addUsage } from "./token-tracker.js";

dotenv.config();

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.resolve(__dirname, "../../RAG/docs");

const DOC_FILES = [
  "urvar-summary.md",
  "company.md",
  "products.md",
  "customers.md",
  "crop-guide.md",
  "pricing.md",
];

let cachedDocs = null;

async function loadDocs() {
  if (cachedDocs) return cachedDocs;
  const parts = [];
  for (const filename of DOC_FILES) {
    try {
      const content = await readFile(path.join(docsDir, filename), "utf8");
      parts.push(`=== ${filename} ===\n${content}`);
    } catch {
      // skip missing files silently
    }
  }
  cachedDocs = parts.join("\n\n");
  return cachedDocs;
}

export async function queryKnowledgeBase({ query }, tracker = null) {
  const docs = await loadDocs();

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: `You are a knowledge base assistant for Urvar Natural Pvt. Ltd. Answer questions strictly based on the company documents below. If the answer is not in the documents, say "No information found in the knowledge base."

${docs}`,
    messages: [{ role: "user", content: query }],
  });

  addUsage(tracker, response.usage);

  return (
    response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n") || "No relevant information found in the knowledge base."
  );
}

export const knowledgeBaseToolDefinition = {
  name: "query_knowledge_base",
  description:
    "Query the Urvar company knowledge base for internal information: products, mission, contact details, distribution channels, and other company-specific facts. Use this before answering questions about Urvar itself.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "The question or topic to look up in the company knowledge base.",
      },
    },
    required: ["query"],
  },
};
