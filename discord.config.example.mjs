// Copy to discord.config.mjs and fill it in. discord.config.mjs holds bot tokens: keep it OUT of git (add it to .gitignore).
// One bridge process runs every bot listed here. Read docs/DISCORD.md for how to create a bot and add it to a server.
export default {
  // Where the bridge listens for the proxy's health check (and where the proxy looks for it).
  bridge: { port: 3030, host: "127.0.0.1" },

  // The proxy every bot talks to (an OpenAI-compatible endpoint). apiKey is the proxy's PROXY_API_KEY, if you set one.
  proxy: { url: "http://localhost:3001", apiKey: "" },

  bots: [
    {
      // A short name: it becomes part of every conversation's id, so do not rename a bot that has history.
      name: "desk",
      // The bot token (Discord developer portal > your application > Bot > Reset Token).
      token: "PASTE_THE_BOT_TOKEN_HERE__________",
      // The game this bot serves: its folder, relative to where the bridge runs. Its config.json decides how Discord treats it
      // (the "discord" key: scope, merge_context, history_limit) and should have "sync": { "mode": "repair" }.
      game: "imengs/lighthouse",

      // Where it answers. "all" or a list of channel ids; a thread counts as its parent channel. Optionally only some servers.
      channels: "all",
      // guilds: ["123456789012345678"],
      // Answer direct messages too.
      dms: true,
      // "mention" (default): only when @mentioned or replied to, as a 1:1 conversation even in a public channel. "all": every message.
      answerWhen: "mention",

      // Free-form settings for this bot; the game is told them on every turn. Handy for one bot per character, per language...
      context: {},
    },

    // More bots: each has its own token and settings, and may serve a different game.
    // {
    //   name: "second", token: "...", game: "imengs/lighthouse",
    //   proxy: { url: "http://other-proxy:3001", apiKey: "..." },   // a bot may use another proxy
    // },
  ],
};
