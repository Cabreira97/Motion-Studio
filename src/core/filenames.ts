/**
 * Safe, cross-platform filename generation.
 *
 * Input can come from anywhere (a user typed project name, a page title, ...),
 * so we aggressively strip anything that could escape the target directory or
 * confuse the filesystem, and fall back to a deterministic default.
 */

const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

const DEFAULT_MAX = 80;

export interface SafeFilenameOptions {
  fallback?: string;
  maxLength?: number;
}

/** Returns a filename (without directory separators) that is safe on macOS,
 * Windows and Linux. Never returns an empty string or a reserved name. */
export function safeFilename(
  input: unknown,
  options: SafeFilenameOptions = {},
): string {
  const fallback = options.fallback ?? "recording";
  const maxLength = Math.max(8, options.maxLength ?? DEFAULT_MAX);

  if (typeof input !== "string") return fallback;

  // Normalize unicode so we don't smuggle look-alike separators.
  let name = input.normalize("NFKC");

  // Drop any traversal segments before stripping separators.
  name = name.replace(/\.\.+/g, ".");

  name = name
    .replace(ILLEGAL, "-")
    .replace(/\s+/g, " ")
    .trim();

  // Collapse runs of separators and strip leading/trailing dots & dashes.
  name = name.replace(/-{2,}/g, "-").replace(/^[.\-\s]+/, "").replace(/[.\-\s]+$/, "");

  if (name.length > maxLength) {
    name = name.slice(0, maxLength).replace(/[.\-\s]+$/, "");
  }

  if (name.length === 0) return fallback;

  const stem = name.split(".")[0]?.toLowerCase() ?? "";
  if (RESERVED.has(stem)) {
    name = `_${name}`;
  }

  return name;
}

/** Builds `base.ext` safely, ensuring exactly one extension separator. */
export function withExtension(
  base: unknown,
  extension: string,
  options: SafeFilenameOptions = {},
): string {
  const clean = safeFilename(base, options);
  const ext = extension.replace(/^\.+/, "").replace(ILLEGAL, "");
  return ext.length > 0 ? `${clean}.${ext}` : clean;
}

/** Joins a directory and a *safe* filename using the platform from `sep`. */
export function joinPath(dir: string, filename: string, sep = "/"): string {
  const trimmedDir = dir.replace(/[\\/]+$/, "");
  return `${trimmedDir}${sep}${safeFilename(filename)}`;
}

/** Makes a filename unique against a set of already-used names. */
export function uniqueName(filename: string, used: Set<string>): string {
  if (!used.has(filename)) return filename;
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : "";
  let index = 2;
  let candidate = `${stem}-${index}${ext}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${stem}-${index}${ext}`;
  }
  return candidate;
}
