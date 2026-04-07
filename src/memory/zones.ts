/**
 * Zone-aware file editing for master-rules.md and strategy files.
 *
 * Files are partitioned into FIXED zones (human-authored, never auto-modified)
 * and MUTABLE zones (autoDream can freely update). Zone boundaries use HTML
 * comments so they're invisible in rendered markdown.
 *
 * Markers:
 *   <!-- MUTABLE ZONE: zone-name -->
 *   ... content ...
 *   <!-- END MUTABLE ZONE -->
 *
 * Everything outside a MUTABLE ZONE is implicitly FIXED.
 */

export interface ZonedContent {
  /** Everything outside mutable zones (preserved byte-for-byte) */
  fixed: string;
  /** zone-name → content within that zone */
  mutable: Map<string, string>;
  /** The original full file content */
  raw: string;
}

/** Create a fresh MUTABLE_BLOCK regex (avoids /g lastIndex state leaks). */
function mutableBlockRegex(): RegExp {
  return /<!-- MUTABLE ZONE: (.+?) -->\r?\n([\s\S]*?)<!-- END MUTABLE ZONE -->/g;
}

/**
 * Parse a file into fixed and mutable zones.
 */
export function parseZones(content: string): ZonedContent {
  const mutable = new Map<string, string>();
  const re = mutableBlockRegex();

  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const name = match[1]!.trim();
    const body = match[2]!;
    mutable.set(name, body);
  }

  // Fixed content = everything with mutable zones replaced by placeholders
  const fixed = content.replace(
    mutableBlockRegex(),
    "<!-- MUTABLE ZONE: $1 -->\n<!-- END MUTABLE ZONE -->",
  );

  return { fixed, mutable, raw: content };
}

/**
 * Replace the content of a named mutable zone, preserving everything else.
 * Returns null if the zone was not found (e.g. markers were deleted).
 */
export function replaceMutableZone(
  content: string,
  zoneName: string,
  newContent: string,
): string | null {
  const pattern = new RegExp(
    `(<!-- MUTABLE ZONE: ${escapeRegex(zoneName)} -->\\r?\\n)[\\s\\S]*?(<!-- END MUTABLE ZONE -->)`,
  );

  // Ensure newContent ends with a newline before the closing marker
  const normalized = newContent.endsWith("\n") ? newContent : newContent + "\n";

  // Use a replacer function to avoid $ special-character interpretation
  const result = content.replace(pattern, (_, open: string, close: string) => `${open}${normalized}${close}`);

  // If nothing changed, the zone was not found
  if (result === content) return null;
  return result;
}

/**
 * Extract the content of a named mutable zone, or null if not found.
 */
export function extractMutableZone(content: string, zoneName: string): string | null {
  const pattern = new RegExp(
    `<!-- MUTABLE ZONE: ${escapeRegex(zoneName)} -->\\r?\\n([\\s\\S]*?)<!-- END MUTABLE ZONE -->`,
  );
  const match = pattern.exec(content);
  return match ? match[1]! : null;
}

/**
 * Check whether a file has valid (paired) mutable zone markers.
 */
export function hasValidZones(content: string): boolean {
  const starts = content.match(/<!-- MUTABLE ZONE: .+? -->/g) ?? [];
  const ends = content.match(/<!-- END MUTABLE ZONE -->/g) ?? [];
  return starts.length === ends.length && starts.length > 0;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
