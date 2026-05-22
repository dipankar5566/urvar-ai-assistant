import OpenAI from "openai";
import dotenv from "dotenv";
import fsPromises from "fs/promises";
import path from "path";
import fs from "fs";

dotenv.config();

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("Missing OPENAI_API_KEY in environment. See .env.example");
  process.exit(1);
}

const openai = new OpenAI({ apiKey });

async function main() {
  // await create();
  // await get();
  await indexFiles();
}

async function get() {
  try {
    const vectorStores = await openai.vectorStores.list();
    console.log(vectorStores);  
  } catch (err) {
    console.error("Error fetching vector stores:", err);
    process.exit(1);
  }
}

async function create(params) {
  try {
    const vectorStore = await openai.vectorStores.create({ name: "Urvar" });
    console.log(vectorStore);
  } catch (err) {
    console.error("Error creating vector store:", err);
    process.exit(1);
  }
}

async function indexFiles() {
  const settingsPath = path.join(process.cwd(), "settings.json");
  let settingsRaw;
  try {
    settingsRaw = await fsPromises.readFile(settingsPath, "utf8");
  } catch (err) {
    console.error(`Cannot read settings file at ${settingsPath}:`, err.message);
    process.exit(1);
  }

  let settings;
  try {
    settings = JSON.parse(settingsRaw);
  } catch (err) {
    console.error("Invalid JSON in settings file:", err.message);
    process.exit(1);
  }

  // Support multiple possible keys for the vector store id
  const vectorStoreId = settings.vectorStoreId;
  const files = settings.files || [];

  if (!vectorStoreId) {
    console.error("settings must include a vector store id (vectorStoreId)");
    process.exit(1);
  }

  if (!Array.isArray(files) || files.length === 0) {
    console.error("settings must include a non-empty 'files' array");
    process.exit(1);
  }

  const results = [];
  for (const f of files) {
    if (!f || !f.filePath) {
      console.warn("Skipping invalid file entry (missing filePath):", f);
      continue;
    }

    try {
      let file = await readFile(f.filePath);
      const res = await openai.vectorStores.files.create(vectorStoreId, { file_id: file.id });
      console.log("Uploaded file to vector store:", f.filePath, "->", res);
      results.push(res);
    } catch (err) {
      console.error(`Error uploading files to ${vectorStoreId}:`, err?.message || err);
    }
  }

  return results;
}

async function readFile(filePath) {
  const fileStream = fs.createReadStream(filePath);
  let file = await openai.files.create({
    file: fileStream,
    purpose: "user_data"
  });
  return file;
}

main();
