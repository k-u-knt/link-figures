import type { NodeId } from "../model/types";

export interface LinkEntry {
  id: NodeId;
  linktext: string;
}

/** `- p-xxxx: ![[linktext]] ^p-xxxx`; the trailing block id is optional on read. */
const ENTRY_LINE = /^[-*+][ \t]+(\S+?):[ \t]+!\[\[(.+?)\]\](?:[ \t]+\^\S+)?[ \t]*$/;

/** `section` is the text between the `## Links` heading and the next section. Lines that are not entries are ignored. */
export function parseLinksSection(section: string): LinkEntry[] {
  const entries: LinkEntry[] = [];
  for (const line of section.split(/\r?\n/)) {
    const m = ENTRY_LINE.exec(line);
    if (m) entries.push({ id: m[1], linktext: m[2] });
  }
  return entries;
}

export function emitLinksSection(entries: LinkEntry[]): string {
  return "## Links\n" + entries.map((e) => `- ${e.id}: ![[${e.linktext}]] ^${e.id}\n`).join("") + "\n";
}

/** Splits at the first `#`; the subpath keeps its `#` (or is empty). */
export function splitLinktext(linktext: string): { file: string; subpath: string } {
  const i = linktext.indexOf("#");
  return i === -1 ? { file: linktext, subpath: "" } : { file: linktext.slice(0, i), subpath: linktext.slice(i) };
}

export function joinLinktext(file: string, subpath: string): string {
  return file + subpath;
}
