// A real function: the rules a schema cannot say.
export function validateOp(op, state) {
  if (/^actors\.[^.]+\.score$/.test(op.path ?? "") && typeof op.value === "number" && op.value > 5) return "a score cannot go above 5";
  return true;
}
