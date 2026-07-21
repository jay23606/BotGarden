# BotGarden

BotGarden is a multi-user research and paper-trading portal for designing, generating, testing, comparing, and operating condition-driven stock and options strategies through Alpaca.

**Live portal:** [jay23606.github.io/BotGarden](https://jay23606.github.io/BotGarden/)

**Research paper:** [jay23606.github.io/BotGarden/paper.html](https://jay23606.github.io/BotGarden/paper.html)

BotGarden combines a static GitHub Pages interface with Supabase Auth, Postgres, row-level security, scheduled Edge Functions, and per-user Alpaca paper credentials. It is a research environment—not investment advice and not evidence that any generated strategy will be profitable.

## Current capabilities

- Email/password accounts with per-user data isolation
- Encrypted connection of each user's Alpaca paper account
- Stock and option bot creation with one to three composable start conditions
- Bounded random strategy generation using coherent parameter families
- Configurable bulk generation, defaulting to 15 stock and 10 option bots
- Configurable ticker discovery by sustained volume, latest-session volume, relative volume, or active price movement, with price and dollar-volume safety floors
- Defined-risk credit spreads, debit spreads, and long-option strategies
- Stock backtests using Alpaca historical IEX bars
- A separate 24/7 crypto workspace with ATR-adaptive grid bots, fee-aware replay, and Alpaca paper execution
- Explicitly labeled, low-confidence option replay estimates
- Market-regime and volatility context for historical tests
- Per-row underlying-price sparklines and cumulative result ranking
- Ticker intelligence with risk metrics, liquidity measures, asset flags, and recent Alpaca news
- Randomized parent/child strategy experiments with matched test coverage
- Immediate individual deletion and bulk pruning of bots below 2%, not tested, or lacking an option estimate
- ON/OFF paper-execution controls
- Five-minute scheduled evaluation and per-bot decision explanations
- Atomic multi-leg option entries and coordinated option exits
- Superuser exemption from the ordinary worker bot-count cap

## Architecture

- **Frontend:** static HTML, CSS, and JavaScript ES modules on GitHub Pages
- **Identity and storage:** Supabase Auth and Postgres with `bg_`-prefixed tables and RLS
- **Server-side services:** Deno/TypeScript Supabase Edge Functions
- **Scheduling:** Supabase Cron invokes the paper runner every five minutes
- **Broker and data provider:** Alpaca paper-trading and market-data APIs
- **Credential handling:** paper keys are encrypted server-side with AES-GCM and never returned to the browser

## Research limitations

Paper trading is simulated and does not reproduce every source of live execution friction. Stock tests use the IEX feed available to Alpaca Basic accounts rather than the consolidated SIP feed. Option replay estimates are derived from underlying-price movement, configured delta, modeled decay, payoff bounds, and liquidity haircuts; they are not reconstructions from historical option-chain quotes. Complete automated stock-position exit management remains a development priority.

See the [BotGarden research paper](https://jay23606.github.io/BotGarden/paper.html) for the methodology, design rationale, threat model, and limitations.

## Deployment

1. Create a Supabase project and apply `supabase/schema.sql` plus the migrations in `supabase/migrations`.
2. Add the project URL and publishable key to `config.js`.
3. Configure Supabase Authentication and the deployed redirect URL.
4. Create a 32-byte encryption key and save it as the Edge Function secret `BG_CREDENTIALS_KEY`.
5. Deploy the functions in `supabase/functions`.
6. Configure the runner secret and apply the scheduled-runner migration.
7. Publish the repository with GitHub Pages.

Never commit the encryption key, Supabase service-role key, runner secret, or Alpaca credentials.
