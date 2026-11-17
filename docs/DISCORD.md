# DISCORD.md

How the Discord interface works, how to set it up, and what is not covered. One bridge process runs many bots; each bot serves one game.

## How it fits together
```
Discord  <-->  bridge (one process, all bots, holds the tokens)  --HTTP-->  proxy  -->  engine, narrator, tools
```
- **The connection to Discord is not in the proxy.** A bot token allows one gateway connection and the proxy may run on several servers, so one separate **bridge** process (`discord-bridge.ts`) holds every bot. It talks to the proxy exactly like Open WebUI does: an OpenAI-compatible request with the chat so far, the answer streamed back. The proxy never sees a bot token and the engine does not know it is Discord.
- **Identity** travels in the headers the engine already reads: the conversation id (`discord:<bot>:<channel>:<user>`), the Discord user id (`discord:<id>`) and the display name.
- **Discord sends no chat history**, so the bridge rebuilds the conversation from the channel on every message (see below). The record is kept in step with it by the sync layer (`DEPLOYMENT.md`): an edited or deleted Discord message is picked up on the next message. Give a Discord game `"sync": {"mode": "repair"}`.
- **If Discord and the record disagree, Discord wins.** The record is a cache derived from what people can see.

## Set up a bot
1. Discord Developer Portal > **New Application**. Copy the **Application ID**.
2. **Bot** tab > **Reset Token** and copy the token (you see it once).
3. Same tab, **Privileged Gateway Intents**: turn on **Message Content Intent**. Without it the bot cannot read what people write.
4. Invite it to a server: `https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot&permissions=274877975552` (View Channels, Send Messages, Send Messages in Threads, Read Message History). It needs nothing else, except Manage Channels (add 16 to the number: `permissions=274877975568`) if you want banned players hidden from a channel (see the end of this file).
5. `cp discord.config.example.mjs discord.config.mjs`, fill in the token and the game, and **add `discord.config.mjs` to `.gitignore`**.
6. Give the game what Discord needs in its `config.json`: `"sync": { "mode": "repair" }`, and optionally `"discord": { ... }` (below).
7. Start it (see "Running"). The bot appears online; mention it in a channel it can see.

## discord.config.mjs
| Key | Meaning |
|---|---|
| `bridge.port`, `bridge.host` | where the bridge answers `GET /healthz` (default `3030`, `127.0.0.1`); the proxy looks there |
| `proxy.url`, `proxy.apiKey` | the proxy every bot talks to; `apiKey` is its `PROXY_API_KEY` |
| `bots[].name` | short name, part of every conversation's id: do not rename a bot that has history |
| `bots[].token` | the bot token |
| `bots[].game` | the game's folder (where its `config.json` is), relative to where the bridge runs |
| `bots[].channels` | `"all"` (default) or a list of channel ids; a thread counts as its parent channel |
| `bots[].guilds` | only these servers (default: any) |
| `bots[].dms` | answer direct messages (default `true`) |
| `bots[].answerWhen` | `"mention"` (default: when @mentioned or replied to) or `"all"` |
| `bots[].context` | free-form settings for this bot, told to the game on every turn, e.g. `{ symbol: "AAPL" }` for one bot per stock |
| `bots[].proxy`, `bots[].model` | a different proxy or model name for this bot |

The file is checked with Zod at start, and a mistake is one readable message (which key, what is wrong). Two bots may not share a name or a token.

## config.json: the `discord` key
Read by the bridge (the proxy ignores it).
| Key | Default | Meaning |
|---|---|---|
| `scope` | `"user"` | `"user"`: everyone has their own 1:1 conversation with the bot, even in a public channel (good for assistants like a stock bot). `"channel"`: the channel is one shared conversation, a table (good for multiplayer games; `MULTIPLAYER.md`) |
| `merge_context` | `"mentions"` | what the bridge adds when a message points at other messages: `"mentions"` (the message being replied to, and the latest exchanges the bot had with people the message mentions), `"reply"` (only the replied-to message), `"off"` |
| `history_limit` | `200` | how many channel messages the bridge reads to rebuild a conversation |

## How a conversation is rebuilt
- The bot **replies** to the message it answers, so the pairing is explicit. A conversation is the messages the bot answered (with its answers) plus the new message. An answer split across several Discord messages is joined back into one.
- In scope `user`, other people's messages and chatter the bot was not part of are left out: it is a 1:1 conversation even in a busy channel. In scope `channel`, everyone's answered messages are in time order.
- In a **direct message** every message of the person is part of it.
- **Background is not conversation.** When someone writes "what did you tell @pat earlier?" the bridge finds that exchange and sends it as background (`X-Game-Context`: untrusted text, never part of the transcript), so it never changes the record's fingerprints. The narrator is told to use it only to understand what the person means.
- A table game in Discord: scope `channel`; the second person to speak makes it a table; a **DM with the bot is a private chat** for a seated player (their new chat while seated is a private channel to the narrator, as in `MULTIPLAYER.md`).

