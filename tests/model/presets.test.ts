import { PAGE_PRESETS, getPreset } from "../../src/model/presets";

test("nature double is 183 x 170 mm", () => expect(getPreset("nature-double")).toMatchObject({ width: 183, height: 170 }));
test("every preset id is unique", () => expect(new Set(PAGE_PRESETS.map(p => p.id)).size).toBe(PAGE_PRESETS.length));
