import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { webSearch, webSearchToolDefinition } from "../tools/web-search.js";
import { queryKnowledgeBase, knowledgeBaseToolDefinition } from "../tools/knowledge-base.js";

dotenv.config();

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a Market Research Analyst specializing in the Indian agriculture and organic fertilizer sector, working for Urvar Natural Pvt. Ltd. — a bio-fertilizer and vermicompost manufacturer based in Kolkata, India.

Your responsibilities:
- Analyze market size, growth trends, and demand patterns for organic/bio-fertilizers in India
- Identify target customer segments (farmers, home gardeners, agricultural cooperatives, etc.)
- Research pricing benchmarks and market positioning opportunities
- Track regulatory environment (fertilizer policies, organic certification trends in India)
- Monitor e-commerce trends on Amazon India and Flipkart for agricultural inputs
- Provide data-driven insights to help Urvar grow its market share

Always ground your analysis in current data — use web_search for up-to-date market statistics and news. Use query_knowledge_base to understand Urvar's current positioning before making recommendations.

Format your responses clearly with sections, bullet points, and key takeaways where appropriate.`;

const tools = [webSearchToolDefinition, knowledgeBaseToolDefinition];

export async function runMarketResearchAgent(userMessage, history = []) {
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

  // Agentic loop — keep running until no more tool calls
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

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return text;
}
