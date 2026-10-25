import { describe, expect, it } from "vitest";
import { FakeEngine } from "../test/fakeEngine.ts";
import { buildTimelineGraph, generationNodeId, NODE_H, NODE_W } from "./layout.ts";

describe("Explore card layout", () => {
  it("keeps enlarged cards and attempt nodes separated", () => {
    const engine = new FakeEngine();
    const { nodes, edges } = buildTimelineGraph(engine.view(), engine.generations);
    expect(nodes.length).toBeGreaterThan(3);
    for (const node of nodes) {
      expect(node.width).toBe(NODE_W);
      expect(node.height).toBe(NODE_H);
      for (const other of nodes.filter((candidate) => candidate.id !== node.id)) {
        const separated = node.position.x + NODE_W + 16 <= other.position.x || other.position.x + NODE_W + 16 <= node.position.x ||
          node.position.y + NODE_H + 16 <= other.position.y || other.position.y + NODE_H + 16 <= node.position.y;
        expect(separated, `${node.id} and ${other.id} need breathing room`).toBe(true);
      }
    }
    for (const edge of edges) {
      const parent = nodes.find((node) => node.id === edge.source)!;
      const child = nodes.find((node) => node.id === edge.target)!;
      expect(child.position.x).toBeGreaterThan(parent.position.x + NODE_W);
    }
  });

  it("keeps positions deterministic when API records change order", () => {
    const engine = new FakeEngine();
    const normal = buildTimelineGraph(engine.view(), engine.generations);
    const reversed = buildTimelineGraph(engine.view().reverse(), [...engine.generations].reverse());
    const positions = (nodes: typeof normal.nodes) => Object.fromEntries(nodes.map((node) => [node.id, node.position]));
    expect(positions(reversed.nodes)).toEqual(positions(normal.nodes));
  });

  it("never turns failed or cancelled generation attempts into timeline nodes", () => {
    const engine = new FakeEngine();
    const { nodes } = buildTimelineGraph(engine.view(), engine.generations);
    for (const generation of engine.generations.filter((item) => ["failed", "cancelled"].includes(item.status))) {
      const node = nodes.find((item) => item.id === generationNodeId(generation.id));
      expect(node?.type).toBe("ghost");
    }
  });
});
