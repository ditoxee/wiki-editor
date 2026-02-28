import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { Extension, Node, mergeAttributes } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import { TextStyle } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import TextAlign from "@tiptap/extension-text-align";
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import Image from "@tiptap/extension-image";
import HorizontalRule from "@tiptap/extension-horizontal-rule";
import type { WikiBlock, WikiSection } from "./types";

type LocalWritable = {
  write: (data: string) => Promise<void>;
  close: () => Promise<void>;
};

type LocalFileHandle = {
  name: string;
  getFile: () => Promise<File>;
  createWritable?: () => Promise<LocalWritable>;
};

type PickerWindow = Window &
  typeof globalThis & {
    showOpenFilePicker?: (options?: unknown) => Promise<LocalFileHandle[]>;
    showSaveFilePicker?: (options?: unknown) => Promise<LocalFileHandle>;
  };

const COLORS = [
  "#22190f",
  "#b37b2a",
  "#d3a24f",
  "#8f5b14",
  "#2f5d8a",
  "#5c2f87",
  "#8a2f45",
  "#2f6f58",
];

const EMOJIS = ["🔥", "✨", "⚔️", "🛡️", "📌", "✅", "🎯", "💡", "📅", "🎉"];
const FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32];
const AUTO_SAVE_DEBOUNCE_MS = 1200;
const LOCAL_DRAFT_KEY = "wiki-editor-local-draft";

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

const ALERT_PRESETS = {
  danger: {
    title: "Важное напоминание!",
    icon: "⛔",
  },
  warning: {
    title: "Предупреждение",
    icon: "⚠️",
  },
  success: {
    title: "Рекомендация",
    icon: "✅",
  },
} as const;

type AlertVariant = keyof typeof ALERT_PRESETS;

const normalizeAlertVariant = (value: unknown): AlertVariant => {
  if (value === "warning" || value === "success" || value === "danger") {
    return value;
  }
  return "danger";
};

const genId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

const isIdentifier = (key: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);

const serializeTsValue = (value: unknown, depth = 0): string => {
  const pad = "  ".repeat(depth);
  const nextPad = "  ".repeat(depth + 1);

  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);

  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    const lines = value.map(
      (item) => `${nextPad}${serializeTsValue(item, depth + 1)}`,
    );
    return `[\n${lines.join(",\n")}\n${pad}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, entryValue]) => entryValue !== undefined,
    );

    if (!entries.length) return "{}";

    const lines = entries.map(([key, entryValue]) => {
      const safeKey = isIdentifier(key) ? key : JSON.stringify(key);
      return `${nextPad}${safeKey}: ${serializeTsValue(entryValue, depth + 1)}`;
    });

    return `{\n${lines.join(",\n")}\n${pad}}`;
  }

  return JSON.stringify(value);
};

const serializeWikiFile = (sections: WikiSection[]) =>
  `${TYPE_DEFS}

export const wikiSections: WikiSection[] = ${serializeTsValue(sections, 0)};
`;

const extractWikiSectionsLiteral = (source: string) => {
  const exportMatch =
    /export const wikiSections(?:\s*:\s*WikiSection\[\])?\s*=\s*/.exec(source);

  if (!exportMatch || exportMatch.index === undefined) {
    throw new Error("Не найден экспорт `wikiSections`.");
  }

  let cursor = exportMatch.index + exportMatch[0].length;
  while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
  if (source[cursor] !== "[") {
    throw new Error("Ожидался массив после `wikiSections =`.");
  }

  const start = cursor;
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  while (cursor < source.length) {
    const char = source[cursor];
    const next = source[cursor + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      cursor += 1;
      continue;
    }

    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        cursor += 2;
        continue;
      }
      cursor += 1;
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      cursor += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      lineComment = true;
      cursor += 2;
      continue;
    }

    if (char === "/" && next === "*") {
      blockComment = true;
      cursor += 2;
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      cursor += 1;
      continue;
    }

    if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, cursor + 1);
      }
    }

    cursor += 1;
  }

  throw new Error("Не удалось извлечь массив `wikiSections`.");
};

const parseWikiSections = (source: string): WikiSection[] => {
  const literal = extractWikiSectionsLiteral(source);
  const parsed = Function(`"use strict"; return (${literal});`)();
  if (!Array.isArray(parsed)) {
    throw new Error("`wikiSections` должен быть массивом.");
  }
  return parsed as WikiSection[];
};

const blockToRichHtml = (block: WikiBlock) => {
  let html = "";

  if (block.description) {
    html += `<p>${escapeHtml(block.description)}</p>`;
  }

  if (block.bullets?.length) {
    html += `<ul>${block.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("")}</ul>`;
  }

  if (block.cards?.length) {
    html += `<div class="wiki-grid wiki-grid-2">${block.cards
      .map((card) => {
        const description = card.description
          ? `<p>${escapeHtml(card.description)}</p>`
          : "";
        const bullets = card.bullets?.length
          ? `<ul>${card.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("")}</ul>`
          : "";
        return `<div class="wiki-card">${`<h4>${escapeHtml(card.title)}</h4>`}${description}${bullets}</div>`;
      })
      .join("")}</div>`;
  }

  if (block.table) {
    const head = block.table.columns
      .map((column) => `<th>${escapeHtml(column)}</th>`)
      .join("");
    const body = block.table.rows
      .map(
        (row) =>
          `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`,
      )
      .join("");

    html += `<div class="wiki-table-wrap"><table class="wiki-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  if (block.note) {
    html += `<div class="wiki-card">${escapeHtml(block.note)}</div>`;
  }

  return html || "<p>Новый блок...</p>";
};

