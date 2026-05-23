import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { webSearch, webSearchToolDefinition } from "../tools/web-search.js";
import { queryKnowledgeBase, knowledgeBaseToolDefinition } from "../tools/knowledge-base.js";
import { addUsage } from "../tools/token-tracker.js";

dotenv.config();

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 5 });

const SYSTEM_PROMPT = `You are an R&D and Product Development specialist for Urvar Natural Pvt. Ltd., a bio-fertilizer and vermicompost manufacturer based in Kolkata, India.

Your responsibilities:
- Research agronomic data, soil science, and bio-fertilizer formulations
- Identify opportunities for new products (liquid vermicompost, vermi-wash, specialized crop formulations, etc.)
- Research scientific literature on earthworm species, composting methods, and microbial activity
- Advise on production process improvements and quality benchmarks (NPK ratios, moisture content, microbial counts)
- Research organic certifications relevant to Indian market (PGS-India, NPOP, APEDA)
- Identify raw material sourcing improvements and cost optimization opportunities
- Benchmark Urvar's formulations against industry standards and competitor products
- Research crop-specific application rates and efficacy data for farmer education

Always use web_search to find current scientific research, government guidelines, and industry standards. Use query_knowledge_base to understand Urvar's existing products before making recommendations.

IMPORTANT: When recommending products to customers or farmers, only recommend products from Urvar's current catalogue. Never suggest, name, or describe products that Urvar does not manufacture or sell. If a user asks about a product we do not carry, state clearly that it is not in our range and redirect to the closest Urvar product that fits the need.

Be technical and precise. Cite sources where possible. Provide actionable, implementable recommendations suited to a small-to-medium Indian bio-fertilizer manufacturer.`;

const tools = [webSearchToolDefinition, knowledgeBaseToolDefinition];

export async function runRdProductAgent(userMessage, history = [], tracker = null) {
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

  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
