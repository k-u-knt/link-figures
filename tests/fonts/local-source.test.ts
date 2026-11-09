import { localFontSource, type LocalFontData } from "../../src/fonts/local-source";
import { faceNames, sfntTables, writeSfnt } from "../../src/fonts/sfnt";
import { createRegistries } from "../../src/registry";
import {
  FontLoadError,
  FontSourceRegistry,
  FontSourceUnavailableError,
  findFace,
  type FontSource,
  type LoadedFace,
} from "../../src/registry/font-source";
import { buildCollection, buildFont, type BuildStyle } from "./build-font";

/** A FontData-like record over `bytes`, the way `queryLocalFonts()` describes an installed face. */
const fontData = (family: string, style: string, bytes: Uint8Array, names: { fullName?: string; postscriptName?: string } = {}): LocalFontData => ({
  family,
  style,
  fullName: names.fullName ?? `${family} ${style}`,
  postscriptName: names.postscriptName ?? `${family.replace(/\s/g, "")}-${style.replace(/\s/g, "")}`,
  blob: async () => new Blob([bytes as Uint8Array<ArrayBuffer>]),
});

const built = (family: string, style: BuildStyle, extra: Partial<Parameters<typeof buildFont>[0]> = {}) =>
  buildFont({ family, style, chars: "abc", ...extra });

/** Installed faces for a family, one per style given. */
const family = (name: string, styles: BuildStyle[]) => styles.map((style) => fontData(name, style, built(name, style)));

/** A `name` table (Windows, US English) whose subfamily is any style name, e.g. "Light" or "Condensed Medium". */
const nameTable = (fam: string, style: string) => {
  const records: [number, string][] = [[1, fam], [2, style], [4, `${fam} ${style}`], [6, `${fam.replace(/\s/g, "")}-${style.replace(/\s/g, "")}`]];
  const utf16 = (t: string) => Uint8Array.from([...t].flatMap((c) => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 0xff]));
  const strings = records.map(([id, t]) => [id, utf16(t)] as const);
  const head = new DataView(new ArrayBuffer(6 + 12 * strings.length));
  head.setUint16(2, strings.length);
  head.setUint16(4, 6 + 12 * strings.length);
  let offset = 0;
  strings.forEach(([id, data], i) => {
    const at = 6 + 12 * i;
    head.setUint16(at, 3);
    head.setUint16(at + 2, 1);
    head.setUint16(at + 4, 0x409);
    head.setUint16(at + 6, id);
    head.setUint16(at + 8, data.length);
    head.setUint16(at + 10, offset);
    offset += data.length;
  });
  const out = new Uint8Array(head.byteLength + offset);
  out.set(new Uint8Array(head.buffer));
  let at = head.byteLength;
  for (const [, data] of strings) (out.set(data, at), (at += data.length));
  return out;
};

const source = (fonts: LocalFontData[]) => localFontSource(async () => fonts);

