/**
 * ELM Marketing Engine — Orchestrator stub
 * Phase 00: Healthcheck only. Full implementation in Phase 02.
 */

import 'dotenv/config'
import express from 'express'

const PORT = parseInt(process.env.PORT ?? '3200', 10)
const app = express()

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'elm-orchestrator', phase: '00-stub' })
})

app.listen(PORT, () => {
  console.log(`[ELM-ORCHESTRATOR] Healthcheck stub listening on :${PORT}`)
})
