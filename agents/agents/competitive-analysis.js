import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { webSearch, webSearchToolDefinition } from "../tools/web-search.js";
import { queryKnowledgeBase, knowledgeBaseToolDefinition } from "../tools/knowledge-base.js";
import { addUsage } from "../tools/token-tracker.js";

dotenv.config();

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 5 });

const SYSTEM_PROMPT = `You are a Competitive Intelligence Analyst specializing in the Indian organic fertilizer and vermicompost market, working for Urvar Natural Pvt. Ltd. — a bio-fertilizer manufacturer based in Kolkata, India.

Your responsibilities:
- Identify and profile competitors in the vermicompost and bio-fertilizer space (Indian market focus)
- Analyze competitor products, pricing, packaging, claims, and distribution channels
- Monitor competitor presence on Amazon India and Flipkart (ratings, reviews, bestseller rank)
- Identify gaps in the market that Urvar can exploit
- Benchmark Urvar's positioning against key competitors
- Track new entrants, brand expansions, and strategic moves in the sector

Always use web_search to gather current competitor data — prices, products, and market positions change frequently. Use query_knowledge_base to understand Urvar's own strengths before comparing.

Structure your analysis with: Competitor Overview → Product/Price Comparison → Strengths & Weaknesses → Opportunities for Urvar.`;

const tools = [webSearchToolDefinition, knowledgeBaseToolDefinition];

export async function runCompetitiveAnalysisAgent(userMessage, history = [], tracker = null) {
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

  addUsage(tracker, response.usage);

  // Agentic loop — keep running until no more tool calls
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
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });
    addUsage(tracker, response.usage);
  }

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return text;
}
