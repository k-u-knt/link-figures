import type { LinkedPath } from "../registry/node-type";
import { splitWithoutAlias } from "./resolver";
import type { FileRef, VaultAccess } from "./types";

/** At most this many files are followed for one node, so a web of notes embedding each other stays cheap. */
export const MAX_LINKED_FILES = 64;

/**
 * The vault files a node's drawing reads (see `NodeType.linkedPaths`): each link's file, and, as Obsidian renders an
 * embed within an embed, every note a followed note embeds, however deep (each file once, at most `MAX_LINKED_FILES`).
 * `unresolved` when a link finds no file, which a file that appears later may be.
 */
export function linkedFiles(links: readonly LinkedPath[], access: Pick<VaultAccess, "resolveLink" | "embedsIn">): { paths: string[]; unresolved: boolean } {
  const found = new Map<string, FileRef>();
  let unresolved = false;
  const add = (ref: FileRef | null): void => {
    if (ref && !found.has(ref.path) && found.size < MAX_LINKED_FILES) found.set(ref.path, ref);
  };
  for (const { link, from } of links) {
    const ref = access.resolveLink(splitWithoutAlias(link).file, from);
    if (!ref) unresolved = true;
    add(ref);
  }
  // `found` grows as it is walked: what an embedded note embeds is followed in turn.
  for (const ref of found.values()) {
    if (ref.extension !== "md") continue;
    for (const embed of access.embedsIn(ref, { start: 0, end: null })) add(access.resolveLink(splitWithoutAlias(embed.link).file, ref.path));
  }
  return { paths: [...found.keys()], unresolved };
}
