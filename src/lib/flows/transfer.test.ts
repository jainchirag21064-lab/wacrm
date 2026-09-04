import { describe, expect, it } from "vitest";
import {
  createFlowExportDocument,
  parseFlowExportDocument,
} from "./transfer";

const flow = {
  name: "Welcome",
  description: "A flow",
  trigger_type: "keyword" as const,
  trigger_config: { keywords: ["hi"] },
  entry_node_id: "start",
  fallback_policy: {
    on_unknown_reply: "reprompt" as const,
    max_reprompts: 2,
    on_timeout_hours: 24,
    on_exhaust: "handoff" as const,
  },
};

const nodes = [
  {
    node_key: "start",
    node_type: "start",
    config: { next_node_key: "message" },
  },
  {
    node_key: "message",
    node_type: "send_message",
    config: { text: "Hello", next_node_key: "end" },
    position_x: 120,
    position_y: 240,
  },
];

describe("flow transfer", () => {
  it("exports and parses a developer-readable flow document", () => {
    const parsed = parseFlowExportDocument(createFlowExportDocument(flow, nodes));
    expect(parsed.flow.name).toBe("Welcome");
    expect(parsed.nodes[1]).toMatchObject({
      node_key: "message",
      position_x: 120,
      position_y: 240,
    });
  });

  it("rejects duplicate node keys and missing entry nodes", () => {
    const document = createFlowExportDocument(flow, nodes);
    expect(() =>
      parseFlowExportDocument({
        ...document,
        flow: { ...document.flow, entry_node_id: "missing" },
      }),
    ).toThrow("does not exist");

    expect(() =>
      parseFlowExportDocument({
        ...document,
        nodes: [document.nodes[0], document.nodes[0]],
      }),
    ).toThrow("Duplicate node_key");
  });
});
