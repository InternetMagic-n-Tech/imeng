// The Dungeon's own rules, as real functions (see docs/IMENG-MAKING.md "Validators").
// An op that breaks one is refused, and the repair judge gets one try at a corrected op.
const hpAfter = (op, cur) => (op.op === "inc" ? Number(cur) + Number(op.value) : op.op === "set" ? Number(op.value) : NaN);

export function validateOp(op, state) {
  const m = /^actors\.([^.]+)\.(hp|max_hp|level)$/.exec(op.path ?? "");
  if (!m) return true;
  const [, id, field] = m;
  const a = state.actors?.[id];
  if (!a) return true;
  if (field === "hp") {
    const next = hpAfter(op, a.hp ?? 0);
    if (Number.isFinite(next) && a.max_hp != null && next > a.max_hp) return `hp cannot go above max_hp (${a.max_hp})`;
    if (Number.isFinite(next) && (a.hp ?? 1) <= 0 && next > 0) return "the dead are not brought back by the bookkeeping";
  }
  if (field === "level" && Number(op.value) > 10) return "level 10 is the most this dungeon has";
  return true;
}