describe("localFontSource.find", () => {
  test("matches the family case-insensitively and gives the face asked for", async () => {
    const face = await source(family("Test Sans", ["Regular", "Bold"])).find("test SANS", "bold");
    expect(face).toMatchObject({ family: "Test Sans", style: "bold", exact: true });
    expect(faceNames(face!.bytes).subfamily).toBe("Bold");
  });

  test("matches a PostScript name like ArialMT, and the named face's style combines with the style asked for", async () => {
    const fonts = [
      fontData("Arial", "Regular", built("Arial", "Regular"), { postscriptName: "ArialMT" }),
      fontData("Arial", "Bold", built("Arial", "Bold"), { postscriptName: "Arial-BoldMT" }),
    ];
    const local = source(fonts);
    const regular = await local.find("ArialMT", "normal");
    expect(regular).toMatchObject({ family: "Arial", style: "normal", exact: true });
    expect(await local.find("arialmt", "bold")).toMatchObject({ family: "Arial", style: "bold", exact: true });
    expect(await local.find("Arial-BoldMT", "normal")).toMatchObject({ family: "Arial", style: "bold", exact: true });
    expect(await local.find("Arial Bold", "normal")).toMatchObject({ style: "bold", exact: true }); // the full name
  });

  test("maps the FontData style names to the four styles", async () => {
    const fonts = [
      fontData("Test Sans", "Normal", built("Test Sans", "Regular")),
      fontData("Test Sans", "Oblique", built("Test Sans", "Italic")),
      fontData("Test Sans", "Bold Italic", built("Test Sans", "Bold Italic")),
      fontData("Test Sans", "Semibold", built("Test Sans", "Bold")),
    ];
    const local = source(fonts);
    for (const style of ["normal", "italic", "bolditalic", "bold"] as const) {
      expect(await local.find("Test Sans", style)).toMatchObject({ style, exact: true });
    }
  });

  test("prefers the exact Bold face over a heavier weight name that contains Bold", async () => {
    const fonts = [
      fontData("Test Sans", "Regular", built("Test Sans", "Regular")),
      fontData("Test Sans", "ExtraBold", built("Test Sans", "Italic")), // distinguishable bytes
      fontData("Test Sans", "Bold", built("Test Sans", "Bold")),
    ];
    const face = await source(fonts).find("Test Sans", "bold");
    expect(faceNames(face!.bytes).subfamily).toBe("Bold");
  });

  test("a missing bold gives the regular face with exact false", async () => {
    const face = await source(family("Test Sans", ["Regular", "Italic"])).find("Test Sans", "bold");
    expect(face).toMatchObject({ family: "Test Sans", style: "normal", exact: false });
    expect(faceNames(face!.bytes).subfamily).toBe("Regular");
  });

  test("a family with no regular face still stands in with one of its faces", async () => {
    const face = await source(family("Test Sans", ["Bold"])).find("Test Sans", "italic");
    expect(face).toMatchObject({ style: "bold", exact: false });
  });

  test("an unknown name gives null", async () => {
    expect(await source(family("Test Sans", ["Regular"])).find("Other Sans", "normal")).toBeNull();
  });

  test("a variable font counts only as its default style: its Bold named instance is ignored", async () => {
    const variable = built("Var Sans", "Regular", { fvar: true });
    const fonts = [fontData("Var Sans", "Regular", variable), fontData("Var Sans", "Bold", variable)];
    const local = source(fonts);
    expect(await local.find("Var Sans", "bold")).toMatchObject({ style: "normal", exact: false });
    expect(await local.find("VarSans-Bold", "normal")).toMatchObject({ style: "normal", exact: false });
    expect(await local.find("Var Sans", "normal")).toMatchObject({ style: "normal", exact: true });
  });

  test("extracts the matching face from a TrueType Collection", async () => {
    const ttc = buildCollection([built("Test Sans", "Regular"), built("Test Sans", "Bold")]);
    const fonts = [fontData("Test Sans", "Regular", ttc), fontData("Test Sans", "Bold", ttc)];
    const local = source(fonts);
    const bold = await local.find("Test Sans", "bold");
    expect(bold).toMatchObject({ style: "bold", exact: true });
    expect(faceNames(bold!.bytes)).toMatchObject({ subfamily: "Bold", postscriptName: "TestSans-Bold" });
    expect(faceNames((await local.find("Test Sans", "normal"))!.bytes).subfamily).toBe("Regular");
  });

  test("CFF outlines give FontLoadError cff", async () => {
    const otto = built("Test Sans", "Regular", { flavour: "OTTO" });
    await expect(source([fontData("Test Sans", "Regular", otto)]).find("Test Sans", "normal")).rejects.toMatchObject({
      name: "FontLoadError",
      reason: "cff",
    });
  });

  test("a garbage blob gives FontLoadError unreadable", async () => {
    const garbage = new TextEncoder().encode("this is not a font at all, just text");
    const error = await source([fontData("Test Sans", "Regular", garbage)]).find("Test Sans", "normal").catch((e) => e);
    expect(error).toBeInstanceOf(FontLoadError);
    expect(error.reason).toBe("unreadable");
  });

  test("a TrueType font jsPDF cannot parse gives unreadable (the trial parse)", async () => {
    const font = built("Test Sans", "Regular");
    const noCmap = writeSfnt(font.subarray(0, 4), sfntTables(font).filter((t) => t.tag !== "cmap"));
    await expect(source([fontData("Test Sans", "Regular", noCmap)]).find("Test Sans", "normal")).rejects.toMatchObject({ reason: "unreadable" });
  });

  test("a blob that cannot be read gives unreadable", async () => {
    const broken: LocalFontData = { ...fontData("Test Sans", "Regular", built("Test Sans", "Regular")), blob: async () => Promise.reject(new Error("gone")) };
    await expect(source([broken]).find("Test Sans", "normal")).rejects.toMatchObject({ reason: "unreadable" });
  });
});

