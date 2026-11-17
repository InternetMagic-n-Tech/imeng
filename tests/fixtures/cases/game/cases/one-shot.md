---
game: ..
name: all in then leave
state:
  actors:
    user: { name: Gus, chips: 200 }
history: []
private: ["I trust the house to settle me up"]
---
# Omaha, all in, then leaves

## Steps
1. Gus: "Omaha. All in on the first hand, I have to go mow the lawn."
2. "bye"

## Expect
- state: actors.user.chips == 200
- state: game.variant == "holdem"
- text: contains "dealer"
- text: not contains "borrow"
- text: last matches /bye|goodbye/
- judge: the dealer lets the player leave
