export {};

// `obsidian` ships only typings; the settings module needs these names to load.
vi.mock("obsidian", () => ({ PluginSettingTab: class {}, Setting: class {} }));
const { DEFAULT_SETTINGS, normaliseSettings } = await import("../../src/settings/settings");

describe("settings for dropping from a note", () => {
  test("default to linking by block id with the prefix fig", () => {
    expect(DEFAULT_SETTINGS.dropFromNote).toBe("block-id");
    expect(DEFAULT_SETTINGS.blockIdPrefix).toBe("fig");
  });

  test("saved settings without them take the defaults", () => {
    const s = normaliseSettings({ exportDpi: 600 });
    expect(s).toMatchObject({ exportDpi: 600, dropFromNote: "block-id", blockIdPrefix: "fig" });
  });

  test("each mode is kept; an unknown one is the default", () => {
    for (const mode of ["block-id", "heading", "direct"] as const) expect(normaliseSettings({ dropFromNote: mode }).dropFromNote).toBe(mode);
    expect(normaliseSettings({ dropFromNote: "copy" }).dropFromNote).toBe("block-id");
  });

  test("a prefix keeps only what an id can hold; nothing left is the default", () => {
    expect(normaliseSettings({ blockIdPrefix: "my fig_1" }).blockIdPrefix).toBe("myfig1");
    expect(normaliseSettings({ blockIdPrefix: "" }).blockIdPrefix).toBe("fig");
    expect(normaliseSettings({ blockIdPrefix: 3 }).blockIdPrefix).toBe("fig");
  });
});
