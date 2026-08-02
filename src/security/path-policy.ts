import path from "node:path";

export type ArchiveEntryDescriptor = {
  path: string;
  size_bytes: number;
  type: "file" | "directory" | "link";
};

export type ArchivePolicyLimits = {
  max_archive_bytes: number;
  max_expanded_bytes: number;
  max_entry_bytes: number;
  max_entries: number;
  max_path_length: number;
  max_compression_ratio: number;
};

export type ArchivePolicyEvaluation = {
  ok: boolean;
  violations: string[];
};

export const stableArchivePolicyLimits: Readonly<ArchivePolicyLimits> = {
  max_archive_bytes: 64 * 1024 * 1024,
  max_expanded_bytes: 256 * 1024 * 1024,
  max_entry_bytes: 64 * 1024 * 1024,
  max_entries: 4_096,
  max_path_length: 240,
  max_compression_ratio: 200
};

const reservedWindowsDeviceName =
  /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;

export function validatePortableArchivePath(
  value: string,
  options: { requiredRoot?: string; maxLength?: number } = {}
): string[] {
  const violations: string[] = [];
  const maxLength =
    options.maxLength ?? stableArchivePolicyLimits.max_path_length;

  if (
    value.length === 0 ||
    value.length > maxLength ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    path.win32.isAbsolute(value) ||
    path.posix.isAbsolute(value)
  ) {
    violations.push("path_shape");
  }

  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        segment.includes(":") ||
        /[\u0000-\u001f]/u.test(segment) ||
        reservedWindowsDeviceName.test(segment)
    )
  ) {
    violations.push("path_segment");
  }

  if (
    options.requiredRoot !== undefined &&
    segments[0]?.toLowerCase() !== options.requiredRoot.toLowerCase()
  ) {
    violations.push("required_root");
  }

  return unique(violations);
}

export function evaluateArchivePolicy(input: {
  archive_bytes: number;
  expanded_bytes: number;
  entries: readonly ArchiveEntryDescriptor[];
  required_root?: string;
  limits?: ArchivePolicyLimits;
}): ArchivePolicyEvaluation {
  const limits = input.limits ?? stableArchivePolicyLimits;
  const violations: string[] = [];

  if (
    !Number.isSafeInteger(input.archive_bytes) ||
    input.archive_bytes <= 0 ||
    input.archive_bytes > limits.max_archive_bytes
  ) {
    violations.push("archive_size");
  }
  if (
    !Number.isSafeInteger(input.expanded_bytes) ||
    input.expanded_bytes < 0 ||
    input.expanded_bytes > limits.max_expanded_bytes
  ) {
    violations.push("expanded_size");
  }
  if (input.entries.length === 0 || input.entries.length > limits.max_entries) {
    violations.push("entry_count");
  }
  if (
    input.archive_bytes > 0 &&
    input.expanded_bytes / input.archive_bytes > limits.max_compression_ratio
  ) {
    violations.push("compression_ratio");
  }

  const normalizedPaths = new Set<string>();
  for (const entry of input.entries) {
    violations.push(
      ...validatePortableArchivePath(entry.path, {
        requiredRoot: input.required_root,
        maxLength: limits.max_path_length
      })
    );
    if (
      !Number.isSafeInteger(entry.size_bytes) ||
      entry.size_bytes < 0 ||
      entry.size_bytes > limits.max_entry_bytes
    ) {
      violations.push("entry_size");
    }
    const normalized = entry.path.toLowerCase();
    if (normalizedPaths.has(normalized)) {
      violations.push("case_collision");
    }
    normalizedPaths.add(normalized);
  }

  return {
    ok: violations.length === 0,
    violations: unique(violations)
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
