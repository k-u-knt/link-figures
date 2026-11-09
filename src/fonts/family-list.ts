import { FontSourceUnavailableError, type FontSource, type FontSourceRegistry } from "../registry/font-source";

/** How long a source that fails with an unexpected error is left alone before it is asked again. */
export const RETRY_AFTER_MS = 30_000;

/**
 * The installed font families, for the inspector's Font menu: every registered source's list, merged, de-duplicated and
 * sorted case-insensitively. Each source is asked on its own, so one that fails does not hide the others' families.
 * `get()` is null until some source has listed; `onLoaded` is called each time the merged list changes. A source that
 * is unavailable now is asked again on the next `get()`; one that throws anything else is warned about once and asked
 * again at most every `RETRY_AFTER_MS`.
 */
export class FontFamilyList {
  private families: string[] | null = null;
  private readonly listed = new Map<string, string[]>();
  private readonly retryAt = new Map<string, number>();
  private readonly warned = new Set<string>();
  private loading = false;

  constructor(
    private readonly registries: { fontSources: FontSourceRegistry },
    private readonly onLoaded: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  get(): string[] | null {
    if (!this.loading) void this.load();
    return this.families;
  }

  private async load(): Promise<void> {
    const pending = this.registries.fontSources.all().filter((s) => !this.listed.has(s.id) && this.now() >= (this.retryAt.get(s.id) ?? 0));
    if (pending.length === 0) return;
    this.loading = true;
    let changed = false;
    try {
      for (const source of pending) changed = (await this.ask(source)) || changed;
    } finally {
      this.loading = false;
    }
    if (changed) {
      this.families = merge([...this.listed.values()]);
      this.onLoaded();
    }
  }

  /** Whether `source` gave families it had not given before. */
  private async ask(source: FontSource): Promise<boolean> {
    try {
      const names = await source.list();
      if (names.length === 0) return false;
      this.listed.set(source.id, names);
      return true;
    } catch (error) {
      if (!(error instanceof FontSourceUnavailableError)) {
        this.retryAt.set(source.id, this.now() + RETRY_AFTER_MS);
        if (!this.warned.has(source.id)) {
          this.warned.add(source.id);
          console.warn(`Link Figures: could not list the fonts of "${source.id}"`, error);
        }
      }
      return false;
    }
  }
}

function merge(lists: string[][]): string[] {
  const seen = new Map<string, string>();
  for (const names of lists) for (const name of names) if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  return [...seen.values()].sort(compareFamilies);
}

/** Case-insensitive order, ties broken by the exact spelling. */
export function compareFamilies(a: string, b: string): number {
  return a.toLowerCase().localeCompare(b.toLowerCase()) || (a < b ? -1 : a > b ? 1 : 0);
}
