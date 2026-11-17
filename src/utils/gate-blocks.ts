/** What a gated phase can hold back (phases.<name>.gated.blocks): a phase moved by an interrupt, the /idle vote, the producer's /move and /end, /deal and /pay. Leaving the table is never gated. */
export const GATE_BLOCKS = ["interrupt", "idle", "producer", "deal", "pay"];
