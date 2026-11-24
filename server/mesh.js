// The peer-to-peer layer: Hyperswarm connections, room membership and inboxes.
import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import Hyperswarm from 'hyperswarm'
import { deriveRoomKeys, seal, open } from './crypto.js'

export const MAX_TEXT = 16000
const MAX_LINE = 64 * 1024
const MAX_INBOX = 500
const AUTH_TIMEOUT_MS = 5000
const MAX_BAD_FRAMES = 64
const MAX_UNAUTHENTICATED = 16
const BAN_MS = 10 * 60 * 1000
const RATE_WINDOW_MS = 60 * 1000
const RATE_MAX = 30
const ID_RE = /^[0-9a-f]{16}$/
const NAME_PAD = 64

// Names reach the model, so allow only letters, digits, spaces and . _ ' -
export function cleanName (value, fallback = 'unknown') {
  const name = String(value ?? '').normalize('NFKC').replace(/[^\p{L}\p{N} ._'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40)
  return name || fallback
}

const fingerprint = buf => buf.toString('hex').slice(0, 16)

export class Mesh extends EventEmitter {
  // Each process gets a fresh key pair. Claude Desktop and several Claude Code
  // sessions can run on one machine, and a shared key pair would collide.
  constructor ({ name, bootstrap } = {}) {
    super()
    this.name = cleanName(name, 'agent')
    this.banned = new Map()
    this.swarm = new Hyperswarm({
      ...(bootstrap ? { bootstrap } : {}),
      // Reject keys that recently failed to prove room membership.
      firewall: remotePublicKey => this._isBanned(remotePublicKey.toString('hex'))
    })
    this.publicKey = this.swarm.keyPair.publicKey
    this.fingerprint = fingerprint(this.publicKey)
    this.rooms = new Map()
    this.conns = new Set()
    this.waiters = new Set()
    this.swarm.on('connection', conn => this._onConnection(conn))
    this.swarm.on('error', err => console.error('walkie-mcp: swarm error: ' + (err?.message || err)))
  }

  join ({ room, secret }) {
    const existing = this.rooms.get(room)
    if (existing && existing.secret !== secret) throw new Error('You are already in a different room called "' + room + '". Leave it first.')
    if (existing) return existing
    this.banned.clear() // A peer dropped after an earlier leave may be a member again.
    const { topic, key } = deriveRoomKeys({ room, secret })
    const entry = { room, secret, topic, key, peers: new Map(), inbox: [], seen: new Set() }
    entry.discovery = this.swarm.join(topic, { server: true, client: true })
    this.rooms.set(room, entry)
    for (const state of this.conns) this._sendFrame(state, entry, this._hello())
    return entry
  }

  async leave (room) {
    const entry = this.rooms.get(room)
    if (!entry) return false
    for (const peer of entry.peers.values()) this._sendFrame(peer.state, entry, { t: 'bye' })
    this.rooms.delete(room)
    for (const state of this.conns) {
      state.rooms.delete(room)
      if (!state.rooms.size) this._startAuthTimer(state)
    }
    await this.swarm.leave(entry.topic)
    return true
  }

  send (room, text) {
    const entry = this.rooms.get(room)
    if (!entry) throw new Error('You are not in the room "' + room + '".')
    const body = String(text ?? '')
    if (!body.trim()) throw new Error('The message is empty.')
    if (body.length > MAX_TEXT) throw new Error('The message is too long (maximum ' + MAX_TEXT + ' characters).')
    const id = crypto.randomBytes(8).toString('hex')
    const payload = { t: 'msg', id, name: this.name, text: body }
    // Base64 adds a third, and the frame adds about 100 bytes.
    if (Math.ceil(Buffer.byteLength(JSON.stringify(payload)) * 4 / 3) + 200 > MAX_LINE) throw new Error('The message is too large to send. Make it shorter.')
    entry.seen.add(id)
    let delivered = 0
    for (const peer of entry.peers.values()) {
      if (this._sendFrame(peer.state, entry, payload)) delivered++
    }
    return { id, delivered }
  }

  // Drains unread messages. Waits up to waitMs when there are none.
  async read (room, waitMs = 0) {
    if (room && !this.rooms.has(room)) throw new Error('You are not in the room "' + room + '".')
    const messages = this._drain(room)
    if (messages.length || waitMs <= 0) return messages
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.waiters.delete(check); resolve() }
      const check = r => { if (!room || r === room) done() }
      const timer = setTimeout(done, waitMs)
      this.waiters.add(check)
    })
    return this._drain(room)
  }

  status () {
    return [...this.rooms.values()].map(entry => ({
      room: entry.room,
      unread: entry.inbox.length,
      peers: [...entry.peers.values()].map(p => ({ name: p.name, fingerprint: p.fingerprint }))
    }))
  }

  async destroy () {
    for (const room of [...this.rooms.keys()]) await this.leave(room).catch(() => {})
    await this.swarm.destroy()
  }

  _drain (room) {
    const out = []
    for (const entry of this.rooms.values()) {
      if (room && entry.room !== room) continue
      out.push(...entry.inbox.splice(0))
    }
    return out.sort((a, b) => a.seq - b.seq)
  }

  _deliver (entry, message) {
    this._seq = (this._seq || 0) + 1
    const item = { ...message, room: entry.room, seq: this._seq, receivedAt: Date.now() }
    entry.inbox.push(item)
    if (entry.inbox.length > MAX_INBOX) entry.inbox.splice(0, entry.inbox.length - MAX_INBOX)
    this.emit('message', item)
    for (const check of [...this.waiters]) check(entry.room)
  }

  _sendFrame (state, entry, payload) {
    if (!state?.conn?.writable) return false
    state.conn.write(JSON.stringify(seal(entry.key, this.publicKey, state.remotePublicKey, payload)) + '\n')
    return true
  }

  _onConnection (conn) {
    const key = conn.remotePublicKey.toString('hex')
    const state = { conn, key, remotePublicKey: conn.remotePublicKey, fingerprint: fingerprint(conn.remotePublicKey), rooms: new Set(), authed: false, chunks: [], size: 0, bad: 0, sent: [] }
    // Attach the handlers first, so that a refused connection still leaves this.conns.
    conn.on('error', () => {})
    conn.on('close', () => this._onClose(state))
    this.conns.add(state)
    if ([...this.conns].filter(s => !s.rooms.size).length > MAX_UNAUTHENTICATED) return conn.destroy()
    conn.on('data', data => this._onData(state, data))
    for (const entry of this.rooms.values()) this._sendFrame(state, entry, this._hello())
    this._startAuthTimer(state)
  }

  // A peer that shares no room is dropped. A peer that never proved membership
  // of any room is also banned. A former member is not, so it can come back.
  _startAuthTimer (state) {
    clearTimeout(state.timer)
    state.timer = setTimeout(() => { if (!state.rooms.size) this._reject(state) }, AUTH_TIMEOUT_MS)
  }

  _reject (state) {
    if (!state.authed) this.banned.set(state.key, Date.now() + BAN_MS)
    state.conn.destroy()
  }

  _isBanned (key) {
    const until = this.banned.get(key)
    if (until && until > Date.now()) return true
    this.banned.delete(key)
    return false
  }

  _hello () {
    // Pad so that the frame length does not show the name length.
    return { t: 'hello', name: this.name, pad: '.'.repeat(NAME_PAD - this.name.length) }
  }

  _onData (state, data) {
    let start = 0
    let idx
    while ((idx = data.indexOf(10, start)) !== -1) {
      state.chunks.push(data.subarray(start, idx))
      const line = Buffer.concat(state.chunks)
      state.chunks = []
      state.size = 0
      start = idx + 1
      if (line.length > MAX_LINE) return state.conn.destroy()
      this._onFrame(state, line.toString('utf8'))
      if (state.conn.destroyed) return
    }
    if (start < data.length) {
      state.chunks.push(data.subarray(start))
      state.size += data.length - start
      if (state.size > MAX_LINE) state.conn.destroy()
    }
  }

  _onFrame (state, line) {
    let frame
    try { frame = JSON.parse(line) } catch { frame = null }
    for (const entry of this.rooms.values()) {
      const payload = open(entry.key, state.remotePublicKey, this.publicKey, frame)
      if (payload && typeof payload === 'object') return this._onPayload(state, entry, payload)
    }
    // Frames for rooms that we do not share are normal. Count them only while
    // the peer has not proved membership of any room.
    if (!state.rooms.size && ++state.bad > MAX_BAD_FRAMES) state.conn.destroy()
  }

  _onPayload (state, entry, payload) {
    const current = entry.peers.get(state.key)
    const isNew = !current || current.state !== state
    if (isNew) this._addPeer(state, entry, payload, Boolean(current))
    const peer = entry.peers.get(state.key)
    if (payload.t === 'hello') {
      peer.name = cleanName(payload.name, peer.name)
      if (isNew && !payload.reply) this._sendFrame(state, entry, { ...this._hello(), reply: true })
    } else if (payload.t === 'msg') {
      this._onMessage(state, entry, peer, payload)
    } else if (payload.t === 'bye') {
      this._removePeer(state, entry)
    }
  }

  _onMessage (state, entry, peer, payload) {
    if (typeof payload.id !== 'string' || !ID_RE.test(payload.id) || entry.seen.has(payload.id)) return
    if (typeof payload.text !== 'string' || payload.text.length > MAX_TEXT) return
    if (this._rateLimited(state)) return
    entry.seen.add(payload.id)
    if (entry.seen.size > 5000) entry.seen.delete(entry.seen.values().next().value)
    peer.name = cleanName(payload.name, peer.name)
    this._deliver(entry, { kind: 'message', id: payload.id, from: peer.name, fingerprint: state.fingerprint, text: payload.text })
  }

  // Each peer may send RATE_MAX messages in each RATE_WINDOW_MS, over all rooms.
  _rateLimited (state) {
    const now = Date.now()
    state.sent = state.sent.filter(t => now - t < RATE_WINDOW_MS)
    if (state.sent.length >= RATE_MAX) return true
    state.sent.push(now)
    return false
  }

  _addPeer (state, entry, payload, known) {
    const name = cleanName(payload.name)
    entry.peers.set(state.key, { state, name, fingerprint: state.fingerprint })
    state.rooms.add(entry.room)
    state.authed = true
    clearTimeout(state.timer)
    if (!known) this._deliver(entry, { kind: 'joined', from: name, fingerprint: state.fingerprint })
  }

  _removePeer (state, entry) {
    const peer = entry.peers.get(state.key)
    if (!peer || peer.state !== state) return
    entry.peers.delete(state.key)
    state.rooms.delete(entry.room)
    if (!state.rooms.size && !state.conn.destroyed) this._startAuthTimer(state)
    this._deliver(entry, { kind: 'left', from: peer.name, fingerprint: state.fingerprint })
  }

  _onClose (state) {
    clearTimeout(state.timer)
    this.conns.delete(state)
    for (const entry of this.rooms.values()) this._removePeer(state, entry)
  }
}