const createEmptyBlock = (): WikiBlock => ({
  id: genId("block"),
  title: "Новый блок",
  richContent: "<p>Введите текст блока...</p>",
});

const createEmptySection = (): WikiSection => ({
  id: genId("section"),
  title: "Новый раздел",
  summary: "Краткое описание раздела.",
  updated: new Date().toLocaleDateString("ru-RU"),
  sourcePost: "manual",
  badges: ["Новый"],
  blocks: [createEmptyBlock()],
});

const normalizeSections = (sections: WikiSection[]): WikiSection[] =>
  sections.map((section, sectionIndex) => {
    const sourceBlocks = Array.isArray(section.blocks) ? section.blocks : [];
    const blocks =
      sourceBlocks.length > 0
        ? sourceBlocks.map((block, blockIndex) => ({
            ...block,
            id: block.id || genId(`block-${sectionIndex}-${blockIndex}`),
            title: block.title || `Блок ${blockIndex + 1}`,
            richContent: block.richContent ?? blockToRichHtml(block),
          }))
        : [createEmptyBlock()];

    return {
      ...section,
      id: section.id || genId(`section-${sectionIndex}`),
      title: section.title || `Раздел ${sectionIndex + 1}`,
      summary: section.summary || "",
      updated: section.updated || new Date().toLocaleDateString("ru-RU"),
      sourcePost: section.sourcePost || "manual",
      badges: Array.isArray(section.badges) ? section.badges : [],
      blocks,
    };
  });

const normalizeUrl = (url: string) =>
  /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;

const formatClock = (date: Date) =>
  date.toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

const toYoutubeEmbed = (url: string) => {
  const watchMatch = url.match(/[?&]v=([a-zA-Z0-9_-]{6,})/);
  if (watchMatch?.[1]) return `https://www.youtube.com/embed/${watchMatch[1]}`;
  const shortMatch = url.match(/youtu\.be\/([a-zA-Z0-9_-]{6,})/);
  if (shortMatch?.[1]) return `https://www.youtube.com/embed/${shortMatch[1]}`;
  return "";
};

const FontSize = Extension.create({
  name: "fontSize",
  addGlobalAttributes() {
    return [
      {
        types: ["textStyle"],
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element: HTMLElement) => element.style.fontSize || null,
            renderHTML: (attributes: { fontSize?: string | null }) => {
              if (!attributes.fontSize) return {};
              return { style: `font-size: ${attributes.fontSize}` };
            },
          },
        },
      },
    ];
  },
});

const MediaEmbed = Node.create({
  name: "mediaEmbed",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      src: {
        default: "",
      },
      kind: {
        default: "iframe",
      },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-type="media-embed"]',
        getAttrs: (element: unknown) => {
          const target = element as HTMLElement;
          const kind =
            target.getAttribute("data-kind") === "video" ? "video" : "iframe";
          const src = target.getAttribute("data-src") || "";
          return { kind, src };
        },
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    const kind = HTMLAttributes.kind === "video" ? "video" : "iframe";
    const src =
      typeof HTMLAttributes.src === "string" ? HTMLAttributes.src : "";

    if (kind === "video") {
      return [
        "div",
        mergeAttributes(HTMLAttributes, {
          "data-type": "media-embed",
          "data-kind": "video",
          "data-src": src,
          class: "wiki-media wiki-media--video",
        }),
        ["video", { controls: "true", src }],
      ];
    }

    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "media-embed",
        "data-kind": "iframe",
        "data-src": src,
        class: "wiki-media wiki-media--iframe",
      }),
      [
        "iframe",
        {
          src,
          frameborder: "0",
          allowfullscreen: "true",
          allow:
            "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share",
        },
      ],
    ];
  },
});

const SpoilerBlock = Node.create({
  name: "spoilerBlock",
  group: "block",
  content: "block+",
  isolating: true,
  defining: true,
  addAttributes() {
    return {
      title: {
        default: "Спойлер",
      },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'details[data-type="spoiler-block"]',
        getAttrs: (element: unknown) => {
          const target = element as HTMLElement;
          const summary = target.querySelector(":scope > summary");
          const title = summary?.textContent?.trim() || "Спойлер";
          return { title };
        },
        contentElement: ":scope > .wiki-spoiler__body",
      } as never,
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    const title =
      typeof node.attrs.title === "string" && node.attrs.title.trim().length > 0
        ? node.attrs.title.trim()
        : "Спойлер";

    return [
      "details",
      mergeAttributes(HTMLAttributes, {
        "data-type": "spoiler-block",
        "data-title": title,
        class: "wiki-spoiler",
        open: "open",
      }),
      ["summary", { contenteditable: "false" }, title],
      ["div", { class: "wiki-spoiler__body" }, 0],
    ];
  },
});

