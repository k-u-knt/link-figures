import { FontSourceUnavailableError, type FontSourceRegistry } from "../registry/font-source";

/**
 * The installed font families, for the inspector's Font menu: every registered source's list, merged, de-duplicated and
 * sorted case-insensitively. Loaded on the first `get()`; until it arrives `get()` is null, and when it does `onLoaded`
 * is called once. A source that cannot list now (or fails) leaves the list not yet available, and the next `get()`
 * tries again.
 */
export class FontFamilyList {
  private families: string[] | null = null;
  private loading = false;

  constructor(
    private readonly registries: { fontSources: FontSourceRegistry },
    private readonly onLoaded: () => void,
  ) {}

  get(): string[] | null {
    if (!this.families && !this.loading) void this.load();
    return this.families;
  }

  private async load(): Promise<void> {
    this.loading = true;
    try {
      const seen = new Map<string, string>();
      for (const source of this.registries.fontSources.all()) {
        // Unavailable now (FontSourceUnavailableError) or broken: treated the same, and asked again on the next need.
        const names = await source.list();
        for (const name of names) if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
      }
      if (seen.size === 0) return;
      this.families = [...seen.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || (a < b ? -1 : a > b ? 1 : 0));
    } catch (error) {
      if (!(error instanceof FontSourceUnavailableError)) console.warn("Link Figures: could not list installed fonts", error);
      return;
    } finally {
      this.loading = false;
    }
    this.onLoaded();
  }
}
