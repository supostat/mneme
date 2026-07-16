export type Vote = "pass" | "fail";

// The canonical vote shape inside the engine: the verdict plus the reviewer's optional remarks.
// Convergence reads only the verdict; remarks of fail votes are replayed into the retry attempt's
// directive so the rework loop sees WHAT was wrong, not just that something was.
export interface AgentVote {
  vote: Vote;
  remarks?: string;
}

export function evaluateConverge(votes: Vote[], minAgree: number): boolean {
  if (!Number.isInteger(minAgree) || minAgree < 1) {
    return false;
  }
  const passCount = votes.filter((vote) => vote === "pass").length;
  return passCount >= minAgree;
}
