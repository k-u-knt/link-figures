import { AdjustmentRegistry } from "./adjustment";
import { CommandRegistry } from "./command";
import { ExporterRegistry } from "./exporter";
import { NodeTypeRegistry } from "./node-type";

export interface Registries {
  commands: CommandRegistry;
  nodeTypes: NodeTypeRegistry;
  exporters: ExporterRegistry;
  adjustments: AdjustmentRegistry;
}

export function createRegistries(): Registries {
  return { commands: new CommandRegistry(), nodeTypes: new NodeTypeRegistry(), exporters: new ExporterRegistry(), adjustments: new AdjustmentRegistry() };
}
