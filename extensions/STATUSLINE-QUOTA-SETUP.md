# Statusline — Provider Quota Setup

Statusline shows your **token/cost quota** for the active model — how much you've used,
how much is left, and when it resets.

```
⛽82% ⏰14:22 🛢️🛢️🛢️🛢️40% 📅Mon 09:00
│     │       │              └── weekly pool resets (day + time)
│     │       └── weekly pool: 4 of 10 tanks remaining (40% used)
│     └── 5-hour pool resets at 14:22
└── 5-hour pool: 82% remaining (18% used)
```

---

## How It Works

Statusline reads a **JSON cache file** written by a daemon or cron script. The
cache file contains your current usage stats. Statusline reads it synchronously
(on every render) — fast, no network calls.

Two built-in providers:

| Provider | Matches models | Cache file | Fetch script |
|----------|---------------|------------|--------------|
| **GLM** (z.ai) | `glm-*` | `/tmp/glm-quota-cache.json` | `~/.claude/scripts/quota-glm.sh` |
| **Codex** (OpenAI) | `gpt-*`, `o1-*`, `o3-*`, `o4-*`, `*codex*` | `/tmp/codex-quota-cache.json` | _(daemon-only)_ |

---

## JSON Format

Both cache files use the same schema. Statusline reads these fields:

```jsonc
{
  "token_pct": 1,        // 5-hour pool usage %  (0–100). Omit if no 5-hour pool.
  "token_resets": 1788096745,  // 5-hour pool reset time (epoch seconds)
  "week_pct": 60,        // Weekly pool usage %  (0–100). Omit if no weekly pool.
  "week_resets": 1788343202,   // Weekly pool reset time (epoch seconds)
  "mcp_cur": 1282,       // Current tool-call / MCP usage (optional)
  "mcp_tot": 4000,       // Total tool-call / MCP budget (optional)
  "level": "max"         // Plan/level label (optional, shown in model icon area)
}
```

> **`poolPct` / `weekPct` are USAGE percentages** — 0 = fresh, 100 = fully consumed.
> Statusline automatically inverts them to show REMAINING (e.g. 20% used → ⛽80%).

### Minimal example (weekly pool only)

```json
{
  "week_pct": 30,
  "week_resets": 1788681900
}
```

### Full example (5-hour + weekly + MCP)

```json
{
  "token_pct": 45,
  "token_resets": 1788096745,
  "week_pct": 12,
  "week_resets": 1788343202,
  "mcp_cur": 1282,
  "mcp_tot": 4000,
  "level": "max"
}
```

---

## Quick Start: Create a Quota Script

### 1. Shell script that writes JSON to stdout

Create `~/.claude/scripts/quota-myprovider.sh`:

```bash
#!/bin/bash
# Fetch your provider's quota and output JSON.
# Cache file at /tmp/myprovider-quota-cache.json

cache_file="/tmp/myprovider-quota-cache.json"

# If cache is fresh (< 5 min old), just cat it
if [ -f "$cache_file" ]; then
  age=$(( $(date +%s) - $(stat -c %Y "$cache_file" 2>/dev/null || echo 0) ))
  if [ "${age:-999}" -lt 300 ]; then
    cat "$cache_file"
    exit 0
  fi
fi

# Fetch fresh data — replace with your provider's API
RESPONSE=$(curl -s -m 5 \
  -H "Authorization: Bearer $MY_API_KEY" \
  "https://api.myprovider.com/v1/usage")

# Parse and write cache
echo "$RESPONSE" | jq '{token_pct: .usage.rate, week_pct: .usage.weekly, week_resets: .reset_weekly}' \
  | tee "$cache_file"
```

Make it executable:

```bash
chmod +x ~/.claude/scripts/quota-myprovider.sh
```

### 2. Daemon / cron to keep cache fresh

For **Linux (Hyprland / systemd)** — add a user service:

```ini
# ~/.config/systemd/user/quota-myprovider.service
[Unit]
Description=Refresh myprovider quota cache

[Service]
Type=oneshot
ExecStart=%h/.claude/scripts/quota-myprovider.sh --refresh
```

```ini
# ~/.config/systemd/user/quota-myprovider.timer
[Unit]
Description=Refresh myprovider quota every 5 min

[Timer]
OnBootSec=1min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
```

```bash
systemctl --user enable --now quota-myprovider.timer
```

For **macOS** — use a LaunchAgent (plist).

For **any OS** — just a cron job:

```bash
(crontab -l 2>/dev/null; echo "*/5 * * * * $HOME/.claude/scripts/quota-myprovider.sh --refresh") | crontab -
```

### 3. Add your provider to statusline.ts

Open `extensions/statusline.ts` and add a new entry to the `PROVIDERS` array:

```typescript
{
  id: "myprovider",
  matches: (id) => id.toLowerCase().includes("myprovider"),
  cacheFile: "/tmp/myprovider-quota-cache.json",
  script: join(QUOTA_SCRIPTS_DIR, "quota-myprovider.sh"),
  parse: (d) => ({
    poolPct: num(d.token_pct),
    poolResets: num(d.token_resets),
    weekPct: num(d.week_pct),
    weekResets: num(d.week_resets),
    level: typeof d.plan === "string" ? d.plan : undefined,
  }),
  render: (q, theme) => {
    const parts: string[] = [];
    // 5-hour pool
    if (q.poolPct != null) {
      const remaining = Math.max(0, 100 - q.poolPct);
      const col = q.poolPct >= 80 ? "error" : q.poolPct >= 60 ? "warning" : "success";
      parts.push(theme.fg(col, `⛽${remaining}%`));
    }
    // Weekly pool
    if (q.weekPct != null) {
      const remaining = Math.max(0, 100 - q.weekPct);
      const tanks = Math.max(0, Math.min(10, Math.round(remaining / 10)));
      const col = q.weekPct >= 80 ? "error" : q.weekPct >= 60 ? "warning" : "success";
      parts.push(theme.fg(col, `🛢️`.repeat(tanks) + `${remaining}%`));
    }
    return parts;
  },
}
```

---

## Existing Setup (this machine)

On **andreiryzen** (Linux, Hyprland), quota is maintained by a Hyprland Lua
daemon that keeps both cache files fresh. The GLM script doubles as a
cold-start fallback when the daemon hasn't written the cache yet.

| File | Purpose |
|------|---------|
| `~/.claude/scripts/quota-glm.sh` | Fetches GLM (z.ai) quota, writes `/tmp/glm-quota-cache.json` |
| Hyprland Lua daemon | Keeps both caches fresh (runs every 5 min) |

### Test your setup

```bash
# Check if cache exists and is valid
cat /tmp/glm-quota-cache.json | jq '.token_pct, .week_pct'

# Force refresh
~/.claude/scripts/quota-glm.sh --refresh
```

If the cache is missing or stale, the quota section simply won't render —
statusline handles this gracefully.
