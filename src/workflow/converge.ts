export type Vote = "pass" | "fail";

// The canonical vote shape inside the engine: the verdict plus the reviewer's optional remarks.
// Convergence reads only the verdict; remarks of fail votes are replayed into the retry attempt's
// directive so the rework loop sees WHAT was wrong, not just that something was.
export interface AgentVote {
  vote: Vote;
  remarks?: string;
}

// Unanimity is a property of the engine, not a setting: per the REVIEW-AXES-CONVENTION, each vote
// on a criterion guards a DIFFERENT review axis, so any fail must fail the criterion — a threshold
// below the vote count is only meaningful for redundant votes on ONE axis, which the convention
// rules out. An empty vote list is false, fail-closed: silence is not agreement.
export function evaluateConverge(votes: Vote[]): boolean {
  return votes.length > 0 && votes.every((vote) => vote === "pass");
}
