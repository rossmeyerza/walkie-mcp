// Local state: the list of joined rooms (room names and secrets).
// Messages are never written to disk.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function dataDir () {
  return process.env.WALKIE_MCP_DIR || path.join(os.homedir(), '.walkie-mcp')
}

function ensureDir () {
  const dir = dataDir()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

function writePrivate (file, data) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, data, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export function loadRooms () {
  const file = path.join(ensureDir(), 'rooms.json')
  if (!fs.existsSync(file)) return []
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(data.rooms) ? data.rooms.filter(r => r && r.room && r.secret) : []
  } catch (err) {
    console.error(`walkie-mcp: could not read rooms.json: ${err.message}`)
    return []
  }
}

export function saveRooms (rooms) {
  const file = path.join(ensureDir(), 'rooms.json')
  writePrivate(file, JSON.stringify({ rooms }, null, 2) + '\n')
}
