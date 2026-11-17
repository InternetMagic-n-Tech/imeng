# Demo script (Reddit)

A five-minute demo for people who have never seen imeng. Needs Open WebUI with the proxy, two or three people (or one).

1. **What is this?** Open a new chat, send `what is this?`. The reply lists the launch words of every imeng on the server: this is the Internet Magic Engine, and the rules live in code.
2. **Start.** Send `Imeng: Dungeon Adventure`. Describe your character; a friend joins the shared chat and describes theirs.
3. **Explore.** Search the first room. Say `ready` when everyone has spoken. The narrator tells one beat.
4. **Fight.** Something attacks: the dice are the server's, shown in parentheses. Hit points are kept in code.
5. **Hush.** Mid-fight, ask something off-topic. The game answers "Hush, you." without calling the model.
6. **Magic.** Cast a spell outside the fight; the game leaves its loop and comes back.
7. **Death.** Let one player die. Their next shared message is ignored with a fixed line; their private chat still reaches the narrator.
8. **Look behind the curtain.** Show the trace in MLflow (tagged `imeng`) and the phase changes in the log.
