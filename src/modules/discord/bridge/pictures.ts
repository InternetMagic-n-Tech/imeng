/** A picture made by /draw or /portrait arrives in the reply as markdown (![alt](<proxy>/images/<name>)). Discord gets it as an attachment instead. */

const IMG = /!\[[^\]]*\]\(https?:\/\/[^)\s]+\/images\/([a-f0-9]{24}\.(?:png|jpg|webp))\)\s*/g;

export function extractPictures(text: string): { text: string; files: string[] } {
  const files: string[] = [];
  const out = text.replace(IMG, (_m, file: string) => { files.push(file); return ""; });
  return { text: files.length ? out.trim() : text, files };
}