const AlertBox = Node.create({
  name: "alertBox",
  group: "block",
  content: "block+",
  isolating: true,
  defining: true,
  addAttributes() {
    return {
      variant: {
        default: "danger",
      },
      title: {
        default: ALERT_PRESETS.danger.title,
      },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-type="alert-box"]',
        getAttrs: (element: unknown) => {
          const target = element as HTMLElement;
          const variant = normalizeAlertVariant(
            target.getAttribute("data-variant"),
          );
          const title =
            target.getAttribute("data-title") ||
            target.querySelector(
              ":scope > .wiki-alert__content > .wiki-alert__title",
            )?.textContent ||
            ALERT_PRESETS[variant].title;

          return {
            variant,
            title,
          };
        },
        contentElement: ":scope > .wiki-alert__content > .wiki-alert__body",
      } as never,
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    const variant = normalizeAlertVariant(node.attrs.variant);
    const fallback = ALERT_PRESETS[variant];
    const title =
      typeof node.attrs.title === "string" && node.attrs.title.trim().length > 0
        ? node.attrs.title.trim()
        : fallback.title;

    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "alert-box",
        "data-variant": variant,
        "data-title": title,
        class: `wiki-alert wiki-alert--${variant}`,
      }),
      [
        "div",
        { class: "wiki-alert__icon", contenteditable: "false" },
        fallback.icon,
      ],
      [
        "div",
        { class: "wiki-alert__content" },
        ["p", { class: "wiki-alert__title", contenteditable: "false" }, title],
        ["div", { class: "wiki-alert__body" }, 0],
      ],
    ];
  },
});

