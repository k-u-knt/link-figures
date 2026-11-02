import { toSvgPath, transformPath, pathBounds, distanceToPath, flattenPath, pointAtEnd, rectPath, ellipsePath, clipToOutline, type PathData } from "../../src/model/path";

const cubic: PathData = [{ op: "M", x: 0, y: 0 }, { op: "C", x1: 0, y1: 100, x2: 100, y2: 100, x: 100, y: 0 }];

test("toSvgPath writes M, L, C and Z with unrounded numbers", () => {
  const p: PathData = [{ op: "M", x: 1.25, y: 2 }, { op: "L", x: 3, y: 4.123456789 }, { op: "C", x1: 1, y1: 2, x2: 3, y2: 4, x: 5, y: 6 }, { op: "Z" }];
  expect(toSvgPath(p)).toBe("M1.25 2 L3 4.123456789 C1 2 3 4 5 6 Z");
});

test("transformPath maps every point", () => {
  const t = transformPath(cubic, [2, 0, 0, 1, 10, 5]);
  expect(t[0]).toEqual({ op: "M", x: 10, y: 5 });
  expect(t[1]).toEqual({ op: "C", x1: 10, y1: 105, x2: 210, y2: 105, x: 210, y: 5 });
});

test("pathBounds finds a cubic's extremum between its control points", () => {
  const b = pathBounds(cubic);
  expect(b.x).toBeCloseTo(0);
  expect(b.width).toBeCloseTo(100);
  expect(b.y).toBeCloseTo(0);
  expect(b.height).toBeCloseTo(75); // peak of the curve at t = 0.5 is 0.75 of the control height
});

test("rectPath clamps the radius to half the short side", () => {
  const p = rectPath({ x: 0, y: 0, width: 100, height: 50 }, 80);
  expect(p[0]).toEqual({ op: "M", x: 25, y: 0 });
  expect(pathBounds(p)).toEqual({ x: 0, y: 0, width: 100, height: 50 });
});

test("ellipsePath bounds equal its rect", () => {
  const b = pathBounds(ellipsePath({ x: 10, y: 20, width: 60, height: 40 }));
  expect(b.x).toBeCloseTo(10); expect(b.y).toBeCloseTo(20); expect(b.width).toBeCloseTo(60); expect(b.height).toBeCloseTo(40);
});

test("distanceToPath to a line and to a cubic", () => {
  const line: PathData = [{ op: "M", x: 0, y: 0 }, { op: "L", x: 10, y: 0 }];
  expect(distanceToPath(line, { x: 5, y: 3 })).toBeCloseTo(3);
  expect(distanceToPath(line, { x: 13, y: 4 })).toBeCloseTo(5);
  expect(distanceToPath(cubic, { x: 50, y: 75 })).toBeCloseTo(0, 1);
  expect(distanceToPath(cubic, { x: 50, y: 85 })).toBeCloseTo(10, 1);
});

test("flattenPath gives polylines and closes closed subpaths", () => {
  const lines = flattenPath([...rectPath({ x: 0, y: 0, width: 10, height: 10 }, 0), { op: "M", x: 50, y: 50 }, { op: "L", x: 60, y: 50 }], 0.1);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toHaveLength(5);
  expect(lines[0][4]).toEqual({ x: 0, y: 0 });
  expect(flattenPath(cubic, 0.01)[0].length).toBeGreaterThan(10);
});

test("pointAtEnd tangents point out of the path", () => {
  const line: PathData = [{ op: "M", x: 0, y: 0 }, { op: "L", x: 10, y: 0 }];
  expect(pointAtEnd(line, 0)).toEqual({ pt: { x: 0, y: 0 }, tangent: { x: -1, y: 0 } });
  expect(pointAtEnd(line, 1)).toEqual({ pt: { x: 10, y: 0 }, tangent: { x: 1, y: 0 } });
  const s = pointAtEnd(cubic, 0);
  expect(s.tangent.x).toBeCloseTo(0); expect(s.tangent.y).toBeCloseTo(-1);
  const e = pointAtEnd(cubic, 1);
  expect(e.pt).toEqual({ x: 100, y: 0 }); expect(e.tangent.y).toBeCloseTo(-1);
});

test("clipToOutline hits the rect's edge from the centre and is null with no crossing", () => {
  const outline = rectPath({ x: 0, y: 0, width: 100, height: 50 }, 0);
  expect(clipToOutline({ x: 50, y: 25 }, { x: 200, y: 25 }, outline)).toEqual({ x: 100, y: 25 });
  expect(clipToOutline({ x: 50, y: 25 }, { x: 60, y: 25 }, outline)).toBeNull();
  expect(clipToOutline({ x: 200, y: 100 }, { x: 300, y: 100 }, outline)).toBeNull();
});

test("degenerate input stays finite", () => {
  const zeroRect = rectPath({ x: 5, y: 5, width: 0, height: 0 }, 10);
  const zeroLine: PathData = [{ op: "M", x: 3, y: 3 }, { op: "L", x: 3, y: 3 }];
  for (const p of [zeroRect, zeroLine, ellipsePath({ x: 0, y: 0, width: 0, height: 0 }), []]) {
    const b = pathBounds(p);
    expect([b.x, b.y, b.width, b.height].every(Number.isFinite)).toBe(true);
    for (const w of [0, 1] as const) {
      const e = pointAtEnd(p, w);
      expect([e.pt.x, e.pt.y, e.tangent.x, e.tangent.y].every(Number.isFinite)).toBe(true);
    }
    expect(flattenPath(p, 0.1).flat().every((q) => Number.isFinite(q.x) && Number.isFinite(q.y))).toBe(true);
  }
  expect(distanceToPath(zeroLine, { x: 6, y: 7 })).toBeCloseTo(5);
  expect(distanceToPath(zeroRect, { x: 8, y: 9 })).toBeCloseTo(5);
  expect(clipToOutline({ x: 0, y: 0 }, { x: 10, y: 10 }, zeroLine)).toBeNull();
  expect(clipToOutline({ x: 3, y: 3 }, { x: 3, y: 3 }, zeroRect)).toBeNull();
});
