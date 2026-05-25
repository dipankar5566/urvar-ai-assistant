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

async function getVectorStoreId() {
  if (vectorStoreId) return vectorStoreId;
  const raw = await readFile(settingsPath, "utf8");
  const settings = JSON.parse(raw);
  vectorStoreId = settings.vectorStoreId;
  return vectorStoreId;
}

export async function queryKnowledgeBase({ query, max_num_results = 10 }, tracker = null) {
  const storeId = await getVectorStoreId();
  if (!storeId) throw new Error("vectorStoreId not found in settings.json");

  const assistant = await openai.beta.assistants.create({
    name: "Urvar Knowledge Retriever",
    model: "gpt-4o-mini",
    instructions: "You are a knowledge retrieval assistant for Urvar Natural Pvt. Ltd. Answer queries by extracting relevant facts directly from the documents. For crop and disease queries: include specific product names, dosage numbers, application timing, and visual symptom descriptions. Keep answers concise, factual, and structured.",
    tools: [{ type: "file_search" }],
    tool_resources: { file_search: { vector_store_ids: [storeId] } },
  });

  let thread = null;
  try {
    thread = await openai.beta.threads.create({
      messages: [{ role: "user", content: query }],
    });

    await openai.beta.threads.runs.createAndPoll(thread.id, {
      assistant_id: assistant.id,
      tools: [{ type: "file_search", file_search: { max_num_results } }],
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
    await openai.beta.assistants.del(assistant.id);
    if (thread) await openai.beta.threads.del(thread.id).catch(() => {});
  }
}

export const knowledgeBaseToolDefinition = {
  name: "query_knowledge_base",
  description:
    "Query the Urvar knowledge base for: (1) company info — products, pricing, pack sizes, mission, distribution; (2) crop treatment guides — application rates for vermicompost, PROM, humic acid, zinc EDTA, boron EDTA by crop and growth stage; (3) nutrient deficiency symptoms and visual identification guides for Indian crops; (4) common Indian crop diseases, pest damage patterns, and organic treatment protocols. Always query this before giving crop advice, dosage recommendations, or disease diagnosis.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The question or topic to look up in the knowledge base.",
      },
      max_num_results: {
        type: "number",
        description: "Number of document chunks to retrieve (1–20). Use 15–20 for complex crop or disease queries. Default is 10.",
      },
    },
    required: ["query"],
  },
};