describe("localFontSource.find, fix round 1", () => {
  /** A face whose bytes say which installed face it is (its subfamily is the FontData style). */
  const face = (fam: string, style: string, psName?: string) => {
    const bytes = buildFont({ family: fam, style: "Regular", chars: "abc" });
    const tables = sfntTables(bytes).map((t) => (t.tag === "name" ? { tag: "name", data: nameTable(fam, style) } : t));
    return fontData(fam, style, writeSfnt(bytes.subarray(0, 4), tables), psName ? { postscriptName: psName } : {});
  };
  const subfamily = (f: LoadedFace | null) => (f ? faceNames(f.bytes).subfamily : null);

  test("a named face whose style is not one of the four is that face, not the family's Regular", async () => {
    const fonts = [face("Myriad Pro", "Regular", "MyriadPro-Regular"), face("Myriad Pro", "Light", "MyriadPro-Light"), face("Myriad Pro", "Italic", "MyriadPro-It")];
    const local = source(fonts);
    const light = await local.find("MyriadPro-Light", "normal");
    expect(light).toMatchObject({ exact: true, style: "normal" });
    expect(subfamily(light)).toBe("Light");
    expect(subfamily(await local.find("myriad pro light", "normal"))).toBe("Light"); // the full name
    const italic = await local.find("MyriadPro-Light", "italic");
    expect(italic).toMatchObject({ exact: false });
    expect(subfamily(italic)).toBe("Light");
  });

  test("with no Regular face, the stand-in is the most suitable face, not the first listed", async () => {
    const futura = ["Condensed ExtraBold", "Medium Italic", "Bold", "Condensed Medium", "Medium"].map((st) => face("Futura", st));
    const local = source(futura);
    expect(subfamily(await local.find("Futura", "normal"))).toBe("Medium");
    expect(subfamily(await local.find("Futura", "italic"))).toBe("Medium Italic");
    expect(await local.find("Futura", "bold")).toMatchObject({ exact: true });
    expect(subfamily(await local.find("Futura", "bolditalic"))).toBe("Bold");
  });

  test("a bad candidate does not stop the lookup; the error is thrown only when no face works", async () => {
    const otto = buildFont({ family: "Test Sans", style: "Regular", chars: "abc", flavour: "OTTO" });
    const local = source([fontData("Test Sans", "Regular", otto), fontData("Test Sans", "Book", built("Test Sans", "Regular"))]);
    expect(await local.find("Test Sans", "normal")).toMatchObject({ exact: true });
    await expect(source([fontData("Test Sans", "Regular", otto)]).find("Test Sans", "bold")).rejects.toMatchObject({ reason: "cff" });
  });

  test("Book, Roman and Regular Italic are italic; Semibold beats Condensed and Extra bold names", async () => {
    for (const st of ["Book Italic", "Roman Italic", "Regular Italic"]) {
      expect(await source([face("Test Sans", "Regular"), face("Test Sans", st)]).find("Test Sans", "italic")).toMatchObject({ exact: true });
    }
    const fonts = ["Regular", "Bold Condensed", "ExtraBold", "Semibold"].map((st) => face("Test Sans", st));
    expect(subfamily(await source(fonts).find("Test Sans", "bold"))).toBe("Semibold");
  });

  test("a collection face with a bad version tag, a colour-bitmap face and an oversized face are unreadable", async () => {
    const regularFace = built("Test Sans", "Regular");
    const bad = buildCollection([regularFace, built("Test Sans", "Bold")]);
    new DataView(bad.buffer).setUint32(12 + 4, 0);
    await expect(source([fontData("Test Sans", "Bold", bad)]).find("Test Sans", "bold")).rejects.toMatchObject({ reason: "unreadable" });

    const emoji = writeSfnt(regularFace.subarray(0, 4), [...sfntTables(built("Emoji", "Regular")), { tag: "sbix", data: new Uint8Array(8) }]);
    await expect(source([fontData("Emoji", "Regular", emoji)]).find("Emoji", "normal")).rejects.toMatchObject({ reason: "unreadable" });
    const cbdtTtc = buildCollection([writeSfnt(regularFace.subarray(0, 4), [...sfntTables(built("Emoji", "Regular")), { tag: "CBDT", data: new Uint8Array(8) }])]);
    await expect(source([fontData("Emoji", "Regular", cbdtTtc)]).find("Emoji", "normal")).rejects.toMatchObject({ reason: "unreadable" });

    const small = { maxFaceBytes: regularFace.length - 1 };
    await expect(localFontSource(async () => [fontData("Test Sans", "Regular", regularFace)], small).find("Test Sans", "normal")).rejects.toMatchObject({ reason: "unreadable" });
    const ttc = buildCollection([regularFace]);
    const faceTableBytes = sfntTables(regularFace).reduce((sum, t) => sum + t.data.length, 0);
    const smallFace = { maxFaceBytes: faceTableBytes - 1 };
    await expect(localFontSource(async () => [fontData("Test Sans", "Regular", ttc)], smallFace).find("Test Sans", "normal")).rejects.toMatchObject({ reason: "unreadable" });
    // A collection larger than the limit is still read when its face fits.
    expect(await localFontSource(async () => [fontData("Test Sans", "Regular", ttc)], { maxFaceBytes: faceTableBytes }).find("Test Sans", "normal")).toMatchObject({ exact: true });
    // The default limit is 50 MB, checked on the blob's size before it is read.
    const huge: LocalFontData = { ...fontData("Big", "Regular", regularFace), blob: async () => ({ size: 51 * 1024 * 1024, slice: () => new Blob([regularFace.slice(0, 4)]), arrayBuffer: () => Promise.reject(new Error("read")) }) as unknown as Blob };
    await expect(source([huge]).find("Big", "normal")).rejects.toMatchObject({ reason: "unreadable" });
  });
});

