// Returns operations, never a state.
export function next({ from, to, event, args }) {
  if (to === "playing" && event === "move") return { ops: [{ op: "set", path: "imeng.place", value: args.place }, { op: "set", path: "imeng.ambient", value: "mild" }] };
  if (to === "finale") return { ops: [{ op: "set", path: "imeng.place", value: "the studio" }] };
}
