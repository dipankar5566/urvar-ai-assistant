import OpenAI from "openai";
import dotenv from "dotenv";
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import path from "path";

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const settingsPath = path.resolve(__dirname, "../../RAG/Open AI/settings.json");

let vectorStoreId = null;
let cachedAssistantId = null;

async function getVectorStoreId() {
  if (vectorStoreId) return vectorStoreId;
  const raw = await readFile(settingsPath, "utf8");
  const settings = JSON.parse(raw);
  vectorStoreId = settings.vectorStoreId;
  return vectorStoreId;
}

async function getOrCreateAssistant(storeId) {
  if (cachedAssistantId) {
    try {
      await openai.beta.assistants.retrieve(cachedAssistantId);
      return cachedAssistantId;
    } catch (err) {
      if (err.status === 404) cachedAssistantId = null;
      else throw err;
    }
  }
  const assistant = await openai.beta.assistants.create({
    name: "Urvar Knowledge Retriever",
    model: "gpt-4o-mini",
    tools: [{ type: "file_search" }],
    tool_resources: { file_search: { vector_store_ids: [storeId] } },
  });
  cachedAssistantId = assistant.id;
  return cachedAssistantId;
}

export async function queryKnowledgeBase({ query }) {
  const storeId = await getVectorStoreId();
  if (!storeId) throw new Error("vectorStoreId not found in settings.json");

  const assistantId = await getOrCreateAssistant(storeId);
  let thread;

  try {
    thread = await openai.beta.threads.create({
      messages: [{ role: "user", content: query }],
    });

    await openai.beta.threads.runs.createAndPoll(thread.id, {
      assistant_id: assistantId,
    });

    const messages = await openai.beta.threads.messages.list(thread.id);
    const answer = messages.data
      .filter((m) => m.role === "assistant")
      .map((m) =>
        m.content
          .filter((c) => c.type === "text")
          .map((c) => c.text?.value || "")
          .join("")
      )
      .join("\n");

    return answer || "No relevant information found in the knowledge base.";
  } finally {
    if (thread) await openai.beta.threads.del(thread.id);
  }
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
        description: "The question or topic to look up in the company knowledge base.",
      },
    },
    required: ["query"],
  },
};
