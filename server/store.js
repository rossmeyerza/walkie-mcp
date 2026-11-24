// Local state: the list of joined rooms (room names and secrets).
// Messages are never written to disk. Several processes (Claude Desktop and
// Claude Code sessions) share this file, so each change is merged into the
// current file instead of overwriting it.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function dataDir () {
  return process.env.WALKIE_MCP_DIR || path.join(os.homedir(), '.walkie-mcp')
}

function ensureDir () {
  const dir = dataDir()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700)
  return dir
}

const roomsFile = () => path.join(ensureDir(), 'rooms.json')

function writePrivate (file, data) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, data, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export function loadRooms () {
  const file = roomsFile()
  if (!fs.existsSync(file)) return []
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(data.rooms) ? data.rooms.filter(r => r && typeof r.room === 'string' && typeof r.secret === 'string') : []
  } catch (err) {
    // Keep the damaged file for inspection, so that the next write does not lose it.
    const aside = `${file}.corrupt-${Date.now()}`
    fs.renameSync(file, aside)
    console.error(`walkie-mcp: rooms.json could not be read (${err.message}). It was moved to ${aside}.`)
    return []
  }
}

function update (change) {
  writePrivate(roomsFile(), JSON.stringify({ rooms: change(loadRooms()) }, null, 2) + '\n')
}

export function addRoom ({ room, secret }) {
  update(rooms => [...rooms.filter(r => r.room !== room), { room, secret }])
}

export function removeRoom (room) {
  update(rooms => rooms.filter(r => r.room !== room))
}
