import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { runMarketResearchAgent } from "./agents/market-research.js";
import { runCompetitiveAnalysisAgent } from "./agents/competitive-analysis.js";
import { runSalesMarketingAgent } from "./agents/sales-marketing.js";
import { runRdProductAgent } from "./agents/rd-product.js";
import { runLeadGenerationAgent } from "./agents/lead-generation.js";
import { getMemories } from "./memory.js";
import { addUsage } from "./tools/token-tracker.js";

dotenv.config();

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 5 });

const SYSTEM_PROMPT = `You are the central AI assistant for Urvar Natural Pvt. Ltd., a bio-fertilizer and vermicompost company based in Kolkata, India. You coordinate a team of specialist agents to answer business questions.

Available specialist agents:
1. **Market Research Agent** — market size, demand trends, customer segments, pricing benchmarks, e-commerce trends, growth opportunities in the organic fertilizer sector.
2. **Competitive Analysis Agent** — competitors, competitor products/pricing, market positioning, competitive gaps, benchmarking against other vermicompost brands.
3. **Sales & Marketing Agent** — product descriptions, social media posts, WhatsApp messages, email campaigns, customer query responses, promotional strategies.
4. **R&D / Product Development Agent** — formulation research, agronomic data, new product ideas, certifications, production improvements, scientific literature on bio-fertilizers.
5. **Lead Generation Agent** — finding B2B leads: distributors, agri-retailers, nurseries, garden centers, cooperatives, and Farmer Producer Organizations (FPOs) who could stock or resell Urvar products. Also drafts outreach messages.

Your job:
- Market size, trends, demand, customer segments → call_market_research_agent
- Competitors, pricing comparison, brand benchmarking → call_competitive_analysis_agent
- Content creation, marketing copy, social posts, emails, customer replies → call_sales_marketing_agent
- Customer questions about which Urvar products to use, crop-specific product advice, dosage questions, farmer product queries → call_sales_marketing_agent
- New product R&D, formulation research, certifications, agronomic science literature, production improvements → call_rd_product_agent
- Finding distributors, retailers, nurseries, cooperatives, FPOs, or any sales leads → call_lead_generation_agent
- General questions about Urvar or greetings → answer directly
- When unsure, choose the most relevant agent or ask for clarification

When routing to a specialist agent, call the tool immediately — do not generate any preamble text before the tool call. Only write text in your final response after receiving the agent's result.

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
  {
    name: "call_lead_generation_agent",
    description:
      "Delegate to the Lead Generation specialist agent. Use for finding potential B2B customers: distributors, agri-retailers, nurseries, garden centers, cooperatives, and Farmer Producer Organizations (FPOs) who could stock or resell Urvar products. Use when the user asks to find leads, generate a prospect list, or draft outreach messages for sales targets.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The lead generation request, including the type of business to find and the target geography.",
        },
      },
      required: ["query"],
    },
  },
];

const cachedTools = tools.map((t, i) =>
  i === tools.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t
);

function buildSystemBlocks(chatId) {
  const base = {
    type: "text",
    text: SYSTEM_PROMPT,
    cache_control: { type: "ephemeral" },
  };
  const memories = chatId ? getMemories(chatId) : [];
  if (memories.length === 0) return [base];
  const memoryText =
    "\n\n## What you remember about this business (from past conversations):\n" +
    memories.map((m) => `- ${m.fact}`).join("\n") +
    "\n\nUse these facts to give more relevant, contextual answers.";
  return [base, { type: "text", text: memoryText }];
}

export async function runOrchestrator(userMessage, history = [], chatId = null, tracker = null) {
  const messages = [
    ...history,
    { role: "user", content: userMessage },
  ];

  let response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: buildSystemBlocks(chatId),
    tools: cachedTools,
    messages,
  });

  addUsage(tracker, response.usage);

  // Handle agent delegation
  while (response.stop_reason === "tool_use") {
    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
    const toolResults = [];

    for (const toolUse of toolUseBlocks) {
      let result;
      try {
        if (toolUse.name === "call_market_research_agent") {
          result = await runMarketResearchAgent(toolUse.input.query, [], tracker);
        } else if (toolUse.name === "call_competitive_analysis_agent") {
          result = await runCompetitiveAnalysisAgent(toolUse.input.query, [], tracker);
        } else if (toolUse.name === "call_sales_marketing_agent") {
          result = await runSalesMarketingAgent(toolUse.input.query, [], tracker);
        } else if (toolUse.name === "call_rd_product_agent") {
          result = await runRdProductAgent(toolUse.input.query, [], tracker);
        } else if (toolUse.name === "call_lead_generation_agent") {
          result = await runLeadGenerationAgent(toolUse.input.query, [], tracker);
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
      system: buildSystemBlocks(chatId),
      tools: cachedTools,
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
