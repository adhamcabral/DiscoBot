# DiscoBot

DiscoBot is a Discord AI bot assistant built with Node.js, TypeScript, OpenAI, and MCP. It answers in DMs or when mentioned, can use tools for web research, images, stickers, reminders, and includes a small admin panel for operations.

## Features

- Discord chat assistant with OpenAI Models.
- MCP tools exposed as OpenAI function tools.
- Web search, URL summarization, research, and claim verification.
- Image analysis and visual search.
- Image generation and editing with Discord progress updates.
- Discord emoji and sticker generation/optimization.
- Persistent reminders stored in SQLite.
- Admin panel with authentication for status, logs, prompt editing, model selection, tool toggles, blocked users, and reminders.

## Requirements

- Node.js 24 or newer.
- Discord bot token.
- OpenAI API key.
- Python 3 for the MCP stdio proxy.
- Optional: PM2 for background process scripts.
- Optional: Discord Webhooks for logging.

## Setup

```bash
npm install
cp .env.example .env
```

Fill `.env`:

```bash
DISCORD_TOKEN=
OPENAI_API_KEY=
```

Optional environment variables:

```bash
PORT=3000
BOT_TIMEZONE=America/Sao_Paulo
ADMIN_TOKEN=
ADMIN_SESSION_SECRET=
ADMIN_SESSION_TTL_HOURS=12
DISCORD_BATCH_DELAY_MS=15000
LOG_WEBHOOK_URL=
LOG_LEVEL=info
MCP_TOOL_TIMEOUT_MS=180000
MCP_RESEARCH_TIMEOUT_MS=900000
```

## Running

```bash
npm run build
npm start
```

Useful commands:

```bash
npm run start:bot   # Run only the Discord bot
npm run start:web   # Run only the admin panel
npm run start:mcp   # Run only the MCP server for inspection
npm run build       # Compile TypeScript
```

Using PM2 for background execution (run startup if you want to run the bot on system startup):

```bash
npm install -g pm2
```

```bash
npm run start:all:bg
npm run restart
pm2 status
pm2 startup
```
Run for view logs

```bash
pm2 logs
```

Then run the command shown by pm2 startup, then:
```bash
pm2 save
```


## Architecture

The project runs as three local pieces:

- `src/bot.ts`: Discord process. Owns the gateway connection, OpenAI flow, tool loop, reminders, and Discord responses.
- `src/web.ts`: admin panel process. Reads persisted state and exposes operational controls.
- `src/mcp/server.ts`: local MCP stdio server. Provides generic tools used by OpenAI.

Main message flow:

```text
Discord message
-> recent context and attachments
-> OpenAI chat completion
-> optional MCP or Discord-local tool calls
-> tool results back to OpenAI
-> final Discord response
```

Some tools are declared through MCP but executed inside the Discord process because they need live Discord objects:

- `read_discord_context`
- `schedule_reminder`

## Runtime Data

Runtime files live under `data/`:

```text
data/config/bot.json       Selected model and cached model list
data/config/tools.json     Tool enable/disable configuration
data/state/bot.sqlite      SQLite database
data/state/status.json     Bot heartbeat for the admin panel
data/logs/system.log       System logs
data/logs/interaction.log  Interaction logs
```

SQLite stores blocked users, tool stats, reminders, and compact research memory for follow-up questions.

## Admin Panel

The admin panel is served by `src/web/server.ts` and rendered from `views/index_new.ejs`.

It can manage:

- bot status and process controls;
- MCP tool status and toggles;
- selected OpenAI model;
- system prompt;
- logs;
- blocked users;
- reminders.

Set `ADMIN_TOKEN` to protect the panel with a login cookie. `ADMIN_SESSION_SECRET` should be a separate random value used to sign the cookie; if omitted, the token is reused as the signing secret. `ADMIN_SESSION_TTL_HOURS` controls session duration; set it to `0` for no server-side expiration. If `ADMIN_TOKEN` is not set, the panel starts without authentication for local development.

`DISCORD_BATCH_DELAY_MS` controls how long the bot waits for additional messages in the same Discord chat before answering. The default is `15000` milliseconds.

Do not expose the panel publicly without `ADMIN_TOKEN` and HTTPS or a trusted authenticated reverse proxy.

## Notes

- Source ts code lives in `src/`; compiled js output goes to `dist/`.
- The project uses native ES modules and strict TypeScript.
- `npm test` is currently a placeholder.
- Image jobs are process-local; restarting the MCP process cancels unfinished image work.
- Web search relies on public HTML search result pages, so provider markup changes can affect results.

## License

See `LICENSE`.

Created by Adham Cabral. If you fork or redistribute this project, preserve the original author attribution.
