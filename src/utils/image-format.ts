/** Look at the first bytes of a file to tell what it really is, whatever its name or content type says. */

export type ImageKind = "png" | "jpeg" | "webp" | "gif" | "svg" | "pdf" | "unknown";
/** Formats the renderers and the chat can use. */
export const USABLE: ImageKind[] = ["png", "jpeg", "webp"];

const startsWith = (b: Uint8Array, sig: number[], at = 0): boolean => sig.every((v, i) => b[at + i] === v);

export function sniff(bytes: Uint8Array): ImageKind {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "gif";
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return "pdf";
  const head = Buffer.from(bytes.subarray(0, 512)).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "svg";
  return "unknown";
}

export const usable = (kind: ImageKind): boolean => USABLE.includes(kind);
export const mimeOf = (kind: ImageKind): string => (kind === "jpeg" ? "image/jpeg" : `image/${kind}`);
export const extOf = (kind: ImageKind): string => (kind === "jpeg" ? "jpg" : kind);
