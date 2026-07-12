export type Vote = "pass" | "fail";

export function evaluateConverge(votes: Vote[], minAgree: number): boolean {
  if (!Number.isInteger(minAgree) || minAgree < 1) {
    return false;
  }
  const passCount = votes.filter((vote) => vote === "pass").length;
  return passCount >= minAgree;
}
