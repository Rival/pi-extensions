# pi-extensions

Pi coding agent extensions by Rival.

## Extensions

| Extension | Description |
|-----------|-------------|
| 🏷️ **session-header** | Session name on the editor's top border + terminal/tab title |
| 📊 **statusline** | Two-line footer: model, git branch, context breakdown, token/cost totals, provider quota |
| 🔄 **custom-compaction** | Use a cheaper model (glm-4.7) for summarization when context fits |

## Install

```json
// ~/.pi/agent/settings.json
{
  "packages": ["git:github.com/andrei/pi-extensions"]
}
```

## License

MIT
