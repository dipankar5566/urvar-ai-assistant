import * as tf from "@tensorflow/tfjs-node";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = join(__dirname, "../../ml/models/tfjs_crop_classifier/model.json");
const LABELS_PATH = join(__dirname, "../../ml/labels.json");

let model = null;
let labels = null;

async function loadModel() {
  if (model) return model;
  if (!existsSync(MODEL_PATH)) {
    console.warn("[crop-classifier] TF.js model not found — run ml/train.py first. Skipping CNN pre-diagnosis.");
    return null;
  }
  labels = JSON.parse(readFileSync(LABELS_PATH, "utf-8"));
  model = await tf.loadGraphModel(`file://${MODEL_PATH}`);
  console.log("[crop-classifier] MobileNetV2 PlantVillage model loaded.");
  return model;
}

export async function classifyCropImage(base64Data) {
  const m = await loadModel();
  if (!m) return { available: false };

  const buf = Buffer.from(base64Data, "base64");

  // tf.tidy disposes all intermediate tensors produced by the preprocessing chain
  const normalized = tf.tidy(() =>
    tf.node.decodeImage(buf, 3)    // [H, W, 3]
      .expandDims(0)               // [1, H, W, 3]  — required before resizeBilinear
      .resizeBilinear([224, 224])  // [1, 224, 224, 3]
      .div(127.5)
      .sub(1)                      // scale to [-1, 1] matching MobileNetV2 preprocess_input
  );

  const predictions = m.predict(normalized);
  const probs = await predictions.data();

  normalized.dispose();
  predictions.dispose();

  const indexed = Array.from(probs).map((p, i) => ({ label: labels[i], confidence: p }));
  indexed.sort((a, b) => b.confidence - a.confidence);
  const top3 = indexed.slice(0, 3);

  return { top3, topLabel: top3[0].label, topConfidence: top3[0].confidence, available: true };
}
