import { createDecorator } from "@toyz/loom";

export interface SearchEntry {
  title: string;
  section: string;
  to: string;
  keywords: string[];
  summary: string;
}

const entries: SearchEntry[] = [];

export const searchable = createDecorator<[entry: SearchEntry]>(
  (_constructor, entry) => entries.push(entry),
  { class: true },
);

export function searchDocs(query: string): SearchEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return entries.filter((entry) =>
    [entry.title, entry.section, entry.summary, ...entry.keywords]
      .join(" ")
      .toLowerCase()
      .includes(needle),
  ).slice(0, 8);
}
