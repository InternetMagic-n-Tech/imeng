import type { ToolDef } from "./index.js";
import { VARIANTS, showdown } from "./poker-eval.js";
import type { Variant } from "./poker-eval.js";
import { settle } from "./poker-settle.js";
import type { Hand } from "./poker-settle.js";

/** The Dealer's calculator: who has the best hand, and how a pot (and a player who leaves) is paid out. Everything is worked out in code. */
const tool: ToolDef = {
  name: "poker",
  description: "Poker maths done in code. action showdown: rank hands (variant holdem, omaha or stud5, board cards, each player's hole cards) and name the winner(s). action settle: pay out the pot (players with stack, bet, status in|all-in|folded|left, the winner ids and the showdown's places, leave_rule fold|split (split = a side pot for a leaver), borrow_limit).",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["showdown", "settle"] },
      variant: { type: "string", enum: VARIANTS },
      board: { type: "array", items: { type: "string" }, description: "board cards like 7h, Ad, 10s" },
      seats: { type: "array", items: { type: "object", properties: { id: { type: "string" }, hole: { type: "array", items: { type: "string" } } }, required: ["id", "hole"] } },
      hands: { type: "array", items: { type: "object", properties: { id: { type: "string" }, stack: { type: "number" }, bet: { type: "number" }, status: { type: "string", enum: ["in", "all-in", "folded", "left"] }, credit: { type: "number" } }, required: ["id", "stack", "bet", "status"] } },
      winners: { type: "array", items: { type: "string" } },
      places: { type: "object", description: "id to place (1 = best) as the showdown returned them; needed for side pots" },
      leave_rule: { type: "string", enum: ["fold", "split"] },
      borrow_limit: { type: "number" },
    },
    required: ["action"],
  },
  async run(args, ctx) {
    const o = ctx.options;
    try {
      if (args?.action === "showdown") {
        const variant = (args.variant ?? o.variant ?? "holdem") as Variant;
        const ranked = showdown(variant, args.board ?? [], args.seats ?? []);
        return { variant, winners: ranked.filter((r) => r.winner).map((r) => r.id), places: Object.fromEntries(ranked.map((r) => [r.id, r.place])), hands: ranked.map(({ id, name, cards, winner, place }) => ({ id, hand: name, cards, winner, place })) };
      }
      if (args?.action === "settle") {
        return settle((args.hands ?? []) as Hand[], args.winners ?? [], { leave_rule: args.leave_rule ?? o.leave_rule, borrow_limit: args.borrow_limit ?? o.borrow_limit, places: args.places });
      }
      return { error: "action is showdown or settle" };
    } catch (e) { return { error: (e as Error).message }; }
  },
};
export default tool;
