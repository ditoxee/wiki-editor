export type WikiCard = {
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
};
