/**
 * The game marks text meant for one person only as <dm>...</dm> (a link code). The bridge never shows it in the channel: it is taken out of the stream
 * as it arrives (even when the tag is split across pieces) and sent to the author as a direct message instead.
 */

const OPEN = "<dm>", CLOSE = "</dm>";

export class DmFilter {
  private buf = "";
  private inside = false;
  /** The private texts found so far, in order. */
  readonly captured: string[] = [];

  push(delta: string): string {
    this.buf += delta;
    let out = "";
    for (;;) {
      if (!this.inside) {
        const i = this.buf.indexOf(OPEN);
        if (i >= 0) { out += this.buf.slice(0, i); this.buf = this.buf.slice(i + OPEN.length); this.inside = true; continue; }
        let keep = 0; // the end of the buffer may be the start of "<dm>": wait for the next piece
        for (let k = Math.min(OPEN.length - 1, this.buf.length); k > 0; k--) if (OPEN.startsWith(this.buf.slice(this.buf.length - k))) { keep = k; break; }
        out += this.buf.slice(0, this.buf.length - keep);
        this.buf = this.buf.slice(this.buf.length - keep);
        return out;
      }
      const j = this.buf.indexOf(CLOSE);
      if (j < 0) return out; // still inside: nothing is shown
      this.captured.push(this.buf.slice(0, j).trim());
      this.buf = this.buf.slice(j + CLOSE.length);
      this.inside = false;
    }
  }

  /** What was held back at the end (never the inside of an unclosed tag). */
  end(): string {
    const rest = this.inside ? "" : this.buf;
    this.buf = ""; this.inside = false;
    return rest;
  }
}
