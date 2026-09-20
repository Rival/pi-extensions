# pi-extensions

Pi coding agent extensions by Rival.

## Extensions

| Extension | Description |
|-----------|-------------|
| 🏷️ **session-header** | Session name on the editor's top border + terminal/tab title |
| 📊 **statusline** | Two-line footer: model, git branch, context breakdown, token/cost totals, provider quota |
| 🔄 **custom-compaction** | Use a cheaper model (glm-4.7) for summarization when context fits |

## Documentation

- **[STATUSLINE-QUOTA-SETUP.md](extensions/STATUSLINE-QUOTA-SETUP.md)** — how to configure provider quota cache files for the statusline extension. Create a simple script + cache file for your provider and see quota in your footer.

## Install

```bash
pi install git:github.com/Rival/pi-extensions
```

Or manually in `~/.pi/agent/settings.json`:

```json
{
  "packages": ["git:github.com/Rival/pi-extensions"]
}
```

## License

MIT
