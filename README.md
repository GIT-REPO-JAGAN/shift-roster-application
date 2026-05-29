# ShiftScheduler — Kyndryl

> A browser-based shift roster generator for Kyndryl operations teams.  
> Runs entirely in the browser — no backend, no login required.

## Features

- **Upload roster** — accepts `.xlsx` with Name / Email / Skill / Location columns
- **Shift Assignments via Automation** — auto-fills multi-group bracket allocation rules per skill
- **Shift Assignments via Prompt** — free-text prompt for custom allocations
- **Parsed Rules Preview** — live table showing resolved shifts, rotation and week-off per skill
- **Leave & Adhoc** — Planned Leave, Comp-Off and Adhoc entries applied on top of the schedule
- **Validate** — pre-generation checks for allocation mismatches and missing data
- **Generate & Download** — produces `.xlsx` (3 sheets), `.json` and `.html` roster files
- **SL / EL – Absence & Coverage** — standalone module for sick/emergency leave swap management
- **Publish the Roster** — publishes the latest generated HTML roster to a public GitHub Gist

## File Structure

```
ShiftScheduler/
├── index.html              # Main entry point (no inline JS/CSS)
├── LOGO.png                # Kyndryl logo (sidebar)
├── css/
│   └── styles.css          # All UI styles
├── js/
│   ├── config.js           # Constants, DEFAULT_RULES, global state
│   ├── utils.js            # Shared helpers (dates, formatting, etc.)
│   ├── roster.js           # File upload and roster parsing
│   ├── rules.js            # Automation/Prompt rules, validation, preview
│   ├── scheduler.js        # Shift scheduling and week-off assignment
│   ├── leave.js            # Leave data parsing and schedule overrides
│   ├── exporter.js         # Excel / JSON / HTML generation
│   └── app.js              # UI orchestration, SL/EL module, Publish
├── config/
│   └── shift-rules.json    # Default shift rules (reference)
├── .nojekyll               # Disables Jekyll processing on GitHub Pages
├── _config.yml             # GitHub Pages config
├── .gitignore
├── 404.html                # Custom 404 redirect
└── README.md
```

## Quick Start

1. Open `index.html` in any modern browser (Chrome, Edge, Firefox).
2. Upload a staff roster `.xlsx` file (columns: Name, Email, Skill, Location).
3. Set the date range and holidays in Step 2.
4. Review or adjust shift assignments in Step 3.
5. Optionally add leave/adhoc entries in Step 4.
6. Validate (Step 5) then Generate & Download (Step 6).

## GitHub Pages Deployment

```bash
git init
git add .
git commit -m "Initial deploy"
git branch -M main
git remote add origin https://github.com/<user>/shift-scheduler.git
git push -u origin main
```
Enable **GitHub Pages** from the repository Settings → Pages → Source: `main` branch, root `/`.

## Publish the Roster

After generating or re-modifying the roster:
1. Create a [GitHub Personal Access Token](https://github.com/settings/tokens/new?scopes=gist) with `gist` scope.
2. Paste the token in the **Publish the Roster** card.
3. Click **Test** to verify, then **Publish**.
4. The live URL (via `gist.githack.com`) is displayed and can be copied or opened directly.

## Shift Codes

| Code | Shift | Hours |
|------|-------|-------|
| M | Morning | 05:30–14:30 |
| A | Afternoon | 13:30–22:30 |
| N | Night | 21:30–06:30 |
| E | Evening | 17:30–02:30 |
| E1 | Evening-1 | 19:30–04:30 |
| G | General | 09:30–18:30 |
| W | Week Off | — |
| PL | Planned Leave | — |
| CO | Comp-Off | — |
| AH | Account Holiday | — |
| LH | Location Holiday | — |
| SL | Sick Leave | — |
| EL | Emergency Leave | — |
