# FrameForge — Warframe Companion

A **read-only** desktop companion for Warframe that shows your live inventory, tracks crafting recipes, displays market prices, and auto-detects relic reward screens — all without touching the game process or sending your data anywhere.

> **Windows only** — requires Windows 10 or 11 with Warframe installed.

---

## Features

### Live Inventory Scanning
Your inventory is read directly from the Warframe process memory every 10 seconds. No login required for this feature. The scanner is **strictly read-only** — it uses `ReadProcessMemory`, the same Windows API used by tools like Overwolf and MSI Afterburner. It never writes to memory, injects code, or modifies the game in any way.

### Foundry — Recipe Browser & Tracker
Browse every craftable item in the game with full ingredient trees. Star items to **track** them in the side panel, which shows you exactly what you still need to farm and what you already have.

### Market Helper
Look up platinum sell prices from [warframe.market](https://warframe.market) for any item or prime set. Prices are fetched on-demand using the public warframe.market v2 API — no account required, no data sent.

### Relic Helper
Browse void fissure drop tables and calculate the best relics to run for missing prime parts, using community drop rate data.

### OCR Relic Reward Overlay
When a void fissure reward screen opens in-game, FrameForge automatically captures and reads the four reward cards using Windows OCR and displays a small overlay with each item's platinum price, ducat value, and set completion — so you can pick the best reward instantly without alt-tabbing.

---

## Is This Safe? (Read This If You Found Us on Reddit)

This is a fair question whenever an app reads game memory. Here is exactly what FrameForge does and does not do:

| | What FrameForge does |
|---|---|
| **Memory access** | Read-only via `ReadProcessMemory` — the same Windows API used by Overwolf, Discord overlay, and hardware monitors. |
| **Game modification** | Nothing. No DLL injection, no hooking, no writing to memory. |
| **Network requests** | Only to `warframe.market` (prices) and community data GitHub repos (item catalog, drop rates). No telemetry, no analytics, no FrameForge server. |
| **Your account** | Never touched unless you enable the optional Warframe Companion API feature, which uses credentials already present in the game's own memory — and never writes them to disk. |
| **Your data** | Nothing leaves your machine except the two API calls listed above. |

Digital Extremes has publicly confirmed that read-only memory tools (used by Overwolf, Warframe Companion, etc.) are acceptable. FrameForge follows the same approach.

**Don't take our word for it** — the full source code is in this repository under GPLv3. You can read every line, build it yourself, and verify exactly what it does. The distributed `.exe` contains minified frontend code (standard build practice), but the source here is the authoritative, readable version.

---

## Requirements

- Windows 10 or 11 (64-bit)
- [Warframe](https://www.warframe.com/) installed (not required just to browse recipes/prices)
- The OCR overlay works best in Windowed or Borderless Windowed mode; Fullscreen Exclusive is also supported via DXGI capture

---

## Installation

1. Go to [**Releases**](../../releases) and download the latest `FrameForge_x.x.x_x64-setup.exe`
2. Run the installer — Windows SmartScreen may warn you because the binary is not yet code-signed; click **More info → Run anyway**
3. Launch FrameForge from the Start menu or desktop shortcut

> The SmartScreen warning appears because code-signing certificates cost ~$300/year. The source code is fully public for independent verification.

---

## Building From Source

```powershell
# Prerequisites: Node.js 20+, pnpm, Rust (MSVC toolchain)
rustup default stable-x86_64-pc-windows-msvc

# Clone and install dependencies
git clone https://github.com/Sikewyrm/frameforge.git
cd frameforge
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

- **Resource scanner** — finds stackable items via JSON patterns like `"ItemCount":N,"ItemType":"/Lotus/..."`
- **Unique scanner** — finds weapons, Warframes, and companions via Aho-Corasick multi-pattern matching on item path strings
- **Pending recipe scanner** — finds active Foundry jobs by locating ISO-8601 completion timestamps adjacent to `/Lotus/` paths

A **stability buffer** requires a quantity to appear unchanged in two consecutive scans before it is committed to state. This prevents false readings from in-game reward selection screens where inventory values are temporarily loaded into memory mid-session.

Regions are filtered strictly: only `MEM_COMMIT` regions with readable page protection are scanned, and any region larger than 128 MB is skipped to avoid mapping enormous allocations into RAM.

### OCR Overlay (`ocr.rs`)
1. `EE.log` is monitored for the `openvoidprojectionrewardscreen` marker
2. After a 350 ms delay (card fade-in animation), the top 48% of the Warframe window is captured via `PrintWindow` (GDI) for windowed/borderless, or DXGI Desktop Duplication for fullscreen exclusive
3. Windows WinRT OCR (`Windows.Media.Ocr`) extracts text from the capture
4. Rarity bar colour analysis classifies each of the 4 reward slots (Bronze / Silver / Gold / Platinum)
5. Fuzzy string matching (Levenshtein distance + prefix/suffix/sliding-window scoring) maps OCR output to catalog item names
6. A transparent overlay window shows each card's item name, platinum price, ducat value, and set completion in priority order

### Item Data (`wfcd.rs`)
Item and recipe data is fetched on first launch and cached to disk. Three sources are merged:

| Source | Used for |
|---|---|
| [warframe-items (WFCD)](https://github.com/WFCD/warframe-items) | Item catalog, categories, ducat values, vaulted status |
| [warframe-public-export-plus](https://github.com/calamity-inc/warframe-public-export-plus) | Authoritative recipe trees from DE's own export data (LZMA-compressed) |
| [Warframe Wiki Module:Void](https://wiki.warframe.com) | Canonical relic reward display names |

---

## Data & Privacy

- **No account required** for inventory scanning, Foundry, or Relic Helper
- **No telemetry** — FrameForge has no server and makes no analytics calls
- **No data stored to disk** except a local SQLite database of your own quantity changes (stored in `%LOCALAPPDATA%\warframe-companion\`)
- **Warframe.market requests** are made with your IP address visible to warframe.market (same as visiting the website in a browser)
- If you use the optional inventory sync feature, your session credentials are held in RAM only for the duration of the session and never written to disk

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
| Windows APIs | `ReadProcessMemory` / `VirtualQueryEx`, WinRT OCR, DXGI Desktop Duplication, GDI `PrintWindow` |

---

## License

FrameForge is free and open-source software released under the **GNU General Public License v3.0**.  
See the [LICENSE](LICENSE) file for the full license text.

You are free to use, study, modify, and distribute this software. Any distributed modifications must be released under the same GPLv3 license.

---

## Contributing

Bug reports and pull requests are welcome. Please open an issue before submitting large changes so we can align on the approach first.

---

*FrameForge is not affiliated with Digital Extremes Ltd. or the Warframe brand. Warframe is a trademark of Digital Extremes Ltd.*
