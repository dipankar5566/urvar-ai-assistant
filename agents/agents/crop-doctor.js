import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { webSearch, webSearchToolDefinition } from "../tools/web-search.js";
import { queryKnowledgeBase, knowledgeBaseToolDefinition } from "../tools/knowledge-base.js";
import { addUsage } from "../tools/token-tracker.js";
import { CATALOGUE_PRODUCTS } from "../catalogue-fallback.js";
import { optimizeCropImage } from "../tools/image-optimizer.js";
import { classifyCropImage } from "../tools/crop-classifier.js";

dotenv.config();

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 5 });

function getIndianSeason() {
  const m = new Date().getMonth() + 1;
  if (m >= 6 && m <= 9) return "Kharif (June–September) — rice, maize, cotton, groundnut";
  if (m === 10 || m === 11) return "Kharif–Rabi transition (October–November)";
  if (m === 12 || m <= 2) return "Rabi (December–February) — wheat, mustard, potato, pea";
  return "Zaid/Summer (March–May) — cucumber, watermelon, bitter gourd";
}

const SYSTEM_PROMPT = `You are a senior crop disease and soil health specialist for Urvar Natural Pvt. Ltd., a bio-fertilizer company in Kolkata, India. You have 20 years of field experience across West Bengal and eastern India. Farmers send you photos for expert diagnosis.

STEP 1 — ALWAYS call query_knowledge_base first with the query: "crop disease treatment application rates vermicompost humic acid zinc boron". This gives you Urvar's crop guide and product dosage data before you diagnose.

STEP 2 — Analyze the image carefully. Consider:
- Leaf color changes (yellowing, browning, purpling, bleaching, necrosis)
- Pattern distribution (interveinal, tip, margin, random spots, uniform)
- Affected parts (old leaves vs young leaves — indicates mobile vs immobile nutrients)
- Visible structures (mold, lesions, pustules, webbing, tunnels)
- Soil color, texture, cracking, waterlogging, crust

STEP 3 — If your diagnosis is PROBABLE or POSSIBLE, call web_search to confirm against ICAR/NBSS&LUP/Krishi Vigyan Kendra disease databases before finalizing your answer.

STEP 4 — Reply in this exact format:

**Confidence:** [DEFINITIVE / PROBABLE / POSSIBLE / UNCERTAIN]
**Severity:** [🔴 CRITICAL — act within 24h / 🟡 MODERATE — act within 1 week / 🟢 MILD — monitor]

**What I see:** Describe visible symptoms exactly (color, pattern, which parts affected, spread)

**Diagnosis:** Name the problem clearly

**Cause:** 1–2 sentences on what causes this

**Treatment with Urvar products:**
[Product name] — [dose per katha or per litre] — [how to apply]

**Prevention:** One practical tip

---
IMPORTANT RULES:
- If confidence is UNCERTAIN: do NOT guess a diagnosis. Instead say "I cannot identify this clearly from the photo. Please send a close-up photo of the most affected leaf in good natural light." Describe exactly what angle/lighting would help.
- If you cannot identify the crop from the image: ask "Which crop is this, and which state/district are you in?" before giving treatment advice.
- Only recommend products from Urvar's catalogue. If the problem needs a fungicide or pesticide Urvar doesn't sell, state this clearly and recommend the Urvar product that best supports soil recovery.
- Old leaves affected → likely mobile nutrient deficiency (N, P, K, Mg). Young leaves affected → likely immobile nutrient deficiency (Ca, Fe, Zn, B).
- Keep language simple. Farmers need fast, actionable answers.

IMAGE PRE-PROCESSING APPLIED:
Your images have been automatically optimized for disease detection before reaching you:
- Resized to 256×256 pixels (CNN-standard)
- Median filter applied to reduce camera noise while preserving lesion boundaries
- Contrast normalized and gamma-corrected (γ=1.2) to balance uneven outdoor lighting
- A greyscale variant is included — use it to judge texture, pattern spread, and necrosis shape independent of color
- A saturation-enhanced variant is included — use it to identify subtle pigment changes (rust, blight, yellowing) that appear washed out in the original
- Rotated and flipped variants may be included — assess each for lesion distribution consistency

IMAGING LIMITATIONS: This system uses standard RGB photography only. Hyperspectral or thermal imaging (capable of detecting pre-symptomatic physiological stress) is not available. If you suspect early-stage infection with no visible symptoms yet, advise the farmer to arrange a soil test or contact a local Krishi Vigyan Kendra (KVK) for lab analysis.`;

const tools = [webSearchToolDefinition, knowledgeBaseToolDefinition];

export async function runCropDoctorAgent(userMessage, history = [], tracker = null, imageDataArray = [], mediaType = "image/jpeg") {
  // Pre-process images; geometric augmentation only for single-image input to cap token cost
  const singleImage = imageDataArray.length === 1;
  const optimizedDataArray = [];
  for (const data of imageDataArray) {
    const variants = await optimizeCropImage(data, { augment: singleImage });
    optimizedDataArray.push(...variants);
  }

  const imageBlocks = optimizedDataArray.map((data) => ({
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data },
  }));

  // CNN pre-classifier gives Claude a disease prior to confirm or override
  let mlPrior = "";
  if (optimizedDataArray.length > 0) {
    const result = await classifyCropImage(optimizedDataArray[0]);
    if (result.available) {
      const pct = (c) => `${Math.round(c * 100)}%`;
      const top = result.top3.map((p) => `${p.label} (${pct(p.confidence)})`).join(", ");
      mlPrior = `\n\n[ML Pre-diagnosis — CNN trained on PlantVillage: ${top}]`;
    }
  }

  const defaultText = optimizedDataArray.length > 1
    ? `Please analyze all ${optimizedDataArray.length} optimized views of this crop problem. These are pre-processed variants (enhanced, greyscale, saturation-boosted, and rotation/flip augmentations) of the same original photo(s). Use all views together for the most accurate diagnosis.`
    : "Please analyze this image. Identify any crop disease, pest damage, nutrient deficiency, or soil problem.";

  const textContent = (userMessage || defaultText) + mlPrior;

  const userContent = imageBlocks.length > 0
    ? [...imageBlocks, { type: "text", text: textContent }]
    : textContent;

  const messages = [
    ...history,
    { role: "user", content: userContent },
  ];

  let catalogueSection;
  try {
    const catalogue = await queryKnowledgeBase(
      { query: "What products does Urvar Natural sell? List all product names and pack sizes." },
      tracker
    );
    const useful = catalogue && !catalogue.includes("No relevant information") && !catalogue.includes("No information found") && catalogue.length > 80;
    catalogueSection = useful
      ? `\n\n## Urvar Product Catalogue (from knowledge base)\n${catalogue}\n\nOnly recommend products listed above. Never suggest products Urvar does not manufacture.`
      : `\n\n## Urvar Product Catalogue\nUrvar sells ONLY these 8 products: ${CATALOGUE_PRODUCTS}. Only recommend products from this list.`;
  } catch {
    catalogueSection = `\n\n## Urvar Product Catalogue\nUrvar sells ONLY these 8 products: ${CATALOGUE_PRODUCTS}. Only recommend products from this list.`;
  }

  const seasonContext = `\n\nCurrent date: ${new Date().toLocaleDateString("en-IN", { month: "long", year: "numeric" })}\nCurrent agricultural season in India: ${getIndianSeason()}`;
  const system = SYSTEM_PROMPT + seasonContext + catalogueSection;

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
