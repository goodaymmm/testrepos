export type ReleaseVerificationContext = "source" | "consumer";

export function parseReleaseVerificationContext(
  value: string | undefined
): ReleaseVerificationContext {
  if (value === undefined) {
    return "source";
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "source" || normalized === "consumer") {
    return normalized;
  }
  throw new Error("Release verification context must be source or consumer.");
}
