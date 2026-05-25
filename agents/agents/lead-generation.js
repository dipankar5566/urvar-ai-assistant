import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { webSearch, webSearchToolDefinition } from "../tools/web-search.js";
import { queryKnowledgeBase, knowledgeBaseToolDefinition } from "../tools/knowledge-base.js";
import { addUsage } from "../tools/token-tracker.js";
import { runSalesMarketingAgent } from "./sales-marketing.js";

dotenv.config();

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 5 });

const SYSTEM_PROMPT = `You are a B2B Sales Development Representative for Urvar Natural Pvt. Ltd., a bio-fertilizer and vermicompost manufacturer based in Kolkata, India.

Your job is to find qualified business leads — potential distributors, retailers, and partners who could stock or resell Urvar's organic fertilizer products.

Target lead types:
- Agri-input retailers and farm supply shops
- Nurseries and plant shops (wholesale or retail)
- Agricultural cooperatives and Farmer Producer Organizations (FPOs)
- Distributors of fertilizers, pesticides, or agricultural inputs
- Garden centers and horticultural suppliers
- Online resellers active on Amazon/Flipkart in the agri category

Search strategy — use these sources for best results:
- IndiaMART, TradeIndia, JustDial for agri dealers and distributors
- Government FPO portals (sfacindia.com, enam.gov.in) for cooperatives
- Amazon/Flipkart seller search for online resellers
- General web search with queries like "agri input dealer [city]", "vermicompost distributor [state]", "nursery supplier [district]"
- Run multiple targeted searches to build a comprehensive list

For each search:
1. Use query_knowledge_base FIRST to understand Urvar's product range and unique selling points
2. Use web_search (multiple times with different queries) to find real businesses with name, location, and contact details
3. Return a structured lead list only. Do not write outreach messages.

Lead list format:
- Business Name
- Type (retailer / distributor / nursery / cooperative / FPO)
- Location (city, district, state)
- Contact (phone / email / website if found)
- Why they're a good fit (1 line)

Always search for leads in the specific geography the user mentions. If no geography is specified, default to West Bengal.`;

const tools = [webSearchToolDefinition, knowledgeBaseToolDefinition];

export async function runLeadGenerationAgent(userMessage, history = [], tracker = null) {
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

    for (const [i, toolUse] of toolUseBlocks.entries()) {
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
      const isLastTool = i === toolUseBlocks.length - 1;
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

  const leadList = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const outreachPrompt =
    `I have just found the following leads for Urvar Natural:\n\n${leadList}\n\n` +
    `Write ONE concise WhatsApp or email outreach message the Urvar sales team can ` +
    `send to this category of prospect. Focus on product benefits and margin opportunity ` +
    `for the reseller. Use Urvar brand voice (trustworthy, eco-friendly, farmer-first).`;

  const outreachCopy = await runSalesMarketingAgent(outreachPrompt, [], tracker);

  return `${leadList}\n\n---\n\n## Outreach Template\n\n${outreachCopy}`;
}
