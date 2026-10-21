<p align="center">
  <img src="./logo.png" alt="AgentHub Logo" width="128" />
</p>

# AgentHub — Agent Control Center

<p align="center">
  <a href="./README.md">简体中文</a> · <a href="./README.en.md">English</a>
</p>

> Four things — skills, usage, quota and memory — pulled into one Windows desktop app.

AgentHub is a locally-run control center (Electron + Vue 3 + TypeScript). It ships no model of its own; it simply takes what is scattered across your AI coding tools and puts it under one roof: duplicate skill installs, where this month's tokens actually went, whether your subscription quota can be used by other clients, and agents that never remember your project. Those four problems map to the four sections below.

It comes in two forms: the **Windows desktop app** (all four sections, see [Windows download & install](#windows-download--install)) and the **Docker image** (proxy gateway only, meant to run on a server, see [Docker download & install](#docker-download--install)).

| Section | In one line | Who it's for |
| --- | --- | --- |
| **Skill Library** | Collect every tool's skills into one central library, maintain once, mount back everywhere | People running Codex / Claude Code / ZCode / Cursor side by side |
| **Usage Stats** | Aggregate token usage and cost from 21 data sources, sliced by day / project / model | Anyone who wants to know what this month actually cost |
| **Proxy Gateway** | Wrap the subscription quota already logged in on this machine into a standard API any client can call | People with subscription quota (Trae / WorkBuddy / Raccoon / ModelScope / ZCode / Qoder / Cline and 14 channels in total) who want other software to use it |
| **Memory Hub** | A local Markdown memory store plus an MCP server, so agents remember your project and preferences | Anyone tired of re-explaining context in every new session |

---

## Community & Support

- **QQ group**: `110336924` (search the number in QQ to join) — usage questions and issue reports live here
- **Donate**: the project is completely free and open source. If it saved you some tokens, you are welcome to [buy the author a drink](./SPONSOR.md)
- **Business**: sponsorship, product placement in this README, custom development (ERP, dashboards, WeChat mini programs) — [get in touch](./SPONSOR.md)

Full details are in [SPONSOR.md](./SPONSOR.md).

---

## Table of Contents

- [Windows download & install](#windows-download--install)
- [Docker download & install](#docker-download--install)
- [Section 1: Skill Library](#section-1-skill-library)
- [Section 2: Usage Stats](#section-2-usage-stats)
- [Section 3: Proxy Gateway](#section-3-proxy-gateway)
- [Section 4: Memory Hub](#section-4-memory-hub)
- [FAQ](#faq)
- [Development & self-test](#development--self-test)
- [Disclaimer](#disclaimer)

---

## Windows download & install

### Installer

1. Open the [Releases page](https://github.com/HUIdada1/AgentHub/releases/latest)
2. Download `AgentHub-Setup-x.y.z.exe`
3. Double-click to install. You can change the install directory; the installer creates an "AgentHub" shortcut on the desktop and in the Start menu
4. After launch the app stays in the system tray — closing the window does not exit. Double-click the tray icon to bring the window back; the right-click menu lets you pause sync and check today's usage

### Requirements

- Windows 10 / 11 (x64)
- No need to pre-install Node, a browser or anything else — the runtime is bundled
- Some tools need their client to have been logged in on this machine (usage stats read local databases, for example)

### Data, updates and backup

- All configuration and data live in `%APPDATA%\AgentHub`; uninstalling does not remove it
- Auto-update: checks GitHub Releases **once an hour** by default. When a new version appears, a red dot shows on the settings gear in the sidebar and on the update button in Settings · General. You can turn the check off in Settings · General
- The bottom-left "Settings" holds global options (General / WebDAV sync / Sync schedule / Data & backup). Each section also has its own "Configure" button in the top-right corner

---

## Docker download & install

The Docker image contains **only the proxy gateway** (no skills / usage / memory sections). It is meant to keep the gateway running on a server. Channel code is identical to the desktop app, accounts are shared through WebDAV/S3 pool sync, and the image ships a **web console** — open the server address in a browser to manage pools, keys and channels.

Prerequisites: Docker 20.10+ with Compose v2, a Linux server with 1 core and 512 MB RAM to start.

```bash
git clone https://github.com/HUIdada1/AgentHub.git && cd AgentHub

# Credential encryption key — keep it safe: once lost, encrypted credentials cannot be recovered
export AGENTHUB_SECRET_KEY=$(openssl rand -base64 32)

# The container runs as uid 1000, so the host data directory must match
mkdir -p gateway-data && sudo chown 1000:1000 gateway-data

docker compose -f gateway/docker-compose.yml up -d --build
```

Self-check after it comes up:

```bash
curl -s http://127.0.0.1:9528/api/livez     # {"ok":true} — process is alive
curl -s http://127.0.0.1:9528/api/readyz    # 503 = no accounts in the pool yet, expected
```

- Open `http://<server>:9528/` for the **web console** (set `AGENTHUB_ADMIN_TOKEN` first; that token is what you type at login)
- Clients connect to `http://<server>:9527/v1`; create keys in the console or through the admin API (`POST /api/keys`)
- The admin API and web console bind to the host's `127.0.0.1:9528` by default; set `AGENTHUB_ADMIN_TOKEN` to allow external access
- Account sources: sync from the desktop app after configuring WebDAV (recommended), or import JSON via `POST /api/accounts/import`
- There are no desktop clients inside the container, so **local software import, switch-to-IDE and Qoder dual-region** are unavailable
- Do not mount the desktop app's data directory into the container — those credentials are DPAPI ciphertext and cannot be decrypted on Linux

Ports, backup, key rotation, deploying WebDAV on the same host and troubleshooting are covered in [gateway/README.md](./gateway/README.md).

---

## Section 1: Skill Library

### The problem

You installed the same skill separately in Codex, Claude Code, ZCode and Cursor, and changing one leaves three stale copies. The Skill Library collects every tool's skill directory into one central repository and mounts it back to each tool: maintain in the center, and one update takes effect everywhere.

### Pages

| Page | What it does |
| --- | --- |
| Dashboard | Overview of the central library and each tool's connection: how many skills collected, mount health, orphan directories |
| Central library | Skill list and details; inspect / collect / mount one by one, repair broken mounts in one click |
| Dedupe & conflicts | Lists differences when the same skill differs across tools, and lets you decide which copy wins; also decides where a tool's link should point when it points somewhere else |
| Sync center | Scan preview → confirm and run → view report, all in one pass: what to collect, what to mount, what needs a decision |
| WebDAV sync | Cross-device sync of the central repository (server configured in Settings · WebDAV sync) |

### How to use

1. Open **Skill Library · Dashboard** and confirm your tools are detected (ZCode / Codex / Claude Code / Antigravity / the generic `~/.agents` are built in; other tools are suggested from local directories)
2. Go to **Sync center**, run a scan first — previews write nothing, so you can see what will be collected and where it will be mounted
3. Run it. Skills are mounted back from the central repository as junctions, so they take almost no extra space
4. When you add or change a skill somewhere, run the sync center again; conflicts land in **Dedupe & conflicts** for you to decide
5. Multiple machines: fill in the WebDAV server under **Settings · WebDAV sync**, then run the **WebDAV sync** page once to push the central repository across

---

## Section 2: Usage Stats

### The problem

Usage is scattered across each tool's own local database, and nobody tells you what the month cost in total. Usage Stats reads **local client data files** directly, normalises 21 sources onto one schema, and gives you totals, trends, cost and cross-device comparison.

### Supported sources (21)

ZCode, SenseTime Raccoon, Xiaomi MiMo, Codex, DeepSeek Harness, WorkBuddy, WorkBuddy AI, Reasonix, CodeBuddy, Qoder, Qoder CN, Antigravity, Antigravity IDE, Antigravity legacy recovery, Trae, Trae CN, TRAE SOLO, TRAE SOLO CN, OpenSquilla, Grok, AutoClaw.

Under **Configure · Usage stats** you can toggle each source and point it at a custom data directory — sources you never installed are skipped silently.

### Pages

| Page | What it does |
| --- | --- |
| Overview | KPI cards, yearly heatmap, usage trend (hourly for today), and per-machine breakdown |
| Records | Filter by source / model / project, page through entries, export to CSV |
| Cost | Cost converted from model prices; configure prices under Billing rules first |
| Billing rules | Model price table, remote price sources, model alias merging (variant names billed at the target price) |
| Sync log | Time, window, row count and result of every sync — the first place to look when something is off |

### Sync cadence

- Local collection: every **30 minutes** (fixed, no toggle)
- Cross-device sync: configured under **Settings · Sync schedule**, either hourly or once a day, and can be triggered manually at any time
- WebDAV is optional: without it the app runs in local mode and only counts this machine

---

## Section 3: Proxy Gateway

> The core section of the project: wrap the subscription quota **already logged in on this machine** into a standard API, so any client that supports a custom endpoint can call it.
>
> Three inbound protocol faces, **same address, same key**, routed by whichever protocol the client speaks:
>
> | Endpoint | Protocol | Who uses it |
> | --- | --- | --- |
> | `POST /v1/chat/completions` | OpenAI Chat Completions | Cherry Studio / ChatBox / NextChat / Cline / Roo Code and other OpenAI-compatible clients |
> | `POST /v1/messages` (plus `POST /v1/messages/count_tokens`) | Anthropic Messages | Claude Code / Anthropic SDK |
> | `POST /v1/responses` | OpenAI Responses | Codex CLI |
>
> All three share one scheduling core: authentication, model aliases, model disabling, fallback chain, pool failover, cooldown decisions and accounting are identical — only "how the gateway key is read" and "what bytes are written" differ. That means **Claude Code and Codex can point straight at the gateway and reach every channel**, with no CC Switch protocol translation in between.

### Supported channels

| Channel | Subscription | Login | Daily check-in |
| --- | --- | --- | --- |
| **Trae SOLO CN** | Trae SOLO (China) | Official auth page + local loopback callback | Daily |
| **WorkBuddy CN** | WorkBuddy (China) | Official login page + local polling | Daily |
| **WorkBuddy AI** | WorkBuddy (international) | Official login page + local polling | One-off booster pack |
| **SenseTime Raccoon** | SenseTime Raccoon | In-app auth window capture (no system browser) | Daily |
| **ModelScope** | ModelScope free inference credit (Magic Beans) | OAuth page (app self-registers) + paste `ms-` token as fallback (**no client install needed**) | Daily tasks (login / bind cloud / like to earn) |
| **LobsterAI (Youdao)** | NetEase Youdao Lobster | Official login page + local loopback callback (**no client install needed**) | Daily, 100 credits |
| **ZCode (Zhipu)** | Z.ai GLM coding plan | Z.ai auth page + local polling | Claim rewards |
| **CatPaw (Meituan)** | CatPaw desktop session quota | Import from the local CatPaw client (read live, no re-login) | No check-in |
| **Qoder CN** | Qoder (China) | Device-code polling on the official page (no client needed) / import from local software | Daily credits |
| **Qoder International** | Qoder (international) | Same as above | Daily credits |
| **AutoClaw CN** | Zhipu AutoGLM acceleration | Phone + SMS code / import from the local AutoClaw client | Daily points |
| **AutoClaw International** | AutoGLM international | OAuth login (with risk check) / import from local | Daily points |
| **Cline Free** | Cline free pool | WorkOS device authorization (confirm in browser, **no client needed**) / import from local Cline / paste credentials | No check-in |
| **Cline Pass** | ClinePass subscription pool | Same as above (one Cline login can be imported into both channels) | No check-in |

Each channel's pool, check-in and policies are fully independent: switch channels at the top of the pool page and everything below shows only that channel's accounts.

> **About the two Cline channels (Free / Pass)**
>
> - Cline is a **standard OpenAI-compatible upstream** (`api.cline.bot`) with no signing and no desktop dependency: device authorization needs one confirmation click in the browser and credentials renew themselves (the access token rotates hourly).
> - **Free and Pass are two separate channels**, not two modes of one channel: accounts, model lists, toggles and mappings are independent. The free pool has a daily allowance (in credits, shown negative when overdrawn); the subscription pool only exposes models to accounts with ClinePass.
> - Model ids carry a pool prefix (e.g. `cline-free/deepseek-v4.1-flash`) — that is the upstream's **billing-channel selector** and the gateway forwards it verbatim. When a client asks for the short name (`deepseek-v4.1-flash`), the channel's pool prefix is added automatically. If the account has no access to the model, the upstream returns 403 (not subscribed / official product surface only); the gateway passes it through without retrying and without cooling the account — try another model or channel.

> **Two notes on the Qoder channels**
>
> - **Inference depends on a locally installed Qoder client**: each request's signature headers and body encoding are produced at runtime by a wasm module bundled with the client and cannot be constructed by hand. AgentHub extracts that capability from the installed client on first use and caches it per version (rebuilt automatically after a client upgrade, no reinstall of AgentHub needed). So **credentials alone, without the client installed, put the account in the pool but cannot send requests** — keep the client installed; the default location, the launcher's default path and custom install paths are all detected.
> - **Daily credits**: the button on the pool page is "Claim credits" (100 per day, refreshed at 10:00 UTC+8, valid for 30 days, repeated clicks count as already claimed). The claim endpoint requires the client's own risk-control identity, so the client must be installed. The international free tier excludes DeepSeek / GLM Flash models; a subscription is required to use them.

### Pages

| Page | What it does |
| --- | --- |
| Overview | Service toggle, endpoint, today's metrics, channel list, live request stream (every step has a "?" explanation) |
| Pool | Per-channel account management: status, balance, plan expiry, policy, add account, one-click check-in, switch to IDE |
| API Keys | Create / disable keys, set daily quota and rate limits; the full key is always viewable and copyable |
| Model catalog | Merged view of all channels' models: enable per model, pin a channel, set multipliers and aliases; each channel's official catalog can be pulled from the cloud |
| Usage stats | The gateway's own request log: selectable range (today / 7 / 30 / 90 days / custom), KPIs and trends (requests / tokens / success rate / latency, hover for exact values), token composition and status donut, top usage (channel / model / key / account × by request / by token, with request and response tokens split), per-key usage, details (fuzzy key / model search plus channel / status filters); retention is configurable (90 days by default) |
| Pool sync | Share pools across machines: accounts and credentials packed and synced over WebDAV, optionally one channel only |
| Integrations | Register the gateway into CC Switch for Claude Code / Codex / Claude Desktop (those three can also point straight at the gateway, see the protocol faces above) |

### Getting started

#### Step 0: prepare an upstream account

Install and log in to at least one upstream client with your own account (any of Trae SOLO CN / WorkBuddy / SenseTime Raccoon / ZCode / Qoder). If you already logged in on this machine, step 2 can import from local software directly — no re-login. Qoder keeps its credentials in an encrypted envelope, and AgentHub can read that too (same Windows user as the client).

#### Step 1: start the gateway

Open **Proxy Gateway · Overview** and click **Start service** in the top-right corner; the status turns `RUNNING` when ready. Default listener:

```
http://127.0.0.1:9527/v1
```

This address is local-only at first. Port and bind address (change `127.0.0.1` to `0.0.0.0` to allow LAN access) live under **Configure · Proxy gateway**; restart the service after changing them.

#### Step 2: add accounts to the pool

Open **Proxy Gateway · Pool**, pick a channel at the top, then click **Add account**. Every channel supports four ways in — pick one:

1. **OAuth login** (recommended) — jumps to the official auth page and adds the account automatically, no token typing:
   - Trae SOLO CN: redirects to a local loopback address; if the browser stops on the callback page, paste the whole address bar into the input as a fallback
   - WorkBuddy (both editions): the app polls locally after login, nothing to paste
   - SenseTime Raccoon: the auth window opens inside AgentHub and the code is captured directly; if blocked, paste `office-raccoon://auth/callback?code=…`
   - ZCode: opens the Z.ai auth page and adds the account after login; the plan is initialised in the background over a few dozen seconds and the coding-plan API key is resolved
   - Qoder (both editions): opens the official login page (qoder.cn / qoder.com), polls every second and retrieves the device credential pair — **no client install, no callback pasting**
   - LobsterAI (Youdao): opens the official login page (lobsterai.youdao.com) and returns to a local loopback callback; **no client install**; paste the address bar if the browser does not come back (callbacks are still accepted after the 3-minute timeout)
   - Cline (both channels): opens the WorkOS device-authorization page with the user code prefilled — one confirmation — then polls locally; **no client install, no local callback port**
   - One login equals one account; repeat as many times as you need
2. **Import from local software** — scans credentials of clients already logged in on this machine, zero requests, easiest (Qoder uses this path too: it reads the device token from the client's login state)
3. **From a JSON / ZIP file** — bulk import account files someone gave you
4. **Paste JSON** — paste one credential or a group manually

Once added, the pool lists balance, plan expiry and status (online / cooling / exhausted / relogin / disabled). To maintain accounts, click **Check in** for that channel (or claim the booster pack; Qoder says "Claim credits"), or enable scheduled check-in to run every channel daily.

#### Step 3: create an API key

Open **API Keys** and click create:

- **Name**: anything recognisable, e.g. `cherry-studio`
- **Routing**: `auto` picks a channel by pool policy; you can also pin a single channel
- **Daily quota / rate limit**: empty means unlimited; set them to stop one client from burning the whole allowance

The key pops up immediately for copying, and you can view / copy the full key from the list at any time (stored encrypted with DPAPI), so a missed copy is not a problem. If it leaks, disable it (the toggle takes effect immediately) and create a new one.

#### Step 4: fill in three fields in the client

Any client supporting an OpenAI-compatible / custom OpenAI endpoint works (Cherry Studio, ChatBox, NextChat, Cline, Roo Code, IDE plugins…):

| Field | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:9527/v1` (some clients only want the port — follow their hint) |
| API key | The `sk-…` key from step 3 |
| Model | A model name available in the **Model catalog** page |

Save, send a message, and check the live request stream on **Overview** — a record there means the chain works.

> **Using Claude Code / Codex / Claude Desktop?** The gateway speaks their native protocols, so you can point them at the gateway directly (see the three protocol faces above). To manage multiple provider configs in one place with CC Switch, see step 5.

#### Step 5 (optional): wire up Claude Code / Codex

**Option A: direct (recommended, nothing extra to install)**

- **Claude Code / Anthropic SDK**: set `ANTHROPIC_BASE_URL` to `http://127.0.0.1:9527` (without `/v1`) and `ANTHROPIC_AUTH_TOKEN` to the key from step 3
- **Codex CLI**: in `~/.codex/config.toml`, set the provider's `base_url` to `http://127.0.0.1:9527/v1` and `wire_api = "responses"` (Codex no longer accepts `chat` and errors out)
- Pick an available model name from the **Model catalog** page

**Option B: managed by CC Switch** (when you want one place for multiple providers)

1. Install [CC Switch](https://github.com/farion1231/cc-switch) first
2. Open **Proxy Gateway · Integrations**, choose the target app (Claude Code / Codex / Claude Desktop), pick an API key and a default model, then click register
   - The CC Switch database is backed up before writing, and only its own fixed entry is written — your other providers are untouched
   - On the Claude side only `ANTHROPIC_AUTH_TOKEN` is written. The gateway's Messages face accepts both `x-api-key` and `Authorization: Bearer`, but sending both with different keys is treated as a misconfiguration (rejected rather than guessed), so only one is written
3. After registering, turn on **proxy takeover** in CC Switch and start the client
4. Codex's `wire_api` must semantically be `responses`; CC Switch decides whether conversion is needed from the entry's `apiFormat`, no manual edit

### Pool and failover

- **Five-state machine**: online / cooling / exhausted / relogin / disabled
- **In-pool policy**: expiry-first (default — burn quota that expires soonest) / balance-first / round-robin, set per channel
- **Runtime failover**: on upstream 402 or quota errors the request moves to the next account (at most 2 switches per request); accounts known to be at zero balance are skipped during scheduling
- **Cooldown table**: different errors cool for different lengths (rate limit 60 s, server errors 10 min, next-day quota errors until 04:00 the next day, 401 marked as needing re-login), so dead accounts are not retried endlessly
- **Model fallback**: when a model is unknown or every account is unavailable, the global fallback model from **Configure · Proxy gateway** takes over

### Switch to the local IDE (optional)

Every account in the pool has a **Switch to IDE** button that writes that account as the current login state of the local client — handy when you want a pool account inside the desktop client.

- Supports WorkBuddy (both editions), SenseTime Raccoon and ZCode. **Trae is not supported** — its login state is an encrypted envelope bound to a device key, and a valid file cannot be constructed; the app explains why instead of writing something broken
- Clicking shows a confirmation; confirming closes the client, backs up the current login state, writes the new one and reopens the client
- Multiple checks surround the write (concurrency guard, read-back verification with automatic rollback); ZCode uses a merge-style write that leaves your remote connection address untouched, and Raccoon keeps the account's device fingerprint so accounts do not collide

### Connect to a remote gateway (optional)

When the gateway runs on a server via Docker, the desktop app can connect to it under **Proxy Gateway → Configure → Remote instance**: enter the address (`http://<server>:9528`) and the admin token (`AGENTHUB_ADMIN_TOKEN`). Once the test passes, the toggle in the top-right corner switches between **local / remote** — every proxy page then operates on that server: create keys, change channels, trigger check-ins, all from the desktop UI. Things the container cannot do (start/stop the gateway, switch IDE accounts, open directories) explain themselves.

For monitoring, set a read-only token on the server (`AGENTHUB_ADMIN_READONLY_TOKEN`, view-only). Plain `http` is for internal networks only; expose 9528 over https publicly — admin tokens must not travel in clear text.

### Sharing a pool across machines

The **Pool sync** page packs accounts and credentials (AES-256-GCM with the shared WebDAV password) and uploads them to WebDAV; another machine pulls them down and shares the same accounts. You can sync all channels or just one, and progress is shown stage by stage.

### Anti-detection and stability

- Request fingerprints (UA, device headers, tracing headers, referer) match the official clients field by field
- On the WorkBuddy side, fingerprints are sanitised (strip `cc_*` / `x-anthropic-*`, minimal rewriting of review templates, templates externalised and hot-reloadable)
- Requests carry 40–220 ms of humanised random jitter so failover leaves no trace
- Hot-reloading rules: edits to `rules/*.json` (model mappings / sanitise templates / channel headers) take effect immediately, no restart

---

## Section 4: Memory Hub

### The problem

Every new agent session forgets your project background, technical decisions and past mistakes. The Memory Hub keeps a local **Markdown memory store**, distils facts worth keeping from conversations, and exposes them to agents over **MCP** — your memory stays a pile of local, readable, diffable md files.

The default store lives in `~/AgentHub/memory`: `projects/<project>/l1/<agent>/<date>.md` holds raw facts, `projects/<project>/l2/...` holds distilled summaries, decisions and knowledge.

### Pages

| Page | What it does |
| --- | --- |
| Dashboard | Total memories, growth trend, distribution across projects and agents |
| Browse | Four views — list / heatmap / pending / trash; the three kinds of entries needing a human decision are handled under Pending |
| Projects | Per-project summaries and provenance; rename or merge projects |
| Profile | Preferences and persona distilled from long-term records |
| Agent access | One-click MCP and instruction-block injection for each agent, with three-level verification |
| Search & index | Full-text search (Chinese bigram tokenisation + synonym expansion), index status and self-healing |
| Automation | Nine background tasks: toggles, cadence, run-now and history |
| Import & dedupe | Import memories from each tool's conversation history, merge duplicates |
| WebDAV sync | Cross-device sync of the memory store |

### How to use

1. **Connect an agent**: open **Agent access**, find your agent (ZCode, Codex CLI, WorkBuddy, Claude Code, DeepSeek Harness, Trae Solo, Cursor and the generic `~/.agents` are built in) and click inject. It does two things: adds an MCP launch entry to the agent config, and writes a controlled block into its instruction file (`AGENTS.md` / `CLAUDE.md` etc.). Both are backed up first, and uninstalling removes only its own parts
2. **Verify**: the three-level check on the card confirms in order "config entry present → the bridge can actually launch and list tools → this agent has really called it". Only a heartbeat at level three proves it is in use
3. **Import history**: open **Import & dedupe** to bring existing conversation history in as base material (Codex, ZCode, WorkBuddy and others are supported), with a dry-run preview first
4. **Turn on automation**: open **Automation** and enable what you need. The nine tasks fall into two groups:
   - Local algorithms: project grouping suggestions, index self-healing (no tokens)
   - Model-based: structured extraction, summaries, auto-tagging, staleness decisions, L2 distillation, dedupe merging, persona / preference profiling
5. **Give memory tasks a model**: choose the model source on the Memory Hub config page — your own API, or the **AgentHub gateway already set up in this section** — and configure a fallback chain

### Pending inbox

After automation runs, three kinds of conclusions do not take effect immediately but queue for your confirmation: **staleness decisions** (does a new fact supersede an old one), **project grouping suggestions** and **dedupe merge suggestions**. They live under **Browse → Pending**; accept or reject one by one, each with a recommendation, or accept all recommendations at once.

---

## FAQ

**Q: A client cannot connect to the gateway.**
Check three things first: ① is the service `RUNNING` on **Overview**; ② does the client's base URL end with `/v1`; ③ is the key disabled. Then read the error code: `401` wrong key, `429` rate limit or daily quota for that key, `400` bad request parameters, `502` upstream error (the pool retries with another account automatically), `503` no available account in the current channel (check whether they are all cooling or need re-login).

**Q: Can a phone or another computer reach it?**
Yes. Change the bind address to `0.0.0.0` under **Configure · Proxy gateway**, restart the service, then use the LAN IP and port. This exposes the service to every device on the subnet, so set key quotas and rate limits.

**Q: Why can't Trae switch to the IDE?**
Trae's local login state is a ByteCrypto encrypted envelope bound to a device key; a valid file cannot be built externally. The app says so instead of damaging your login state.

**Q: What should I watch with multiple Raccoon accounts?**
Add them all through AgentHub's **OAuth login**. **Do not click "Log out" in the desktop Raccoon app** — SenseTime's server revokes the old credentials, which invalidates the accounts in your pool.

**Q: After syncing the pool to a second machine over WebDAV, a Raccoon account shows "needs re-login".**
No re-login needed; let it recover. Raccoon's refresh token rotates on every use (each refresh on machine one invalidates the synced copy). Since v1.68.1, a rejected refresh automatically fetches the latest credentials from the other device and retries, and the first machine pushes its fresh copy immediately after its next refresh — so **keep both machines on, with network and WebDAV working, and wait one quota refresh cycle (30 minutes by default)**. Log the same account in only once inside AgentHub: **do not log in again on the second machine via OAuth or the client** — that creates a second session and the server kicks one out, including the first machine. When it really drops, the account bubble explains why (server rejection / concurrent refresh / suspected login elsewhere).

**Q: Does "Switch to IDE" interrupt the client I'm using?**
Yes: the app closes the client, writes the login state and reopens it (which is why it always asks first). Save your work before clicking.

**Q: Are my credentials safe?**
Account tokens are encrypted with Windows DPAPI before touching disk and stay in the main process, never exposed to the renderer; gateway API keys are stored as SHA-256 hashes only (the full key is kept in a separate encrypted envelope so you can view it). Requests only go to the official endpoints of the services you use and to the WebDAV server you configure — never through a third-party server.

**Q: Is a lot of functionality unavailable without WebDAV?**
No. Usage Stats falls back to local mode automatically, and the single-machine features of the Skill Library, Proxy Gateway and Memory Hub all work. WebDAV is only for sharing across machines.

**Q: When does scheduled check-in run?**
Off by default. Once enabled it runs every channel at the configured time (09:00 by default, changeable) and records results per channel, so each channel keeps its own history.

---

## Development & self-test

```bash
# Requires Node >= 18
npm install

npm run dev          # desktop development (Electron + Vite HMR)
npm run dev:web      # browser-only UI preview (mock data, no Electron)
npm run build        # type check + frontend build
npm run electron:build   # package the installer into release/
```

Full end-to-end self-test for the proxy backend (fake upstream included: failover / auto-switch / streaming both modes / fingerprint headers):

```bash
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-smoke.cjs
```

Regression gates for each inbound protocol face (real HTTP into the real scheduling core, only upstream and pool stubbed; plain Node, no Electron):

```bash
node scripts/dev-sink-golden.cjs         # OpenAI path: byte-identical responses / cooldown decisions / pick order / logs across 16 scenarios
node scripts/dev-anthropic-in-test.cjs   # /v1/messages: normalisation + event order + error envelope + kill switch
node scripts/dev-responses-in-test.cjs   # /v1/responses: normalisation + event order + three Codex hard constraints + kill switch
```

Qoder-specific self-tests (offline, no network, no quota consumed; credential and signer assertions need the Qoder client installed):

```bash
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-qoder-adapter-selftest.cjs      # adapter pure functions + SSE envelope decoding
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-qoder-integration-selftest.cjs  # daily claim (stub) + memory hub adapter
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-qoder-selftest.cjs              # credential decryption + wasm signer
```

Cline dual-channel self-test (offline + local fake upstream, no network, no quota):

```bash
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-cline-selftest.cjs   # protocol assertions + fake-upstream end-to-end
```

Skill Library self-test (plain Node, builds a sandbox in a temp directory, never touches the real home, no network):

```bash
node scripts/test-skills-diff-link.cjs    # abnormal link targets: detection + relink / adopt + no recurrence after a decision
```

Memory Hub verification entry points:

```bash
npm run verify:memory                                             # static checks: IPC plumbing / config tiers / terminology / navigation / structure
node tools/memory-runtime-path-selftest.cjs                       # bridge runtime discovery: per-platform layouts + case sensitivity + offline errors
```

Code layout:

```
electron/            main process
  backend/
    adapter-*.cjs    usage data source adapters
    proxy/           proxy gateway (store / adapters / pool / server / hot-reload rules / IDE switching)
      protocols/     inbound and outbound protocol faces (openai-out / anthropic-in+out / responses-in+out)
    memory/          memory hub (store / index / search / access / automation / import)
  main.cjs           app entry (window / tray / updates)
src/                 renderer (Vue 3)
  views/             pages for the four sections
  components/        shared components (sidebar / tabs / config center)
```

The gateway's protocol details come from reverse-engineering the official clients; the code is an independent implementation.

---

## Disclaimer

> Please read this section in full before using the project. **Downloading, installing, launching or using it in any way means you have read, understood and fully accepted the terms below.**

### 1. For learning and research only

This is a practice project for studying **HTTP reverse proxying, SSE streaming passthrough, multi-upstream protocol adaptation, local credential management, cross-tool skill directory management and Electron desktop packaging**. It is for personal learning and research only and is not an official product of any company.

The project is **not affiliated with** any of the following companies or their products, and has not received their authorisation, endorsement, sponsorship or backing:

Tencent and WorkBuddy / CodeBuddy, ByteDance and Trae, SenseTime and Raccoon, Zhipu and ZCode / AutoClaw / AutoGLM, Meituan and CatPaw, Alibaba and Qoder / ModelScope, NetEase Youdao and LobsterAI, Xiaomi and MiMo, DeepSeek and DeepSeek Harness, Google and Antigravity, Cline, and any other service providers mentioned.

All product names, trademarks, service names and protocol names belong to their respective owners and are used only for identification and explanation, without implying any affiliation or authorisation.

### 2. About reverse-proxy behaviour

The project implements a **local reverse proxy**: it reuses the login state of **your own account** on **your own machine** and forwards requests to the official upstream gateway. It does not crack or bypass any payment or permission check; the quota consumed always comes from what your account already has.

That said, forwarding in the shape of a non-official client **may conflict with the upstream service's terms of use**; whether to use it, and all consequences (including but not limited to rate limiting, risk-control action, demotion, freezing or banning of accounts, subscription termination, zeroed credits), **are borne solely by the user; the author accepts no responsibility**.

### 3. Prohibited uses

Do not use this project for:

- Any commercial purpose, redistribution for profit, or selling accounts or quota through it
- Bulk account operation, buying or selling accounts, automated claiming, account farming
- Bypassing upstream billing, quota, risk control or permission limits
- Attacking, scraping, scanning or disrupting any service
- Any other activity that violates local law or the upstream terms of service

These prohibitions are also written into Part 2 ("Additional Terms") of the [LICENSE](./LICENSE) and form part of the project's licensing terms — **they are not merely a request**.

For production or commercial use of these model services, use the **official channels and official APIs**.

### 4. Credentials and data risk

The project reads and writes credentials (accessToken / refreshToken etc.) and local data files of clients already logged in on this machine:

- Credentials are encrypted with Windows DPAPI before touching disk; gateway API keys are stored as SHA-256 hashes only. Encrypted pool-sync bundles and local backups contain recoverable credentials — keep them safe. "Export selected accounts" on the pool page exports metadata only (no tokens); do not mistake it for a credential file
- Never commit exported credential files to public repositories, upload them to cloud drives, send them to chat groups or share them with others
- Binding the service to `0.0.0.0` exposes it to every device on the subnet; assess the risk and set key quotas and rate limits
- "Switch to IDE" closes and rewrites the local client's login state; save your work first
- Any loss caused by leaked credentials, a shared device, misconfiguration or mistakes **is borne by the user; the author accepts no responsibility**
- Uninstalling **does not delete** `%APPDATA%\AgentHub`; remove that directory yourself if you want a clean wipe

### 5. No warranty and rights notice

The project is provided "AS IS", and the author **makes no express or implied warranty** as to its availability, stability, security, legality, accuracy or fitness for a particular purpose.

- Upstream interfaces, authentication and protocol fields may change at any time; the project may stop working and may no longer be maintained, and the author has no obligation to update, fix or answer questions
- Any direct or indirect loss caused by using the project (including but not limited to account loss, quota loss, data loss, business interruption, third-party claims, regulatory penalties) **is not the author's responsibility**
- Interface shapes and protocol fields in the project come from **observing and organising publicly available network traffic** of the official clients, for study and research only; related trademarks and services belong to their respective owners
- If a rights holder believes the project is inappropriate, please contact the author and it will be adjusted or removed

**Full terms are in [LICENSE](./LICENSE).** If you disagree with any part of this section, stop using the project and delete it and its data immediately.

## Author

**沐晖** (GitHub: [@HUIdada1](https://github.com/HUIdada1))

## License

This project uses a **compound licence — [MIT License](./LICENSE) plus Additional Terms**, and is **not a pure MIT project**:

| Part | Content |
| --- | --- |
| Part 1 · MIT License | Grants the rights to use, copy, modify, merge, publish, distribute, sublicense and sell the software |
| Part 2 · Additional Terms | Further restricts use: no commercial use, no redistribution for profit, no bulk account operation, no bypassing upstream billing or quota, no attacking or disrupting services, no unlawful use |

The two parts are **inseparable** and together form the complete licence. Anyone accepting only one part may not use, copy, modify or distribute the project in any form. The additional terms match section 3 ("Prohibited uses") of the [Disclaimer](#disclaimer) above; where wording differs, the [LICENSE](./LICENSE) prevails.

Commercial use requires prior written permission from the author. Full terms (including the MIT text) are in [LICENSE](./LICENSE).

Copyright (c) 2026 沐晖 (HUIdada1)
