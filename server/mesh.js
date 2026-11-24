// The peer-to-peer layer: Hyperswarm connections, room membership and inboxes.
import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import Hyperswarm from 'hyperswarm'
import { deriveRoomKeys, seal, open } from './crypto.js'

export const MAX_TEXT = 16000
const MAX_LINE = 64 * 1024
const MAX_INBOX = 500
const AUTH_TIMEOUT_MS = 30000
const MAX_BAD_FRAMES = 64

export function cleanName (value, fallback = 'unknown') {
  const name = String(value ?? '').replace(/[\x00-\x1f\x7f<>]/g, '').trim().slice(0, 40)
  return name || fallback
}

const fingerprint = buf => buf.toString('hex').slice(0, 8)

export class Mesh extends EventEmitter {
  // Each process gets a fresh key pair. Claude Desktop and several Claude Code
  // sessions can run on one machine, and a shared key pair would collide.
  constructor ({ name, bootstrap } = {}) {
    super()
    this.name = cleanName(name, 'agent')
    this.swarm = new Hyperswarm(bootstrap ? { bootstrap } : {})
    this.publicKey = this.swarm.keyPair.publicKey
    this.fingerprint = fingerprint(this.publicKey)
    this.rooms = new Map()
    this.conns = new Set()
    this.waiters = new Set()
    this.swarm.on('connection', conn => this._onConnection(conn))
    this.swarm.on('error', err => console.error('walkie-mcp: swarm error: ' + (err?.message || err)))
  }

  join ({ room, secret }) {
    if (this.rooms.has(room)) return this.rooms.get(room)
    const { topic, key } = deriveRoomKeys({ room, secret })
    const entry = { room, secret, topic, key, peers: new Map(), inbox: [], seen: new Set() }
    entry.discovery = this.swarm.join(topic, { server: true, client: true })
    this.rooms.set(room, entry)
    for (const state of this.conns) this._sendFrame(state, entry, { t: 'hello', name: this.name })
    return entry
  }

  async leave (room) {
    const entry = this.rooms.get(room)
    if (!entry) return false
    for (const peer of entry.peers.values()) this._sendFrame(peer.state, entry, { t: 'bye' })
    this.rooms.delete(room)
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
    entry.seen.add(id)
    let delivered = 0
    for (const peer of entry.peers.values()) {
      if (this._sendFrame(peer.state, entry, { t: 'msg', id, name: this.name, text: body })) delivered++
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
    const state = { conn, remotePublicKey: conn.remotePublicKey, fingerprint: fingerprint(conn.remotePublicKey), rooms: new Set(), buf: '', bad: 0 }
    this.conns.add(state)
    for (const entry of this.rooms.values()) this._sendFrame(state, entry, { t: 'hello', name: this.name })
    // A peer that cannot prove it holds a room secret is dropped.
    state.timer = setTimeout(() => { if (!state.rooms.size) conn.destroy() }, AUTH_TIMEOUT_MS)
    conn.on('data', data => this._onData(state, data))
    conn.on('error', () => {})
    conn.on('close', () => this._onClose(state))
  }

  _onData (state, data) {
    state.buf += data.toString('utf8')
    let idx
    while ((idx = state.buf.indexOf('\n')) !== -1) {
      const line = state.buf.slice(0, idx)
      state.buf = state.buf.slice(idx + 1)
      if (line.length > MAX_LINE) return state.conn.destroy()
      if (line.trim()) this._onFrame(state, line)
    }
    if (state.buf.length > MAX_LINE) state.conn.destroy()
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
    const current = entry.peers.get(state.fingerprint)
    const isNew = !current || current.state !== state
    if (isNew) this._addPeer(state, entry, payload, Boolean(current))
    const peer = entry.peers.get(state.fingerprint)
    if (payload.t === 'hello') {
      peer.name = cleanName(payload.name, peer.name)
      if (isNew && !payload.reply) this._sendFrame(state, entry, { t: 'hello', name: this.name, reply: true })
    } else if (payload.t === 'msg') {
      this._onMessage(state, entry, peer, payload)
    } else if (payload.t === 'bye') {
      this._removePeer(state, entry)
    }
  }

  _onMessage (state, entry, peer, payload) {
    if (typeof payload.id !== 'string' || payload.id.length > 64 || entry.seen.has(payload.id)) return
    if (typeof payload.text !== 'string' || payload.text.length > MAX_TEXT) return
    entry.seen.add(payload.id)
    if (entry.seen.size > 5000) entry.seen.delete(entry.seen.values().next().value)
    peer.name = cleanName(payload.name, peer.name)
    this._deliver(entry, { kind: 'message', id: payload.id, from: peer.name, fingerprint: state.fingerprint, text: payload.text })
  }

  _addPeer (state, entry, payload, known) {
    const name = cleanName(payload.name)
    entry.peers.set(state.fingerprint, { state, name, fingerprint: state.fingerprint })
    state.rooms.add(entry.room)
    clearTimeout(state.timer)
    if (!known) this._deliver(entry, { kind: 'joined', from: name, fingerprint: state.fingerprint })
  }

  _removePeer (state, entry) {
    const peer = entry.peers.get(state.fingerprint)
    if (!peer || peer.state !== state) return
    entry.peers.delete(state.fingerprint)
    state.rooms.delete(entry.room)
    this._deliver(entry, { kind: 'left', from: peer.name, fingerprint: state.fingerprint })
  }

  _onClose (state) {
    clearTimeout(state.timer)
    this.conns.delete(state)
    for (const entry of this.rooms.values()) this._removePeer(state, entry)
  }
}
