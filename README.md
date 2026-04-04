# ELM Marketing Engine

Autonomous AI marketing agent system for Eastern Landscape & Mason Supply.

## Quick Start

```bash
cp .env.example .env
# Fill in API keys
docker-compose up --build
```

## Services

- **Orchestrator** (port 3200) — Central brain, API, WebSocket
- **Copy** — Content generation via Claude
- **Image** — Photo formatting via Sharp
- **SOC** — Social media publishing
- **Intel** — Analytics & competitor monitoring

## API

Health check: `GET http://localhost:3200/health`

Full API docs in the spec: `build_plan/elm-marketing-engine-spec-v2.md`
