import { newId, createPage, createDocument, fileNodeDefaults, textNodeDefaults } from "../../src/model/defaults";
import { DEFAULT_FONT, MM_TO_PX } from "../../src/constants";

test("newId avoids collisions", () => { const id = newId("p", ["p-aaaa"]); expect(id).toMatch(/^p-[a-z0-9]{4}$/); expect(id).not.toBe("p-aaaa"); });
test("createDocument has one page from the preset", () => { const d = createDocument("a4-portrait"); expect(d.pages).toHaveLength(1); expect(d.pages[0]).toMatchObject({ width: 210, height: 297, paper: "#ffffff" }); expect(d.nodes).toEqual([]); expect(d.version).toBe(1); });
test("fileNodeDefaults sizes to 40% of page width", () => { const p = createPage("nature-double", []); const n = fileNodeDefaults(p, { file: "a.png", subpath: "", show: "image" }, []); expect(n.width).toBeCloseTo(0.4 * 183 * MM_TO_PX, 3); expect(n.page).toBe(p.id); expect(n.crop).toBeNull(); expect(n.fit).toBe("cover"); expect(n.pageIndex).toBe(0); expect(n.range).toBe("auto"); });
test("textNodeDefaults uses Arial 7 pt and does not share the font object", () => { const p = createPage("a4-portrait", []); const n = textNodeDefaults(p, {}, []); expect(n.font).toEqual(DEFAULT_FONT); expect(n.font).not.toBe(DEFAULT_FONT); expect(n.width).toBeCloseTo(30 * MM_TO_PX, 3); });
