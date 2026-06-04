# FrameForge — Warframe Companion `v1.5.0`

A desktop companion for Warframe that shows your live inventory, tracks crafting recipes, displays market prices, runs a full trading desk, manages a live timer dashboard, auto-detects relic reward screens, and analyses riven mods — all without modifying the game.

> **Windows only** — requires Windows 10 or 11. Inventory scanning requires Warframe to be running; all other features work standalone.

---

## Features

### Live Inventory Scanning
Your inventory is read directly from the Warframe process memory every 10 seconds across 13 item categories — resources, mods, arcanes, relics, weapons, Warframes, companions, and more. No login required. The scanner is **strictly read-only**: it uses `ReadProcessMemory`, the same Windows API used by Overwolf and hardware monitors. It never writes to memory, injects code, or modifies the game.

A quantity change log records every item gain and loss with timestamps.

### Foundry — Recipe Browser & Tracker
Browse every craftable item with full ingredient trees. Each component is colour-coded by status (owned, blueprint only, missing) and shows which relics drop it. Star items to **track** them in the Modular Window, which shows a per-item breakdown of exactly what you still need to farm.

### Market Helper — Prime Sets
Browse every Prime set with live platinum prices from [warframe.market](https://warframe.market). Shows total set value, per-part pricing, ducat values, and your ownership status. Click any set card or individual part to open a **live order popup** showing:
- Current sell and buy orders sorted by price
- 3-week price history chart
- One-click listing from directly inside the popup (requires WFM login)

### Trading (warframe.market)
Log in to your warframe.market account to access full trading features:
- **Active listings** — view, edit price/quantity, and delete your buy and sell orders
- **Post listings** — list any item directly from the Prime Sets view or from the order popup
- **Trade whispers** — incoming warframe.market trade offers captured live from your game's chat log and displayed with one-click invite and sold responses
- **Online status** — set your WFM status to Online, In Game, or Invisible via WebSocket
- Session token is stored securely in **Windows Credential Manager** — your password is never saved

### Relic Helper
Browse void fissure drop tables with rarity colour-coding (Bronze/Silver/Gold), ownership status, and platinum value. Supports all refinement levels: Intact, Exceptional, Flawless, Radiant.

### Timers
A live dashboard fetching data directly from DE's official Warframe worldstate:

- **World Cycles** — Cetus (Day/Night), Orb Vallis (Warm/Cold), Cambion Drift, Zariman with countdown to next change
- **Bounties** — reset timers per open world (Cetus, Orb Vallis, Cambion Drift, Zariman, Hex)
- **Daily & Weekly** — Daily Reset, Weekly Reset, Sortie (expandable with missions), Archon Hunt, The Circuit (frame/weapon picks), Deep Archimedea, Kahl/Break Narmer
- **Events** — Baro Ki'Teer with expandable inventory (Ducat/Credit prices + Owned badges), Prime Resurgence with expandable inventory (Aya prices + Owned badges), Nightwave, Darvo daily deal, active community events
- **Alerts** — mission type, faction, reward, countdown
- **Invasions** — attacker/defender factions, progress bar, rewards
- **Void Fissures** — Normal, Steel Path, and Void Storm tabs as a grid of tiles. Watched fissures highlighted in blue.
- **Fissure Watches** — configure Mode + Tier + Mission Type filters; matching fissures are highlighted in the fissure list and auto-surfaced in the Modular Window

Any timer can be pinned to the Modular Window for at-a-glance viewing.

### EULA Transparency — Both Sensitive Features Are Off By Default

FrameForge places every feature that may touch Digital Extremes' EULA grey areas behind an explicit opt-in toggle, **disabled by default**:

- **Memory Scanner** (`Settings → Memory Scanner`) — uses `ReadProcessMemory` to read live inventory data. DE's EULA broadly prohibits *"automation programs that interact with the Services in any way"*; read-only memory tools have historically been tolerated but are not explicitly permitted. Required for the Inventory tab and quantity tracking.
- **Warframe Companion API** (`Settings → Warframe Companion API`) — connects to `api.warframe.com/api/inventory.php` for mod ranks and additional inventory detail. Not officially confirmed as permitted for third-party tools.

Both show a clear warning before the user can enable them. The app works fully without either — Foundry, Market Helper, Relic Helper, Timers, and Statistics all function using only public data sources and local files.

We are actively seeking official clarification from Digital Extremes. If DE confirms either feature is not permitted, it will be removed in the next release.

### Warframe Companion API — Optional & Opt-In
The connection to `api.warframe.com/api/inventory.php` (which adds mod ranks and detailed inventory data) is **disabled by default**. It can be enabled in Settings under "Warframe Companion API" with a clear warning. We are awaiting official clarification from Digital Extremes on whether this endpoint is permitted for community tools. The app works fully without it — all core features use the read-only memory scanner only.

### Statistics — Trade Tracker & Reports
A full trade history and analytics dashboard, automatically populated from your activity:

**Trades tab:**
- Every in-game trade is detected automatically from `EE.log` the moment "The trade was successful!" appears — no button to press
- WFM trades are logged automatically when you click **✓ Sold** in the Messages tab
- Manual entry form for trades made outside of FrameForge
- Each trade records: item name with rank (mods use text suffix e.g. `Ammo Case (R0)`; arcanes use Unicode rank dots decoded from the log e.g. `Arcane Agility (R4)`), quantity, platinum total, trading partner, direction, source, and timestamp
- Trades with multiple different items are recorded as a comma-separated list

**Reports tab:**
- Date range filter: Today / 7 Days / 30 Days / 90 Days / YTD / 1 Year / All Time
- KPI cards: total earned, total spent, net profit, average per trade
- **Cumulative platinum chart** — running net profit over time
- **Daily bar chart** — green bars on days you earned, red bars on days you spent
- **Items breakdown table** — every item with # sold, # bought, average sell price, and net platinum; sorted by most profitable
- **Top trading partners** — top 10 players by total platinum exchanged

### Riven Analyzer
A dedicated tab for analysing riven mod rolls against the community-curated Sikewyrm spreadsheet (413+ weapons across all categories):

- **Check Riven** — click the button while the riven screen is open in Warframe. FrameForge captures the card with Windows OCR and shows an instant analysis overlay.
- **Per-stat quality rating** — each rolled stat is colour-coded: ✓ green = wanted, ○ yellow = not in wanted list, ✗ red = harmful negative, ✓ blue = safe negative.
- **Comparison mode** — click **Refresh** after cycling to see the new roll side-by-side with the original. Both rolls are quality-rated so you can decide whether to keep or keep rolling.
- **Group-based scoring** — slash-separated alternatives (e.g. `CD MS/TOX/DMG`) are counted as a single slot. A roll of CD+MS on a weapon that wants `CD MS/TOX/DMG` scores 100 %, not 28 %.
- **Wanted stat list** — missing wanted groups shown compactly at the bottom (e.g. "Wanted: Multishot, Base Damage / Fire Rate / Toxicity").
- **Database notes** — build context from the spreadsheet shown inline (e.g. minimum CC thresholds for Eidolon builds).
- **All weapon types** — primary, secondary, melee, archwing weapons. Database refreshes via the ↻ button.

### OCR Relic Reward Overlay
When a void fissure reward screen opens in-game, FrameForge automatically captures and reads all four reward cards using Windows OCR and displays a transparent overlay with each item's platinum price, ducat value, and set completion — so you can pick the best reward instantly without alt-tabbing. Priority mode is configurable: Item Completion, Most Set Value, Most Plat, or Most Ducats.

### Modular Window
A customisable sidebar (or detachable floating window) with four reorderable sections:
- **Tracking** — items being crafted with per-item ingredient requirements and collapse toggles
- **Favorites** — watched inventory items with live quantities
- **Timers** — pinned countdowns from the Timers tab
- **Watched Fissures** — live fissures matching your configured watches

---

## Is This Safe?

| | What FrameForge does |
|---|---|
| **Memory access** | Read-only via `ReadProcessMemory` — never writes, never injects, never hooks |
| **Game modification** | Nothing. No DLL injection, no code hooking, no writing to memory |
| **Network requests** | `warframe.market` (prices + trading), DE worldstate API (timers), WFCD community GitHub repos (item catalog, drop rates, localisation), Warframe CDN (item images). No FrameForge server. No telemetry. |
| **Your account** | WFM login uses the official v1 auth endpoint. Session token stored in Windows Credential Manager — never in a FrameForge file. Warframe Companion API credentials are read from game memory and never written to disk. |
| **Your data** | Nothing leaves your machine except the network calls listed above |

**Don't take our word for it** — the full source code is in this repository under GPLv3. You can read every line, build it yourself, and verify exactly what it does.

---

## Requirements

- Windows 10 or 11 (64-bit)
- [Warframe](https://www.warframe.com/) installed for inventory scanning (Foundry, Market, Relics, and Timers work without it)
- A [warframe.market](https://warframe.market) account for trading features (optional)
- The OCR overlay works best in Windowed or Borderless Windowed mode; Fullscreen Exclusive also supported via DXGI capture

---

## Installation

1. Go to [**Releases**](../../releases) and download the latest installer
2. Run it — Windows SmartScreen may warn you because the binary is not yet code-signed; click **More info → Run anyway**
3. Launch FrameForge from the Start menu or desktop shortcut

> The SmartScreen warning appears because code-signing certificates cost ~$300/year. The source code is fully public for independent verification.

---

## Building From Source

```powershell
# Prerequisites: Node.js 20+, pnpm, Rust (MSVC toolchain)
rustup default stable-x86_64-pc-windows-msvc

# Clone and install dependencies
git clone https://github.com/Sikewyrm/FrameForge.git
cd FrameForge
pnpm install

# Development mode (Vite hot-reload + Tauri window)
pnpm tauri dev

# Production build — installer output: src-tauri/target/release/bundle/
pnpm tauri build
```

---

## How It Works — Technical Overview

### Memory Scanning (`memory_scanner.rs`)
FrameForge enumerates committed, readable memory regions of the Warframe process using `VirtualQueryEx` and reads them with `ReadProcessMemory`. Three independent pattern matchers run over each region:
- **Resource scanner** — stackable items via JSON patterns like `"ItemCount":N,"ItemType":"/Lotus/..."`
- **Unique scanner** — weapons, Warframes, and companions via Aho-Corasick multi-pattern matching
- **Pending recipe scanner** — active Foundry jobs via ISO-8601 completion timestamps

A **stability buffer** requires a quantity to appear in two consecutive scans before it is committed. Only `MEM_COMMIT` regions with readable page protection are scanned; regions larger than 128 MB are skipped.

### Timers (`lib.rs`)
Worldstate data is fetched from `api.warframe.com/cdn/worldState.php`, parsed in Rust into a structured format, and served to the frontend via Tauri IPC. Node names are resolved from the WFCD sol nodes dataset. Event names are resolved from the WFCD localisation dataset.

### Trading (`lib.rs`)
WFM order management uses the v2 REST API (`api.warframe.market/v2/`). Authentication uses the v1 signin endpoint (returns a session token via `set-cookie`). Online status is set via WebSocket (`wss://ws.warframe.market/socket`) using the `@wfm|cmd/status/set` command with a 6-hour duration.

### OCR Overlay (`ocr.rs`)
1. `EE.log` is monitored for `openvoidprojectionrewardscreen`
2. After a 350 ms delay, the top 48% of the Warframe window is captured via `PrintWindow` (GDI) or DXGI Desktop Duplication
3. Windows WinRT OCR extracts text from the capture
4. Rarity bar colour analysis classifies each of the 4 reward slots
5. Fuzzy string matching maps OCR output to catalog item names
6. A transparent overlay displays each card's item name, price, ducat value, and set completion

### Item Data (`wfcd.rs`)
Item and recipe data is fetched on first launch and cached to disk:

| Source | Used for |
|---|---|
| [warframe-items (WFCD)](https://github.com/WFCD/warframe-items) | Item catalog, categories, ducat values, vaulted status |
| [warframe-public-export-plus](https://github.com/calamity-inc/warframe-public-export-plus) | Authoritative recipe trees (LZMA-compressed) |
| [Warframe Wiki Module:Void](https://wiki.warframe.com) | Canonical relic reward display names |

---

## Data & Privacy

- **No account required** for inventory scanning, Foundry, Market Helper, Relic Helper, or Timers
- **No telemetry** — FrameForge has no server and makes no analytics calls
- **Local storage only** — a SQLite database of your quantity changes and trade history at `%LOCALAPPDATA%\warframe-companion\`
- **WFM session token** — stored in Windows Credential Manager if "Stay logged in" is enabled; your password is never saved
- **Warframe.market requests** are made from your machine directly to warframe.market (same as visiting in a browser)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript 5.8, Vite 7 |
| Desktop shell | Tauri 2 |
| Backend | Rust 2021 edition |
| Database | SQLite via `rusqlite` (local only) |
| Async runtime | `tokio` |
| HTTP | `ureq` |
| WebSocket | `tungstenite` (WFM status) |
| Windows APIs | `ReadProcessMemory` / `VirtualQueryEx`, WinRT OCR, DXGI Desktop Duplication, GDI `PrintWindow`, Windows Credential Manager |

---

## License

FrameForge is free and open-source software released under the **GNU General Public License v3.0**.  
See the [LICENSE](LICENSE) file for the full license text.

---

## Contributing

Bug reports and pull requests are welcome. Please open an issue before submitting large changes so we can align on the approach first.

---

*FrameForge is not affiliated with Digital Extremes Ltd. or the Warframe brand. Warframe is a trademark of Digital Extremes Ltd.*
