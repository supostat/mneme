import { describe, expect, test } from "bun:test";
import {
  PhaseGraphValidationError,
  buildPhaseGraph,
  readyPhaseIds,
  selectNextReadyPhase,
} from "./phase-graph";
import type { PhaseStatus } from "./phase-graph";
import type { PhaseDocument } from "./phase-document";

function phase(id: string, deps: string[] = []): PhaseDocument {
  return {
    id,
    deps,
    agentRole: "coder",
    description: "",
    tasks: ["do the work"],
    doneWhen: [{ description: "work is verified", command: "bun test" }],
  };
}

function diamondDocuments(): PhaseDocument[] {
  return [phase("a"), phase("b", ["a"]), phase("c", ["a"]), phase("d", ["b", "c"])];
}

describe("buildPhaseGraph", () => {
  test("a diamond graph builds with all phases present", () => {
    const graph = buildPhaseGraph(diamondDocuments());
    expect(Object.keys(graph.phases).sort()).toEqual(["a", "b", "c", "d"]);
    expect(graph.phases["d"]?.deps).toEqual(["b", "c"]);
  });

  test("an empty document list is rejected", () => {
    expect(() => buildPhaseGraph([])).toThrow(PhaseGraphValidationError);
  });

  test("duplicate phase ids are rejected", () => {
    expect(() => buildPhaseGraph([phase("a"), phase("a")])).toThrow(PhaseGraphValidationError);
  });

  test("an unknown dependency is rejected", () => {
    expect(() => buildPhaseGraph([phase("a", ["ghost"])])).toThrow(PhaseGraphValidationError);
  });

  test("a two-node cycle is rejected", () => {
    expect(() => buildPhaseGraph([phase("a", ["b"]), phase("b", ["a"])])).toThrow(
      PhaseGraphValidationError,
    );
  });

  test("a longer cycle is rejected", () => {
    expect(() =>
      buildPhaseGraph([phase("a", ["c"]), phase("b", ["a"]), phase("c", ["b"]), phase("root")]),
    ).toThrow(PhaseGraphValidationError);
  });

  test("a cycle reachable only through a later dependency is rejected", () => {
    expect(() => buildPhaseGraph([phase("a", ["safe", "b"]), phase("b", ["a"]), phase("safe")])).toThrow(
      PhaseGraphValidationError,
    );
  });

  test("a linear dependency chain of 50000 phases builds without stack overflow", () => {
    const chainLength = 50000;
    const documents: PhaseDocument[] = [];
    for (let index = 0; index < chainLength; index += 1) {
      const deps = index + 1 < chainLength ? [`p${index + 1}`] : [];
      documents.push(phase(`p${index}`, deps));
    }
    const graph = buildPhaseGraph(documents);
    expect(Object.keys(graph.phases)).toHaveLength(chainLength);
  });
});

describe("readyPhaseIds", () => {
  test("only the root is ready when everything is pending", () => {
    const graph = buildPhaseGraph(diamondDocuments());
    const statuses: Record<string, PhaseStatus> = {
      a: "pending",
      b: "pending",
      c: "pending",
      d: "pending",
    };
    expect(readyPhaseIds(graph, statuses)).toEqual(["a"]);
  });

  test("independent roots are all ready immediately", () => {
    const graph = buildPhaseGraph([phase("zeta"), phase("alpha")]);
    const statuses: Record<string, PhaseStatus> = { zeta: "pending", alpha: "pending" };
    expect(readyPhaseIds(graph, statuses)).toEqual(["alpha", "zeta"]);
  });

  test("closing the root unblocks both branches in ascending id order", () => {
    const graph = buildPhaseGraph(diamondDocuments());
    const statuses: Record<string, PhaseStatus> = {
      a: "closed",
      b: "pending",
      c: "pending",
      d: "pending",
    };
    expect(readyPhaseIds(graph, statuses)).toEqual(["b", "c"]);
  });

  test("a phase with a pending dependency is never ready", () => {
    const graph = buildPhaseGraph(diamondDocuments());
    const statuses: Record<string, PhaseStatus> = {
      a: "closed",
      b: "closed",
      c: "pending",
      d: "pending",
    };
    expect(readyPhaseIds(graph, statuses)).toEqual(["c"]);
  });

  test("no phase is ready when all are closed", () => {
    const graph = buildPhaseGraph(diamondDocuments());
    const statuses: Record<string, PhaseStatus> = {
      a: "closed",
      b: "closed",
      c: "closed",
      d: "closed",
    };
    expect(readyPhaseIds(graph, statuses)).toEqual([]);
  });

  test("a phase absent from the statuses record is never ready", () => {
    const graph = buildPhaseGraph([phase("only")]);
    const statuses: Record<string, PhaseStatus> = {};
    expect(readyPhaseIds(graph, statuses)).toEqual([]);
    expect(selectNextReadyPhase(graph, statuses)).toBeNull();
  });

  test("a dependency absent from the statuses record blocks its dependents", () => {
    const graph = buildPhaseGraph([phase("a"), phase("b", ["a"])]);
    const statuses: Record<string, PhaseStatus> = { b: "pending" };
    expect(readyPhaseIds(graph, statuses)).toEqual([]);
    expect(selectNextReadyPhase(graph, statuses)).toBeNull();
  });
});

describe("selectNextReadyPhase", () => {
  test("selects the smallest ready id regardless of document listing order", () => {
    const graph = buildPhaseGraph([phase("zeta"), phase("alpha")]);
    const statuses: Record<string, PhaseStatus> = { zeta: "pending", alpha: "pending" };
    expect(selectNextReadyPhase(graph, statuses)).toBe("alpha");
  });

  test("returns null when all phases are closed", () => {
    const graph = buildPhaseGraph([phase("only")]);
    expect(selectNextReadyPhase(graph, { only: "closed" })).toBeNull();
  });

  test("skips a blocked phase and selects its ready dependency", () => {
    const graph = buildPhaseGraph([phase("a"), phase("b", ["a"])]);
    const statuses: Record<string, PhaseStatus> = { a: "pending", b: "pending" };
    expect(selectNextReadyPhase(graph, statuses)).toBe("a");
  });
});
