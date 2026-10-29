import { describe, expect, test } from "bun:test";
import { ConcurrencyLimit } from "./concurrency-limit";

// The limit is proven on synthetic tasks — deferred promises released by hand — so thousands of
// "spawns" cost no real process: the git adapter's own wiring is pinned in git.test.ts.

const TASK_COUNT = 5000;
const LIMIT = 16;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

// One macrotask turn: every microtask chain queued so far (slot hand-offs, task starts) has run.
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

describe("ConcurrencyLimit", () => {
  test("5000 tasks never run more than the limit at once, and Promise.all keeps call order", async () => {
    const limit = new ConcurrencyLimit(LIMIT);
    const gates = Array.from({ length: TASK_COUNT }, () => deferred());
    const started: number[] = [];
    let running = 0;
    let peak = 0;
    const all = Promise.all(
      gates.map((gate, index) =>
        limit.run(async () => {
          started.push(index);
          running += 1;
          peak = Math.max(peak, running);
          await gate.promise;
          running -= 1;
          return index;
        }),
      ),
    );

    let finished = 0;
    while (finished < TASK_COUNT) {
      await settle();
      const batch = started.splice(0);
      // Release the running batch newest-first: completion order is the reverse of call order.
      for (const index of batch.reverse()) gates[index]!.resolve();
      finished += batch.length;
    }

    expect(await all).toEqual(Array.from({ length: TASK_COUNT }, (_, index) => index));
    expect(peak).toBe(LIMIT);
  });

  test("waiting tasks start in the order they were queued", async () => {
    const limit = new ConcurrencyLimit(2);
    const gates = Array.from({ length: 10 }, () => deferred());
    const startOrder: number[] = [];
    const running: number[] = [];
    const all = Promise.all(
      gates.map((gate, index) =>
        limit.run(async () => {
          startOrder.push(index);
          running.push(index);
          await gate.promise;
        }),
      ),
    );

    while (startOrder.length < gates.length || running.length > 0) {
      await settle();
      // Free one slot at a time, always the newest runner, so only the queue decides who starts next.
      const newest = running.pop();
      if (newest !== undefined) gates[newest]!.resolve();
    }
    await all;

    expect(startOrder).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("a task that throws synchronously frees its slot and its error reaches the caller", async () => {
    const limit = new ConcurrencyLimit(1);
    const holder = deferred();
    const held = limit.run(() => holder.promise);
    const failure = new Error("sync failure");
    const throwing = limit.run(() => {
      throw failure;
    });
    const next = limit.run(async () => "next ran");

    holder.resolve();
    await held;

    expect(await rejectionOf(throwing)).toBe(failure);
    expect(await next).toBe("next ran");
  });

  test("a task that rejects frees its slot and its error reaches the caller", async () => {
    const limit = new ConcurrencyLimit(1);
    const holder = deferred();
    const held = limit.run(() => holder.promise);
    const failure = new Error("async failure");
    const rejecting = limit.run(async () => {
      await settle();
      throw failure;
    });
    const next = limit.run(async () => "next ran");

    holder.resolve();
    await held;

    expect(await rejectionOf(rejecting)).toBe(failure);
    expect(await next).toBe("next ran");
  });
});
