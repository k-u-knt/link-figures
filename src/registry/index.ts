import { AdjustmentRegistry } from "./adjustment";
import { CapKindRegistry } from "./cap";
import { CommandRegistry } from "./command";
import { ExporterRegistry } from "./exporter";
import { LutRegistry } from "./lut";
import { NodeTypeRegistry } from "./node-type";
import { PaintRegistry } from "./paint";
import { RouteRegistry } from "./route";
import { ShapeKindRegistry } from "./shape-kind";
import { ShapeOperationRegistry } from "./shape-operation";
import { SnapSourceRegistry } from "./snap";

export interface Registries {
  commands: CommandRegistry;
  nodeTypes: NodeTypeRegistry;
  exporters: ExporterRegistry;
  adjustments: AdjustmentRegistry;
  paints: PaintRegistry;
  shapes: ShapeKindRegistry;
  routes: RouteRegistry;
  caps: CapKindRegistry;
  shapeOperations: ShapeOperationRegistry;
  snaps: SnapSourceRegistry;
  luts: LutRegistry;
}

export function createRegistries(): Registries {
  return {
    commands: new CommandRegistry(),
    nodeTypes: new NodeTypeRegistry(),
    exporters: new ExporterRegistry(),
    adjustments: new AdjustmentRegistry(),
    paints: new PaintRegistry(),
    shapes: new ShapeKindRegistry(),
    routes: new RouteRegistry(),
    caps: new CapKindRegistry(),
    shapeOperations: new ShapeOperationRegistry(),
    snaps: new SnapSourceRegistry(),
    luts: new LutRegistry(),
  };
}