const EditorApp = () => {
  const [sections, setSections] = useState<WikiSection[]>([]);
  const [selectedSectionId, setSelectedSectionId] = useState("");
  const [selectedBlockId, setSelectedBlockId] = useState("");
  const [status, setStatus] = useState(
    "Выберите файл wikiData.ts через кнопку «Открыть файл».",
  );
  const [dirty, setDirty] = useState(false);
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(true);
  const [autoSaving, setAutoSaving] = useState(false);
  const [fileName, setFileName] = useState("wikiData.ts");
  const [fileHandle, setFileHandle] = useState<LocalFileHandle | null>(null);
  const [fontSizeValue, setFontSizeValue] = useState("16");
  const [colorValue, setColorValue] = useState(COLORS[0]);

  const selectedSectionIdRef = useRef(selectedSectionId);
  const selectedBlockIdRef = useRef(selectedBlockId);
  const applyingExternalContentRef = useRef(false);
  const autoSaveTimerRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    selectedSectionIdRef.current = selectedSectionId;
  }, [selectedSectionId]);

  useEffect(() => {
    selectedBlockIdRef.current = selectedBlockId;
  }, [selectedBlockId]);

  const selectedSection = useMemo(
    () => sections.find((section) => section.id === selectedSectionId),
    [sections, selectedSectionId],
  );

  const selectedBlock = useMemo(
    () => selectedSection?.blocks.find((block) => block.id === selectedBlockId),
    [selectedSection, selectedBlockId],
  );

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [1, 2, 3, 4],
        },
      }),
      Underline,
      Link.configure({
        autolink: true,
        openOnClick: false,
        defaultProtocol: "https",
      }),
      TextStyle,
      Color,
      FontSize,
      TextAlign.configure({
        types: ["heading", "paragraph"],
      }),
      Table.configure({
        resizable: true,
      }),
      TableRow,
      TableCell,
      TableHeader,
      Image.configure({
        allowBase64: true,
      }),
      HorizontalRule,
      MediaEmbed,
      SpoilerBlock,
      AlertBox,
    ],
    content: "<p>Откройте wikiData.ts или создайте новый файл.</p>",
    editorProps: {
      attributes: {
        class: "editor-prose",
        dir: "ltr",
      },
    },
    onUpdate: ({ editor: currentEditor }) => {
      if (applyingExternalContentRef.current) return;

      const sectionId = selectedSectionIdRef.current;
      const blockId = selectedBlockIdRef.current;
      if (!sectionId || !blockId) return;

      const html = currentEditor.getHTML();
      setSections((prev) =>
        prev.map((section) => {
          if (section.id !== sectionId) return section;
          return {
            ...section,
            blocks: section.blocks.map((block) =>
              block.id === blockId ? { ...block, richContent: html } : block,
            ),
          };
        }),
      );
      setDirty(true);
    },
  });

  useEffect(() => {
    if (!sections.length) {
      const draft = window.localStorage.getItem(LOCAL_DRAFT_KEY);
      if (draft) {
        try {
          const parsed = parseWikiSections(draft);
          const normalized = normalizeSections(parsed);
          if (normalized.length) {
            setSections(normalized);
            setSelectedSectionId(normalized[0].id);
            setSelectedBlockId(normalized[0].blocks[0].id);
            setStatus(
              "Восстановлен локальный черновик автосохранения. Откройте файл и нажмите «Сохранить», чтобы записать его.",
            );
            setDirty(true);
            return;
          }
        } catch {
          window.localStorage.removeItem(LOCAL_DRAFT_KEY);
        }
      }

      const section = createEmptySection();
      setSections([section]);
      setSelectedSectionId(section.id);
      setSelectedBlockId(section.blocks[0].id);
    }
  }, [sections.length]);

  useEffect(() => {
    if (!sections.length) return;
    if (!sections.some((section) => section.id === selectedSectionId)) {
      setSelectedSectionId(sections[0].id);
    }
  }, [sections, selectedSectionId]);

  useEffect(() => {
    if (!selectedSection) return;
    if (!selectedSection.blocks.some((block) => block.id === selectedBlockId)) {
      setSelectedBlockId(selectedSection.blocks[0]?.id ?? "");
    }
  }, [selectedSection, selectedBlockId]);

  useEffect(() => {
    if (!editor || !selectedBlock) return;
    const nextContent =
      selectedBlock.richContent?.trim() || "<p>Введите содержимое блока...</p>";
    if (editor.getHTML() === nextContent) return;

    applyingExternalContentRef.current = true;
    editor.commands.setContent(nextContent, { emitUpdate: false });
    applyingExternalContentRef.current = false;
  }, [editor, selectedSectionId, selectedBlockId, selectedBlock]);

  useEffect(() => {
    if (!editor) return;

    const syncState = () => {
      const attrs = editor.getAttributes("textStyle") as {
        color?: string;
        fontSize?: string;
      };

      if (attrs.color && attrs.color !== colorValue) {
        setColorValue(attrs.color);
      }

      if (attrs.fontSize) {
        const match = attrs.fontSize.match(/\d+/);
        if (match?.[0]) {
          const nextSize = match[0];
          if (
            FONT_SIZES.includes(Number(nextSize)) &&
            nextSize !== fontSizeValue
          ) {
            setFontSizeValue(nextSize);
          }
        }
      }
    };

    syncState();
    editor.on("selectionUpdate", syncState);
    editor.on("transaction", syncState);

    return () => {
      editor.off("selectionUpdate", syncState);
      editor.off("transaction", syncState);
    };
  }, [editor, colorValue, fontSizeValue]);

  const setSectionsAndResetSelection = (nextSections: WikiSection[]) => {
    const normalized = normalizeSections(nextSections);
    setSections(normalized);
    setSelectedSectionId(normalized[0]?.id ?? "");
    setSelectedBlockId(normalized[0]?.blocks[0]?.id ?? "");
  };

  const applyLoadedFile = (
    rawContent: string,
    loadedFileName: string,
    handle: LocalFileHandle | null,
  ) => {
    const parsed = parseWikiSections(rawContent);
    const normalized = normalizeSections(parsed);
    if (!normalized.length) {
      throw new Error("В файле нет разделов.");
    }

    setSectionsAndResetSelection(normalized);
    setFileName(loadedFileName);
    setFileHandle(handle);
    window.localStorage.removeItem(LOCAL_DRAFT_KEY);
    setStatus(`Файл загружен: ${loadedFileName}`);
    setDirty(false);
  };

  const handleOpenFile = async () => {
    try {
      const pickerWindow = window as PickerWindow;
      if (pickerWindow.showOpenFilePicker) {
        const [handle] = await pickerWindow.showOpenFilePicker({
          multiple: false,
          types: [
            {
              description: "TypeScript",
              accept: {
                "text/plain": [".ts", ".js", ".txt"],
                "application/json": [".json"],
              },
            },
          ],
        });

        if (!handle) return;
        const file = await handle.getFile();
        const text = await file.text();
        applyLoadedFile(text, file.name, handle);
        return;
      }

      fileInputRef.current?.click();
    } catch (error) {
      setStatus(`Ошибка открытия файла: ${String(error)}`);
    }
  };

  const handleFallbackFileInput = async (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    try {
      const file = event.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      applyLoadedFile(text, file.name, null);
    } catch (error) {
      setStatus(`Ошибка чтения файла: ${String(error)}`);
    } finally {
      event.target.value = "";
    }
  };

  const saveToHandle = async (handle: LocalFileHandle, content: string) => {
    if (!handle.createWritable) {
      throw new Error(
        "Выбранный режим браузера не поддерживает прямую запись в файл.",
      );
    }
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
  };

  const handleSaveAs = async () => {
    try {
      if (autoSaveTimerRef.current !== null) {
        window.clearTimeout(autoSaveTimerRef.current);
      }
      const payload = serializeWikiFile(sections);
      const pickerWindow = window as PickerWindow;

      if (pickerWindow.showSaveFilePicker) {
        const handle = await pickerWindow.showSaveFilePicker({
          suggestedName: fileName || "wikiData.ts",
          types: [
            {
              description: "TypeScript",
              accept: {
                "text/plain": [".ts"],
              },
            },
          ],
        });

        await saveToHandle(handle, payload);
        setFileHandle(handle);
        setFileName(handle.name || "wikiData.ts");
        setDirty(false);
        setStatus(`Файл сохранён: ${handle.name || "wikiData.ts"}`);
        return;
      }

      const blob = new Blob([payload], { type: "text/plain;charset=utf-8" });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = fileName || "wikiData.ts";
      anchor.click();
      URL.revokeObjectURL(href);

      setDirty(false);
      setStatus(`Файл выгружен: ${fileName || "wikiData.ts"}`);
    } catch (error) {
      setStatus(`Ошибка сохранения: ${String(error)}`);
    }
  };

  const handleSave = async () => {
    try {
      if (autoSaveTimerRef.current !== null) {
        window.clearTimeout(autoSaveTimerRef.current);
      }
      if (!sections.length) {
        setStatus("Нет данных для сохранения.");
        return;
      }

      const payload = serializeWikiFile(sections);
      if (!fileHandle) {
        await handleSaveAs();
        return;
      }

      await saveToHandle(fileHandle, payload);
      setDirty(false);
      setStatus(`Файл сохранён: ${fileHandle.name}`);
    } catch (error) {
      setStatus(`Ошибка сохранения: ${String(error)}`);
    }
  };

  useEffect(() => {
    if (!autoSaveEnabled || !dirty || !sections.length) return;

    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
    }

    autoSaveTimerRef.current = window.setTimeout(async () => {
      const payload = serializeWikiFile(sections);

      try {
        setAutoSaving(true);
        const savedAt = formatClock(new Date());

        if (fileHandle) {
          await saveToHandle(fileHandle, payload);
          setDirty(false);
          setStatus(`Автосохранено в ${fileHandle.name} (${savedAt})`);
          return;
        }

        window.localStorage.setItem(LOCAL_DRAFT_KEY, payload);
        setStatus(
          `Черновик автосохранён локально (${savedAt}). Выберите файл для записи на диск.`,
        );
      } catch (error) {
        setStatus(`Ошибка автосохранения: ${String(error)}`);
      } finally {
        setAutoSaving(false);
      }
    }, AUTO_SAVE_DEBOUNCE_MS);

    return () => {
      if (autoSaveTimerRef.current !== null) {
        window.clearTimeout(autoSaveTimerRef.current);
      }
    };
  }, [autoSaveEnabled, dirty, sections, fileHandle]);

  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current !== null) {
        window.clearTimeout(autoSaveTimerRef.current);
      }
    };
  }, []);

  const handleCreateNewFile = () => {
    const section = createEmptySection();
    setSections([section]);
    setSelectedSectionId(section.id);
    setSelectedBlockId(section.blocks[0].id);
    setFileHandle(null);
    setFileName("wikiData.ts");
    setDirty(true);
    setStatus("Создан новый шаблон. Сохраните его через «Сохранить как».");
  };

  const updateSelectedBlock = (updater: (block: WikiBlock) => WikiBlock) => {
    if (!selectedSectionId || !selectedBlockId) return;
    setSections((prev) =>
      prev.map((section) => {
        if (section.id !== selectedSectionId) return section;
        return {
          ...section,
          blocks: section.blocks.map((block) =>
            block.id === selectedBlockId ? updater(block) : block,
          ),
        };
      }),
    );
    setDirty(true);
  };

  const addSection = () => {
    const section = createEmptySection();
    setSections((prev) => [...prev, section]);
    setSelectedSectionId(section.id);
    setSelectedBlockId(section.blocks[0].id);
    setDirty(true);
  };

  const removeSection = () => {
    if (!selectedSectionId || sections.length <= 1) return;
    const next = sections.filter((section) => section.id !== selectedSectionId);
    setSections(next);
    setSelectedSectionId(next[0]?.id ?? "");
    setSelectedBlockId(next[0]?.blocks[0]?.id ?? "");
    setDirty(true);
  };

  const addBlock = () => {
    if (!selectedSectionId) return;
    const block = createEmptyBlock();
    setSections((prev) =>
      prev.map((section) =>
        section.id === selectedSectionId
          ? { ...section, blocks: [...section.blocks, block] }
          : section,
      ),
    );
    setSelectedBlockId(block.id);
    setDirty(true);
  };

  const removeBlock = () => {
    if (
      !selectedSection ||
      !selectedBlockId ||
      selectedSection.blocks.length <= 1
    )
      return;

    const nextBlocks = selectedSection.blocks.filter(
      (block) => block.id !== selectedBlockId,
    );
    setSections((prev) =>
      prev.map((section) =>
        section.id === selectedSection.id
          ? { ...section, blocks: nextBlocks }
          : section,
      ),
    );
    setSelectedBlockId(nextBlocks[0].id);
    setDirty(true);
  };

  const applyFontSize = (size: string) => {
    setFontSizeValue(size);
    if (!editor) return;
    editor
      .chain()
      .focus()
      .setMark("textStyle", { fontSize: `${size}px` })
      .run();
  };

  const applyTextColor = (color: string) => {
    setColorValue(color);
    if (!editor) return;
    editor.chain().focus().setColor(color).run();
  };

  const clearFormatting = () => {
    if (!editor) return;
    editor.chain().focus().unsetAllMarks().clearNodes().run();
  };

  const insertLink = () => {
    if (!editor) return;
    const previousUrl =
      (editor.getAttributes("link").href as string | undefined) || "";
    const input = window.prompt("Введите ссылку", previousUrl || "https://");
    if (input === null) return;

    const url = input.trim();
    if (!url) {
      editor.chain().focus().unsetLink().run();
      return;
    }

    const href = normalizeUrl(url);
    if (editor.state.selection.empty) {
      editor
        .chain()
        .focus()
        .insertContent({
          type: "text",
          text: href,
          marks: [
            {
              type: "link",
              attrs: {
                href,
                target: "_blank",
                rel: "noopener noreferrer nofollow",
              },
            },
          ],
        })
        .run();
      return;
    }

    editor
      .chain()
      .focus()
      .extendMarkRange("link")
      .setLink({
        href,
        target: "_blank",
        rel: "noopener noreferrer nofollow",
      })
      .run();
  };

  const insertMediaByUrl = () => {
    if (!editor) return;
    const input = window.prompt(
      "Вставьте ссылку на медиа (картинка / YouTube / mp4 / webm)",
      "https://",
    );
    if (!input) return;

    const url = input.trim();
    const imageMatch = /\.(png|jpg|jpeg|gif|webp|svg|avif)$/i.test(url);
    const videoMatch = /\.(mp4|webm|ogg)$/i.test(url);
    const youtubeEmbed = toYoutubeEmbed(url);

    if (imageMatch) {
      editor.chain().focus().setImage({ src: url }).run();
      return;
    }

    if (videoMatch) {
      editor
        .chain()
        .focus()
        .insertContent({
          type: "mediaEmbed",
          attrs: { kind: "video", src: url },
        })
        .run();
      return;
    }

    if (youtubeEmbed) {
      editor
        .chain()
        .focus()
        .insertContent({
          type: "mediaEmbed",
          attrs: { kind: "iframe", src: youtubeEmbed },
        })
        .run();
      return;
    }

    const href = normalizeUrl(url);
    editor
      .chain()
      .focus()
      .insertContent({
        type: "text",
        text: href,
        marks: [
          {
            type: "link",
            attrs: {
              href,
              target: "_blank",
              rel: "noopener noreferrer nofollow",
            },
          },
        ],
      })
      .run();
  };

  const insertImageFromComputer = () => {
    imageInputRef.current?.click();
  };

  const handleImageInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !editor) return;

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") return;
      editor
        .chain()
        .focus()
        .setImage({ src: reader.result, alt: file.name })
        .run();
    };
    reader.readAsDataURL(file);
    event.target.value = "";
  };

  const insertSpoiler = () => {
    if (!editor) return;
    const title = window.prompt("Заголовок спойлера", "Спойлер");
    if (title === null) return;

    editor
      .chain()
      .focus()
      .insertContent({
        type: "spoilerBlock",
        attrs: {
          title: title.trim() || "Спойлер",
        },
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Скрытый текст..." }],
          },
        ],
      })
      .run();
  };

  const insertCodeBlock = () => {
    if (!editor) return;
    editor
      .chain()
      .focus()
      .insertContent({
        type: "codeBlock",
        content: [{ type: "text", text: "// ваш код" }],
      })
      .run();
  };

  const insertAlertBox = (variant: AlertVariant) => {
    if (!editor) return;
    const fallback = ALERT_PRESETS[variant];
    const title = window.prompt("Заголовок блока", fallback.title);
    if (title === null) return;

    editor
      .chain()
      .focus()
      .insertContent({
        type: "alertBox",
        attrs: {
          variant,
          title: title.trim() || fallback.title,
        },
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "Добавьте описание для этого информационного блока.",
              },
            ],
          },
        ],
      })
      .run();
  };

  const fileLabel = fileHandle?.name || fileName;

  return (
    <div className="editor-app">
      <div className="editor-bg" />

      <header className="editor-topbar">
        <div>
          <h1>Wiki Editor</h1>
          <p>
            Отдельное локальное приложение. Файл открывается и сохраняется
            напрямую на ваш компьютер.
          </p>
          <span className="editor-path">
            {fileLabel}
            {dirty ? " • есть несохранённые изменения" : " • синхронизировано"}
          </span>
        </div>

        <div className="editor-top-actions">
          <button
            className="editor-action"
            onClick={() => setAutoSaveEnabled((prev) => !prev)}
          >
            Автосохранение: {autoSaveEnabled ? "Вкл" : "Выкл"}
          </button>
          <button className="editor-action" onClick={handleOpenFile}>
            Открыть файл
          </button>
          <button className="editor-action" onClick={handleCreateNewFile}>
            Новый файл
          </button>
          <button
            className="editor-action editor-action--primary"
            onClick={() => void handleSave()}
          >
            Сохранить
          </button>
          <button className="editor-action" onClick={() => void handleSaveAs()}>
            Сохранить как
          </button>
        </div>
      </header>

      <input
        ref={fileInputRef}
        type="file"
        accept=".ts,.js,.txt,.json"
        hidden
        onChange={handleFallbackFileInput}
      />
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={handleImageInput}
      />

      <main className="editor-layout">
        <aside className="editor-sidebar">
          <div className="editor-panel-head">
            <h2>Разделы</h2>
            <div className="editor-footer-left">
              <button className="editor-mini-btn" onClick={addSection}>
                + Раздел
              </button>
              <button className="editor-mini-btn" onClick={removeSection}>
                - Раздел
              </button>
            </div>
          </div>

          <div className="editor-sidebar-scroll">
            {sections.map((section) => {
              const sectionActive = section.id === selectedSectionId;

              return (
                <div key={section.id} className="editor-section-item">
                  <button
                    className={`editor-section-btn ${sectionActive ? "is-active" : ""}`}
                    onClick={() => setSelectedSectionId(section.id)}
                  >
                    {section.title}
                  </button>

                  {sectionActive ? (
                    <div className="editor-block-list">
                      {section.blocks.map((block) => (
                        <button
                          key={block.id}
                          className={`editor-block-btn ${
                            block.id === selectedBlockId ? "is-active" : ""
                          }`}
                          onClick={() => setSelectedBlockId(block.id)}
                        >
                          {block.title}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </aside>

        <section className="editor-main">
          {selectedSection && selectedBlock ? (
            <>
              <div className="editor-meta-grid">
                <label className="editor-field">
                  <span>Название раздела</span>
                  <input
                    value={selectedSection.title}
                    onChange={(event) => {
                      const next = event.target.value;
                      setSections((prev) =>
                        prev.map((section) =>
                          section.id === selectedSection.id
                            ? { ...section, title: next }
                            : section,
                        ),
                      );
                      setDirty(true);
                    }}
                  />
                </label>

                <label className="editor-field">
                  <span>Обновлено</span>
                  <input
                    value={selectedSection.updated}
                    onChange={(event) => {
                      const next = event.target.value;
                      setSections((prev) =>
                        prev.map((section) =>
                          section.id === selectedSection.id
                            ? { ...section, updated: next }
                            : section,
                        ),
                      );
                      setDirty(true);
                    }}
                  />
                </label>

                <label className="editor-field editor-field--wide">
                  <span>Summary</span>
                  <input
                    value={selectedSection.summary}
                    onChange={(event) => {
                      const next = event.target.value;
                      setSections((prev) =>
                        prev.map((section) =>
                          section.id === selectedSection.id
                            ? { ...section, summary: next }
                            : section,
                        ),
                      );
                      setDirty(true);
                    }}
                  />
                </label>

                <label className="editor-field">
                  <span>Название блока</span>
                  <input
                    value={selectedBlock.title}
                    onChange={(event) => {
                      const next = event.target.value;
                      updateSelectedBlock((block) => ({
                        ...block,
                        title: next,
                      }));
                    }}
                  />
                </label>

                <label className="editor-field editor-field--wide">
                  <span>Бейджи (через запятую)</span>
                  <input
                    value={selectedSection.badges.join(", ")}
                    onChange={(event) => {
                      const badges = event.target.value
                        .split(",")
                        .map((item) => item.trim())
                        .filter(Boolean);

                      setSections((prev) =>
                        prev.map((section) =>
                          section.id === selectedSection.id
                            ? { ...section, badges }
                            : section,
                        ),
                      );
                      setDirty(true);
                    }}
                  />
                </label>
              </div>

              <div className="editor-toolbar">
                <div className="editor-toolbar-row">
                  <button
                    className="editor-button"
                    data-active={editor?.isActive("bold") || false}
                    onClick={() => editor?.chain().focus().toggleBold().run()}
                  >
                    Жирный
                  </button>
                  <button
                    className="editor-button"
                    data-active={editor?.isActive("italic") || false}
                    onClick={() => editor?.chain().focus().toggleItalic().run()}
                  >
                    Курсив
                  </button>
                  <button
                    className="editor-button"
                    data-active={editor?.isActive("underline") || false}
                    onClick={() =>
                      editor?.chain().focus().toggleUnderline().run()
                    }
                  >
                    Подчерк.
                  </button>
                  <button
                    className="editor-button"
                    data-active={editor?.isActive("strike") || false}
                    onClick={() => editor?.chain().focus().toggleStrike().run()}
                  >
                    Зачерк.
                  </button>
                  <button className="editor-button" onClick={clearFormatting}>
                    Очистить
                  </button>

                  <select
                    className="editor-select-compact"
                    value={fontSizeValue}
                    onChange={(event) => applyFontSize(event.target.value)}
                  >
                    {FONT_SIZES.map((size) => (
                      <option key={size} value={size}>
                        {size}px
                      </option>
                    ))}
                  </select>

                  <input
                    className="editor-color"
                    type="color"
                    value={colorValue}
                    onChange={(event) => applyTextColor(event.target.value)}
                  />

                  {COLORS.map((color) => (
                    <button
                      key={color}
                      className="editor-color-dot"
                      style={{ background: color }}
                      onClick={() => applyTextColor(color)}
                      aria-label={`Цвет ${color}`}
                    />
                  ))}
                </div>

                <div className="editor-toolbar-row">
                  <button
                    className="editor-button"
                    data-active={editor?.isActive("bulletList") || false}
                    onClick={() =>
                      editor?.chain().focus().toggleBulletList().run()
                    }
                  >
                    Маркированный
                  </button>
                  <button
                    className="editor-button"
                    data-active={editor?.isActive("orderedList") || false}
                    onClick={() =>
                      editor?.chain().focus().toggleOrderedList().run()
                    }
                  >
                    Нумерованный
                  </button>
                  <button
                    className="editor-button"
                    onClick={() =>
                      editor?.chain().focus().sinkListItem("listItem").run()
                    }
                  >
                    Отступ +
                  </button>
                  <button
                    className="editor-button"
                    onClick={() =>
                      editor?.chain().focus().liftListItem("listItem").run()
                    }
                  >
                    Отступ -
                  </button>

                  <button
                    className="editor-button"
                    data-active={
                      editor?.isActive({ textAlign: "left" }) || false
                    }
                    onClick={() =>
                      editor?.chain().focus().setTextAlign("left").run()
                    }
                  >
                    Слева
                  </button>
                  <button
                    className="editor-button"
                    data-active={
                      editor?.isActive({ textAlign: "center" }) || false
                    }
                    onClick={() =>
                      editor?.chain().focus().setTextAlign("center").run()
                    }
                  >
                    Центр
                  </button>
                  <button
                    className="editor-button"
                    data-active={
                      editor?.isActive({ textAlign: "right" }) || false
                    }
                    onClick={() =>
                      editor?.chain().focus().setTextAlign("right").run()
                    }
                  >
                    Справа
                  </button>
                </div>

                <div className="editor-toolbar-row">
                  <button className="editor-button" onClick={insertLink}>
                    Ссылка
                  </button>
                  <button className="editor-button" onClick={insertMediaByUrl}>
                    Медиа URL
                  </button>
                  <button
                    className="editor-button"
                    onClick={insertImageFromComputer}
                  >
                    Картинка с ПК
                  </button>
                  <button
                    className="editor-button"
                    onClick={() =>
                      editor
                        ?.chain()
                        .focus()
                        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
                        .run()
                    }
                  >
                    Таблица
                  </button>
                  <button
                    className="editor-button"
                    onClick={() =>
                      editor?.chain().focus().setHorizontalRule().run()
                    }
                  >
                    Линия
                  </button>
                  <button className="editor-button" onClick={insertSpoiler}>
                    Спойлер
                  </button>
                  <button className="editor-button" onClick={insertCodeBlock}>
                    Код
                  </button>
                </div>

                <div className="editor-toolbar-row">
                  <button
                    className="editor-button"
                    onClick={() => insertAlertBox("danger")}
                  >
                    Внимание (красный)
                  </button>
                  <button
                    className="editor-button"
                    onClick={() => insertAlertBox("warning")}
                  >
                    Предупреждение (жёлтый)
                  </button>
                  <button
                    className="editor-button"
                    onClick={() => insertAlertBox("success")}
                  >
                    Рекомендация (зелёный)
                  </button>
                  {EMOJIS.map((emoji) => (
                    <button
                      key={emoji}
                      className="editor-emoji-btn"
                      onClick={() =>
                        editor?.chain().focus().insertContent(emoji).run()
                      }
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>

              <div className="editor-surface">
                <EditorContent editor={editor} />
              </div>

              <div className="editor-footer">
                <div className="editor-footer-left">
                  <button className="editor-mini-btn" onClick={addBlock}>
                    + Блок
                  </button>
                  <button className="editor-mini-btn" onClick={removeBlock}>
                    - Блок
                  </button>
                </div>

                <div className="editor-status">
                  <span>{status}</span>
                  <span>
                    {autoSaving
                      ? "Автосохранение..."
                      : dirty
                        ? "Есть несохранённые изменения"
                        : autoSaveEnabled
                          ? "Готово • автосохранение активно"
                          : "Готово"}
                  </span>
                </div>
              </div>
            </>
          ) : (
            <div className="editor-empty">
              <p>Выберите раздел и блок для редактирования.</p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
};

export default EditorApp;
