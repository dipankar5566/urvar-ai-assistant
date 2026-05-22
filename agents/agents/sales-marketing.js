import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { webSearch, webSearchToolDefinition } from "../tools/web-search.js";
import { queryKnowledgeBase, knowledgeBaseToolDefinition } from "../tools/knowledge-base.js";

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

Always use query_knowledge_base first to understand Urvar's products before writing content. Use web_search to research trends, competitor messaging, or platform-specific best practices when needed.

Deliver ready-to-use content — not outlines or suggestions. Write the actual post, email, or description.`;

const tools = [webSearchToolDefinition, knowledgeBaseToolDefinition];

export async function runSalesMarketingAgent(userMessage, history = []) {
  const messages = [
    ...history,
    { role: "user", content: userMessage },
  ];

  let response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools,
    messages,
  });

  while (response.stop_reason === "tool_use") {
    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
    const toolResults = [];

    for (const toolUse of toolUseBlocks) {
      let result;
      try {
        if (toolUse.name === "web_search") {
          result = await webSearch(toolUse.input);
        } else if (toolUse.name === "query_knowledge_base") {
          result = await queryKnowledgeBase(toolUse.input);
        } else {
          result = { error: `Unknown tool: ${toolUse.name}` };
        }
      } catch (err) {
        result = { error: err.message };
      }

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: typeof result === "string" ? result : JSON.stringify(result),
      });
    }

    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });

    response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });
  }

  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