## Running
- **Development:** `INTERFACES=openwebui,discord npm start`. If nothing answers on the bridge's port the proxy starts the bridge (and stops it with itself); it does not wait for it, so a broken bridge cannot hold the proxy up. Or run it yourself: `npm run discord`.
- **Production** (`NODE_ENV=production`): the bridge is assumed to be running as its own process or container (`node dist/discord-bridge.js`, or `npm run discord`); the proxy only warns if it does not answer. Run **one bridge per bot token**. Several proxy servers behind one URL are fine: sessions are in Redis with a per-conversation lock (`DEPLOYMENT.md`).
- `DISCORD_CONFIG=/path/to/file` uses another config file.
- Build: add `"discord-bridge": "discord-bridge.ts"` to `rollupOptions.input` in `vite_config.ts` so `dist/discord-bridge.js` exists.

## What Discord lacks (logged at start as `[interface discord] missing feature: ...`)
Regenerate and edit-and-resend (edits and deletes are repaired by the sync layer instead); word-by-word streaming (an answer is one message edited about once a second, split at 2000 characters, code blocks closed and reopened across the cut); `reasoning: show`; attachments, images, reactions and slash commands (ignored); who said what inside one request (people are told apart by their Discord id).

## Pictures

With config.json `images`, `/draw` and `/portrait` work in Discord too (type them as the message; mention the bot where the bot needs one). The reply's text is posted as usual and the picture is fetched from the proxy (`/images/<name>`, using the proxy address in `discord.config.mjs`) and attached. Not built: a picture attached to a Discord message does not become a reference yet (only Open WebUI's attached pictures do); the picture itself does not need `PUBLIC_URL` to be reachable by Discord, only by the bridge. See `IMAGES.md`.

## Limits to know
- Every message reads up to `history_limit` channel messages (a few Discord calls). Very old conversations in busy channels may fall outside it, in which case the sync layer rebuilds what it can from the part it sees.
- A message edited in Discord after the bot answered is picked up on the next message, not at once.
- Messages from one conversation are answered one at a time, in order; different conversations run in parallel.
- Automated tests fake Discord (the whole bridge, the real HTTP server and the real engine run against a pretend one). **The discord.js adapter (`src/modules/discord/bridge/discordjs.ts`) has not been run against real Discord.**

## First live run (check these)
| Check | Expect |
|---|---|
| Start the bridge | `[bridge] bot <name> is online ...`, the bot shows online, `GET /healthz` lists it |
| @mention it in a channel | typing indicator, then one message that replies to yours and grows as the answer is written |
| A long answer | several messages, all replies to your message, none over 2000 characters, code blocks intact |
| A second message | the game remembers the first (its record, not just the text) |
| Another person in the same channel | their own conversation (scope `user`) |
| Edit your earlier message, then write again | the next answer reflects the edit (`audit` in `/debug/state` shows `replay`) |
| DM the bot | answered with no mention |
| Stop the proxy, write to the bot | "Sorry, I couldn't reach the game right now." |
| `channels` / `guilds` limits | silent elsewhere |

## Not built yet
Redis Streams between the bridge and the proxy (for messages the proxy starts itself: timeouts, reminders; today everything is a request the bridge makes), slash commands, attachments and images, a judge deciding which earlier messages a person means (today: replies and mentions), the docker-compose file.
- `<private>` is Open WebUI's hidden channel (IMENG-MAKING.md, "Private text"). Discord has no such tag. The bridge turns a spoiler that holds only code-like text (`||`text`||` or a spoilered fenced block) into `<private>` before the message goes to the proxy; everyone in the channel can still read it, so this is a testing stand-in until a plugin exists. Other spoilers are passed on unchanged. The proxy's reply already has `<private>` blocks removed.

## Linking accounts
With config.json `link`, `/link` in a channel does not post the code: the bridge strips it from the stream and sends it to the person by direct message (needs `dms: true`; if the DM fails the channel gets the `DM_FAILED` text). Redeem a code in a DM with the bot (`/link CODE`) so it is not left in a channel. `/freeze` and `/unfreeze` work as in `MULTIPLAYER.md`.

## Hiding a banned player from a channel
When the proxy bans someone at a table (peeking, announcing a hand), the bridge hides that channel from them until the ban ends. This needs the **Manage Channels** permission on that channel (or Manage Roles); without it the ban still holds in the game (their messages are ignored) and the bridge logs that it could not hide the channel. Who is hidden, and until when, is kept in `saves/discord-joins.json` so a restart gives the channel back on time.
