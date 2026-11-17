// A game written in JS: comments are allowed, and parts can be built from shared pieces.
const limits = { hp: { min: 0, max: 10 } };
export default async () => ({
  model_id: "js-config-game",
  initial_state: { game: {}, actors: { user: { name: "you", hp: 10, controlled_by: "user" } } },
  limits,
  // history_limit: 5,   <- commented out on purpose
});
