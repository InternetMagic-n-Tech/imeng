# Terms for The Backrooms

This is a solo text game that may draw pictures with a local image generator. It runs on the host machine of the person who runs this server (the operator). The models run there too: nothing is sent to an outside service.

- **What is kept.** Your chat is saved as a game on the host, and dropped after 30 days without a message. The words sent to and from the models are logged on the host (a Redis store or a log file) so the operator can find problems; those logs include private notes.
- **Who can see what.** The operator can read the saved games and the logs. At a table, everyone at the table reads what is said at the table; what you send privately goes to the game's narrator and the operator, not to the other players.
- **Your choices.** You can stop at any time. Ask the operator to delete your saved game and your rows. Do not put anything in the chat that you would not want the operator to read.
- **It is a game.** Characters and results are made up by a language model and can be wrong.
