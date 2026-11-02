import { AdjustmentRegistry } from "./adjustment";
import { CommandRegistry } from "./command";
import { ExporterRegistry } from "./exporter";
import { NodeTypeRegistry } from "./node-type";
import { PaintRegistry } from "./paint";
import { ShapeKindRegistry } from "./shape-kind";

export interface Registries {
  commands: CommandRegistry;
  nodeTypes: NodeTypeRegistry;
  exporters: ExporterRegistry;
  adjustments: AdjustmentRegistry;
  paints: PaintRegistry;
  shapes: ShapeKindRegistry;
}

export function createRegistries(): Registries {
  return {
    commands: new CommandRegistry(),
    nodeTypes: new NodeTypeRegistry(),
    exporters: new ExporterRegistry(),
    adjustments: new AdjustmentRegistry(),
    paints: new PaintRegistry(),
    shapes: new ShapeKindRegistry(),
  };
}
