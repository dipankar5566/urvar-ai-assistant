import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { runMarketResearchAgent } from "./agents/market-research.js";
import { runCompetitiveAnalysisAgent } from "./agents/competitive-analysis.js";
import { getMemories } from "./memory.js";

dotenv.config();

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are the central AI assistant for Urvar Natural Pvt. Ltd., a bio-fertilizer and vermicompost company based in Kolkata, India. You coordinate a team of specialist agents to answer business questions.

Available specialist agents:
1. **Market Research Agent** — handles questions about market size, demand trends, customer segments, pricing benchmarks, e-commerce trends, and growth opportunities in the organic fertilizer sector.
2. **Competitive Analysis Agent** — handles questions about competitors, competitor products/pricing, market positioning, competitive gaps, and benchmarking against other vermicompost brands.

Your job:
- For market research questions (market size, trends, demand, customer segments, pricing data, growth): delegate to call_market_research_agent
- For competitive questions (competitors, who else sells vermicompost, competitor prices, brand comparison): delegate to call_competitive_analysis_agent
- For general questions about Urvar itself or greetings: answer directly from your knowledge
- When unsure, choose the most relevant agent or ask for clarification

Always be helpful, concise, and business-focused. You represent Urvar's internal AI team.`;

const tools = [
  {
    name: "call_market_research_agent",
    description:
      "Delegate to the Market Research specialist agent. Use for questions about market size, growth trends, demand, customer segments, pricing benchmarks, e-commerce dynamics, and market opportunities for bio-fertilizers in India.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The full market research question or task to hand off to the specialist.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "call_competitive_analysis_agent",
    description:
      "Delegate to the Competitive Analysis specialist agent. Use for questions about competitors, competitive landscape, competitor products/pricing, market positioning, and differentiation strategy.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The full competitive analysis question or task to hand off to the specialist.",
        },
      },
      required: ["query"],
    },
  },
];

export async function runOrchestrator(userMessage, history = [], chatId = null) {
  // Build system prompt with long-term memories if available
  let systemPrompt = SYSTEM_PROMPT;
  if (chatId) {
    const memories = getMemories(chatId);
    if (memories.length > 0) {
      const memoryText = memories.map((m) => `- ${m.fact}`).join("\n");
      systemPrompt += `\n\n## What you remember about this business (from past conversations):\n${memoryText}\n\nUse these facts to give more relevant, contextual answers.`;
    }
  }

  const messages = [
    ...history,
    { role: "user", content: userMessage },
  ];

  let response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 512,
    system: systemPrompt,
    tools,
    messages,
  });

  // Handle agent delegation
  while (response.stop_reason === "tool_use") {
    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
    const toolResults = [];

    for (const toolUse of toolUseBlocks) {
      let result;
      try {
        if (toolUse.name === "call_market_research_agent") {
          result = await runMarketResearchAgent(toolUse.input.query, []);
        } else if (toolUse.name === "call_competitive_analysis_agent") {
          result = await runCompetitiveAnalysisAgent(toolUse.input.query, []);
        } else {
          result = `Unknown agent: ${toolUse.name}`;
        }
      } catch (err) {
        result = `Agent error: ${err.message}`;
      }

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result,
      });
    }

    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });

    response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: systemPrompt,
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
