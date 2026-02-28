import cors from "cors";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, "..");

const wikiFilePath = process.env.WIKI_FILE_PATH
  ? path.resolve(process.env.WIKI_FILE_PATH)
  : path.join(workspaceRoot, "src", "mock", "wikiData.ts");

const port = Number(process.env.EDITOR_API_PORT || 4010);

const app = express();
app.use(
  cors({
    origin: [
      "http://localhost:5174",
      "http://127.0.0.1:5174",
      "http://localhost:4174",
      "http://127.0.0.1:4174",
    ],
    credentials: false,
  }),
);
app.use(express.json({ limit: "15mb" }));

const TYPE_DEFS = `export type WikiCard = {
  title: string;
  description?: string;
  bullets?: string[];
};

export type WikiTable = {
  columns: string[];
  rows: string[][];
};

export type WikiBlock = {
  id: string;
  title: string;
  richContent?: string;
  description?: string;
  bullets?: string[];
  cards?: WikiCard[];
  table?: WikiTable;
  note?: string;
};

export type WikiSection = {
  id: string;
  title: string;
  summary: string;
  updated: string;
  sourcePost: string;
  badges: string[];
  blocks: WikiBlock[];
};`;

const extractSectionsSource = (source) => {
  const match = source.match(
    /export const wikiSections(?:\s*:\s*WikiSection\[\])?\s*=\s*([\s\S]*?);\s*$/m,
  );
  if (!match?.[1]) {
    throw new Error("Не удалось найти export const wikiSections в wikiData.ts");
  }
  return match[1].trim();
};

const parseSectionsFromFile = (source) => {
  const sectionsSource = extractSectionsSource(source);
  const sections = Function(`"use strict"; return (${sectionsSource});`)();
  if (!Array.isArray(sections)) {
    throw new Error("wikiSections имеет неверный формат (ожидался массив)");
  }
  return sections;
};

const toTsObjectLiteral = (value) => {
  const json = JSON.stringify(value, null, 2);
  return json.replace(/"([A-Za-z_$][A-Za-z0-9_$]*)":/g, "$1:");
};

const serializeSectionsToFile = (sections) => {
  const sectionsLiteral = toTsObjectLiteral(sections);
  return `${TYPE_DEFS}

export const wikiSections: WikiSection[] = ${sectionsLiteral};
`;
};

app.get("/api/health", (_, res) => {
  res.json({ ok: true, wikiFilePath });
});

app.get("/api/wiki", async (_, res) => {
  try {
    const fileContent = await fs.readFile(wikiFilePath, "utf8");
    const sections = parseSectionsFromFile(fileContent);
    res.json({
      sections,
      wikiFilePath,
      size: fileContent.length,
      loadedAt: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      error: "Не удалось прочитать wikiData.ts",
      details: String(error),
      wikiFilePath,
    });
  }
});

app.put("/api/wiki", async (req, res) => {
  try {
    const { sections } = req.body ?? {};
    if (!Array.isArray(sections)) {
      res.status(400).json({
        error: "Некорректные данные",
        details: "Ожидался массив sections",
      });
      return;
    }

    const output = serializeSectionsToFile(sections);
    const backupPath = `${wikiFilePath}.bak-${Date.now()}`;

    const current = await fs.readFile(wikiFilePath, "utf8");
    await fs.writeFile(backupPath, current, "utf8");
    await fs.writeFile(wikiFilePath, output, "utf8");

    res.json({
      ok: true,
      wikiFilePath,
      backupPath,
      savedAt: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      error: "Не удалось сохранить wikiData.ts",
      details: String(error),
      wikiFilePath,
    });
  }
});

app.listen(port, () => {
  console.log(
    `[wiki-editor-api] listening on http://localhost:${port} -> ${wikiFilePath}`,
  );
});
