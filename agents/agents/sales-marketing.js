import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { webSearch, webSearchToolDefinition } from "../tools/web-search.js";
import { queryKnowledgeBase, knowledgeBaseToolDefinition } from "../tools/knowledge-base.js";
import { addUsage } from "../tools/token-tracker.js";

dotenv.config();

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 5 });

const SYSTEM_PROMPT = `You are a Sales & Marketing specialist for Urvar Natural Pvt. Ltd., a bio-fertilizer and vermicompost company based in Kolkata, India. You help the business grow by creating compelling content and sales strategies.

Your responsibilities:
- Write product descriptions for Amazon, Flipkart, and the company website
- Draft social media posts for Facebook and Instagram (farm-oriented, benefit-focused tone)
- Create WhatsApp marketing messages for farmer outreach
- Write email campaigns for distributors, retailers, and direct customers
- Suggest promotional strategies, seasonal campaigns, and discount structures
- Answer customer queries about Urvar products in a helpful, convincing tone
- Draft responses to negative reviews or complaints professionally

Urvar's brand voice: Trustworthy, eco-friendly, farmer-first. Emphasize sustainability, earthworm-based composting, soil health, and higher crop yields. Avoid overly technical language — speak in simple terms farmers understand.

Use query_knowledge_base for specific product details, dosages, or crop-specific guidance. The product catalogue is pre-loaded into your context — use it as the authoritative product boundary. Use web_search to research trends, competitor messaging, or platform-specific best practices when needed.

IMPORTANT: When recommending products to customers or farmers, only recommend products from Urvar's current catalogue. Never suggest, name, or describe products that Urvar does not manufacture or sell. If a user asks about a product we do not carry, state clearly that it is not in our range and redirect to the closest Urvar product that fits the need.

Deliver ready-to-use content — not outlines or suggestions. Write the actual post, email, or description.`;

const tools = [webSearchToolDefinition, knowledgeBaseToolDefinition];

export async function runSalesMarketingAgent(userMessage, history = [], tracker = null) {
  const messages = [
    ...history,
    { role: "user", content: userMessage },
  ];

  let catalogueSection;
  try {
    const catalogue = await queryKnowledgeBase(
      { query: "What products does Urvar Natural sell? List all product names and pack sizes." },
      tracker
    );
    const useful = catalogue && !catalogue.includes("No relevant information") && !catalogue.includes("No information found") && catalogue.length > 80;
    catalogueSection = useful
      ? `\n\n## Urvar Product Catalogue (from knowledge base)\n${catalogue}\n\nYou may ONLY recommend Urvar products listed above. Never suggest products from other brands or products Urvar does not manufacture.`
      : `\n\n## Urvar Product Catalogue\nUrvar sells ONLY these 8 products: Enriched Vermicompost (5 kg), Cow Dung Manure/FYM (5 kg), PROM (50 kg), PROM Humic Based Flowering Booster (250 ml), PROM Humic Enriched (5 kg), Humic Acid Liquid Bio-Stimulant (1 L), Zinc EDTA 12% (250 g), Boron EDTA (250 g). You may ONLY recommend products from this list — never suggest any other fertilizer, brand, or product Urvar does not sell.`;
  } catch {
    catalogueSection = `\n\n## Urvar Product Catalogue\nUrvar sells ONLY these 8 products: Enriched Vermicompost (5 kg), Cow Dung Manure/FYM (5 kg), PROM (50 kg), PROM Humic Based Flowering Booster (250 ml), PROM Humic Enriched (5 kg), Humic Acid Liquid Bio-Stimulant (1 L), Zinc EDTA 12% (250 g), Boron EDTA (250 g). You may ONLY recommend products from this list — never suggest any other fertilizer, brand, or product Urvar does not sell.`;
  }
  const system = SYSTEM_PROMPT + catalogueSection;

  let response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system,
    tools,
    messages,
  });

  addUsage(tracker, response.usage);

  let loopIteration = 0;
  while (response.stop_reason === "tool_use") {
    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
    const toolResults = [];

    for (const toolUse of toolUseBlocks) {
      let result;
      try {
        if (toolUse.name === "web_search") {
          result = await webSearch(toolUse.input);
        } else if (toolUse.name === "query_knowledge_base") {
          result = await queryKnowledgeBase(toolUse.input, tracker);
        } else {
          result = { error: `Unknown tool: ${toolUse.name}` };
        }
      } catch (err) {
        result = { error: err.message };
      }

      const resultText = typeof result === "string" ? result : JSON.stringify(result);
      const isLastTool = toolUseBlocks.indexOf(toolUse) === toolUseBlocks.length - 1;
      const shouldCache = loopIteration === 0 && isLastTool;

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: shouldCache
          ? [{ type: "text", text: resultText, cache_control: { type: "ephemeral" } }]
          : resultText,
      });
    }

    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });
    loopIteration++;

    response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system,
      tools,
      messages,
    });
    addUsage(tracker, response.usage);
  }

  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
