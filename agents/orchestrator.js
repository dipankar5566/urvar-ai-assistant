import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { runMarketResearchAgent } from "./agents/market-research.js";
import { runCompetitiveAnalysisAgent } from "./agents/competitive-analysis.js";
import { runSalesMarketingAgent } from "./agents/sales-marketing.js";
import { runRdProductAgent } from "./agents/rd-product.js";
import { getMemories } from "./memory.js";

dotenv.config();

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 5 });

const SYSTEM_PROMPT = `You are the central AI assistant for Urvar Natural Pvt. Ltd., a bio-fertilizer and vermicompost company based in Kolkata, India. You coordinate a team of specialist agents to answer business questions.

Available specialist agents:
1. **Market Research Agent** — market size, demand trends, customer segments, pricing benchmarks, e-commerce trends, growth opportunities in the organic fertilizer sector.
2. **Competitive Analysis Agent** — competitors, competitor products/pricing, market positioning, competitive gaps, benchmarking against other vermicompost brands.
3. **Sales & Marketing Agent** — product descriptions, social media posts, WhatsApp messages, email campaigns, customer query responses, promotional strategies.
4. **R&D / Product Development Agent** — formulation research, agronomic data, new product ideas, certifications, production improvements, scientific literature on bio-fertilizers.

Your job:
- Market size, trends, demand, customer segments → call_market_research_agent
- Competitors, pricing comparison, brand benchmarking → call_competitive_analysis_agent
- Content creation, marketing copy, social posts, emails, customer replies → call_sales_marketing_agent
- Formulations, new products, certifications, agronomic research → call_rd_product_agent
- General questions about Urvar or greetings → answer directly
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
  {
    name: "call_sales_marketing_agent",
    description:
      "Delegate to the Sales & Marketing specialist agent. Use for writing product descriptions, social media posts, WhatsApp messages, email campaigns, customer query responses, and promotional strategies.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The full sales or marketing task to hand off to the specialist.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "call_rd_product_agent",
    description:
      "Delegate to the R&D and Product Development specialist agent. Use for formulation research, new product ideas, agronomic data, certifications, production improvements, and scientific literature on bio-fertilizers.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The full R&D or product development question to hand off to the specialist.",
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
        } else if (toolUse.name === "call_sales_marketing_agent") {
          result = await runSalesMarketingAgent(toolUse.input.query, []);
        } else if (toolUse.name === "call_rd_product_agent") {
          result = await runRdProductAgent(toolUse.input.query, []);
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