describe("localFontSource priming and caching", () => {
  const securityError = () => Object.assign(new Error("Page needs to be visible"), { name: "SecurityError" });

  test("a refused query makes prime false and find throw unavailable; a later prime lists the fonts", async () => {
    let visible = false;
    const query = vi.fn(async () => {
      if (!visible) throw securityError();
      return family("Test Sans", ["Regular", "Bold"]);
    });
    const local = localFontSource(query);
    expect(await local.prime()).toBe(false);
    await expect(local.find("Test Sans", "normal")).rejects.toBeInstanceOf(FontSourceUnavailableError);
    await expect(local.list()).rejects.toBeInstanceOf(FontSourceUnavailableError);
    const registries = { fontSources: new FontSourceRegistry() };
    registries.fontSources.register(local);
    expect(await findFace(registries, ["Test Sans"], "normal")).toEqual({ face: null, reason: "unavailable" });

    visible = true;
    expect(await local.prime()).toBe(true);
    expect(await local.list()).toEqual(["Test Sans"]);
    expect(await local.find("Test Sans", "bold")).toMatchObject({ exact: true });
  });

  test("the list is cached: query is called once after a successful prime", async () => {
    const query = vi.fn(async () => family("Test Sans", ["Regular"]));
    const local = localFontSource(query);
    expect(await local.prime()).toBe(true);
    expect(await local.prime()).toBe(true);
    await local.list();
    await local.find("Test Sans", "normal");
    await local.find("Missing", "normal");
    expect(query).toHaveBeenCalledTimes(1);
  });

  test("concurrent primes share one query", async () => {
    const query = vi.fn(async () => family("Test Sans", ["Regular"]));
    const local = localFontSource(query);
    expect(await Promise.all([local.prime(), local.prime(), local.list()])).toEqual([true, true, ["Test Sans"]]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  test("find primes on demand when load-time priming never ran", async () => {
    const query = vi.fn(async () => family("Test Sans", ["Regular"]));
    expect(await localFontSource(query).find("Test Sans", "normal")).toMatchObject({ exact: true });
    expect(query).toHaveBeenCalledTimes(1);
  });

  test("list gives each family once, in order", async () => {
    const fonts = [...family("Test Sans", ["Regular", "Bold"]), ...family("Other", ["Regular"]), fontData("test sans", "Italic", built("Test Sans", "Italic"))];
    expect(await source(fonts).list()).toEqual(["Test Sans", "Other"]);
  });

  test("with no queryLocalFonts, the default source lists nothing and finds nothing", async () => {
    const local = localFontSource();
    expect(await local.prime()).toBe(true);
    expect(await local.list()).toEqual([]);
    expect(await local.find("Arial", "normal")).toBeNull();
  });
});

describe("FontSourceRegistry and findFace", () => {
  const face = (family: string): LoadedFace => ({ bytes: new Uint8Array(), family, style: "normal", exact: true });
  const fake = (id: string, find: FontSource["find"]): FontSource => ({ id, name: id, list: async () => [], find });

  test("createRegistries has an empty fontSources registry; re-registering replaces in place", () => {
    const r = createRegistries();
    expect(r.fontSources.all()).toEqual([]);
    r.fontSources.register(fake("a", async () => null));
    r.fontSources.register(fake("b", async () => null));
    r.fontSources.register({ ...fake("a", async () => null), name: "A2" });
    expect(r.fontSources.all().map((s) => s.id)).toEqual(["a", "b"]);
    expect(r.fontSources.get("a")!.name).toBe("A2");
  });

  test("tries each name in order, asking every source, and the first face wins", async () => {
    const r = { fontSources: new FontSourceRegistry() };
    const calls: string[] = [];
    r.fontSources.register(fake("one", async (name) => (calls.push(`one:${name}`), name === "Late" ? face("one-Late") : null)));
    r.fontSources.register(fake("two", async (name) => (calls.push(`two:${name}`), name === "Second" ? face("two-Second") : null)));
    expect(await findFace(r, ["First", "Second", "Late"], "normal")).toEqual({ face: face("two-Second") });
    expect(calls).toEqual(["one:First", "two:First", "one:Second", "two:Second"]);
  });

  test("with no face, the reason is the first load error, else unavailable, else missing", async () => {
    const r = { fontSources: new FontSourceRegistry() };
    expect(await findFace(r, ["X"], "normal")).toEqual({ face: null, reason: "missing" });
    r.fontSources.register(fake("hidden", async () => Promise.reject(new FontSourceUnavailableError())));
    expect(await findFace(r, ["X"], "normal")).toEqual({ face: null, reason: "unavailable" });
    r.fontSources.register(fake("cff", async (name) => Promise.reject(new FontLoadError(name === "X" ? "cff" : "unreadable"))));
    expect(await findFace(r, ["X", "Y"], "normal")).toEqual({ face: null, reason: "cff" });
    expect(await findFace(r, ["Y", "X"], "normal")).toEqual({ face: null, reason: "unreadable" });
  });

  test("a later name still wins after an earlier name's load error", async () => {
    const r = { fontSources: new FontSourceRegistry() };
    r.fontSources.register(fake("s", async (name) => (name === "Bad" ? Promise.reject(new FontLoadError("cff")) : face(name))));
    expect(await findFace(r, ["Bad", "Good"], "bold")).toEqual({ face: face("Good") });
  });

  test("an unexpected error from a source counts as unreadable", async () => {
    const r = { fontSources: new FontSourceRegistry() };
    r.fontSources.register(fake("s", async () => Promise.reject(new TypeError("boom"))));
    expect(await findFace(r, ["X"], "normal")).toEqual({ face: null, reason: "unreadable" });
  });
});
