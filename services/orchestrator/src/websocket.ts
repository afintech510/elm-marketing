/**
 * websocket.ts — WebSocket broadcast for real-time dashboard updates
 */

import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'http'
import type { WsEvent } from './types.js'

let wss: WebSocketServer
const connectedClients = new Set<WebSocket>()

/**
 * Initialize WebSocket server on an existing HTTP server
 */
export function initWebSocket(httpServer: Server): WebSocketServer {
  wss = new WebSocketServer({ server: httpServer, path: '/ws' })

  wss.on('connection', (ws) => {
    connectedClients.add(ws)
    console.log(`[WS] Client connected (total: ${connectedClients.size})`)

    ws.on('close', () => {
      connectedClients.delete(ws)
      console.log(`[WS] Client disconnected (total: ${connectedClients.size})`)
    })

    ws.on('error', (err) => {
      console.error('[WS] Client error:', err.message)
      connectedClients.delete(ws)
    })

    // Send welcome message
    ws.send(JSON.stringify({ type: 'connected', message: 'ELM Marketing Engine WebSocket' }))
  })

  return wss
}

/**
 * Broadcast an event to all connected clients
 */
export function broadcast(event: WsEvent): void {
  const data = JSON.stringify(event)
  for (const client of connectedClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data)
    }
  }
}

/**
 * Get count of connected clients
 */
export function getClientCount(): number {
  return connectedClients.size
}
