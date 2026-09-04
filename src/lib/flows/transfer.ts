import type { FlowRow } from "./types";

export const FLOW_EXPORT_VERSION = 1;

export interface FlowExportDocument {
  format: "wacrm-flow";
  version: typeof FLOW_EXPORT_VERSION;
  flow: {
    name: string;
    description: string | null;
    trigger_type: FlowRow["trigger_type"];
    trigger_config: Record<string, unknown>;
    entry_node_id: string | null;
    fallback_policy: FlowRow["fallback_policy"];
  };
  nodes: Array<{
    node_key: string;
    node_type: string;
    config: Record<string, unknown>;
    position_x: number;
    position_y: number;
  }>;
}

export function createFlowExportDocument(
  flow: Pick<
    FlowRow,
    | "name"
    | "description"
    | "trigger_type"
    | "trigger_config"
    | "entry_node_id"
    | "fallback_policy"
  >,
  nodes: Array<{
    node_key: string;
    node_type: string;
    config: Record<string, unknown>;
    position_x?: number;
    position_y?: number;
  }>,
): FlowExportDocument {
  return {
    format: "wacrm-flow",
    version: FLOW_EXPORT_VERSION,
    flow: {
      name: flow.name,
      description: flow.description,
      trigger_type: flow.trigger_type,
      trigger_config: flow.trigger_config as Record<string, unknown>,
      entry_node_id: flow.entry_node_id,
      fallback_policy: flow.fallback_policy,
    },
    nodes: nodes.map((node) => ({
      node_key: node.node_key,
      node_type: node.node_type,
      config: node.config,
      position_x: node.position_x ?? 0,
      position_y: node.position_y ?? 0,
    })),
  };
}

export function parseFlowExportDocument(value: unknown): FlowExportDocument {
  if (!value || typeof value !== "object") {
    throw new Error("The file must contain a JSON object.");
  }
  const document = value as Partial<FlowExportDocument>;
  if (document.format !== "wacrm-flow" || document.version !== FLOW_EXPORT_VERSION) {
    throw new Error(`Unsupported flow file. Expected wacrm-flow version ${FLOW_EXPORT_VERSION}.`);
  }
  if (!document.flow || typeof document.flow !== "object") {
    throw new Error("The flow metadata is missing.");
  }
  if (!Array.isArray(document.nodes)) {
    throw new Error("The flow nodes must be an array.");
  }
  if (!document.flow.name?.trim()) {
    throw new Error("The imported flow needs a name.");
  }
  const keys = new Set<string>();
  for (const node of document.nodes) {
    if (!node || typeof node !== "object" || !node.node_key || !node.node_type) {
      throw new Error("Every node needs node_key and node_type.");
    }
    if (keys.has(node.node_key)) {
      throw new Error(`Duplicate node_key "${node.node_key}".`);
    }
    keys.add(node.node_key);
  }
  if (document.flow.entry_node_id && !keys.has(document.flow.entry_node_id)) {
    throw new Error(`Entry node "${document.flow.entry_node_id}" does not exist.`);
  }
  return document as FlowExportDocument;
}
