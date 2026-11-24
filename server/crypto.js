// Key derivation, invites and authenticated encryption for walkie-mcp.
//
// Security model: the room secret never leaves the machine. The swarm topic
// and the message key are derived from it with separate HKDF labels, so the
// topic (which public DHT nodes can see) gives no access to the room. Every
// frame is sealed with AES-256-GCM and bound to the static Noise public keys of
// the sender and the receiver. Noise authenticates those keys, so a frame
// cannot be forged, read, moved to another peer or reflected without the secret.
import crypto from 'node:crypto'

export const PROTOCOL = 'walkie-mcp/v1'
const INVITE_PREFIX = 'walkie-mcp:v1:'
const ROOM_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
const SECRET_BYTES = 32
const NONCE_BYTES = 12

export function normaliseRoomName (name) {
  const room = String(name || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  if (!ROOM_RE.test(room)) throw new Error('Room name must use letters, digits and hyphens (1 to 40 characters).')
  return room
}

export function newRoom (name) {
  const base = name ? normaliseRoomName(name) : 'room'
  const suffix = crypto.randomBytes(2).toString('hex')
  const room = normaliseRoomName(`${base.slice(0, 35)}-${suffix}`)
  return { room, secret: crypto.randomBytes(SECRET_BYTES).toString('base64url') }
}

export function formatInvite ({ room, secret }) {
  return `${INVITE_PREFIX}${room}:${secret}`
}

export function parseInvite (invite) {
  const text = String(invite || '').trim()
  if (!text.startsWith(INVITE_PREFIX)) throw new Error('This is not a walkie-mcp invite. It must start with "walkie-mcp:v1:".')
  const [room, secret, ...rest] = text.slice(INVITE_PREFIX.length).split(':')
  if (rest.length || !room || !secret) throw new Error('The invite is incomplete. Copy the whole invite again.')
  if (!ROOM_RE.test(room)) throw new Error('The room name in the invite is not valid.')
  const raw = Buffer.from(secret, 'base64url')
  if (raw.length !== SECRET_BYTES || raw.toString('base64url') !== secret) throw new Error('The secret in the invite is not valid.')
  return { room, secret }
}

function hkdf (secret, label, room) {
  const ikm = Buffer.from(secret, 'base64url')
  return Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.from(PROTOCOL), Buffer.from(`${label}:${room}`), 32))
}

export function deriveRoomKeys ({ room, secret }) {
  return { topic: hkdf(secret, 'topic', room), key: hkdf(secret, 'message-key', room) }
}

function aad (senderPub, receiverPub) {
  return Buffer.concat([Buffer.from(PROTOCOL + '|'), senderPub, Buffer.from('|'), receiverPub])
}

export function seal (key, senderPub, receiverPub, payload) {
  const nonce = crypto.randomBytes(NONCE_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(aad(senderPub, receiverPub))
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final(), cipher.getAuthTag()])
  return { v: 1, n: nonce.toString('base64'), c: body.toString('base64') }
}

// Returns the parsed payload, or null when the frame is not for this key.
export function open (key, senderPub, receiverPub, frame) {
  try {
    if (!frame || frame.v !== 1 || typeof frame.n !== 'string' || typeof frame.c !== 'string') return null
    const nonce = Buffer.from(frame.n, 'base64')
    const body = Buffer.from(frame.c, 'base64')
    if (nonce.length !== NONCE_BYTES || body.length < 17) return null
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(aad(senderPub, receiverPub))
    decipher.setAuthTag(body.subarray(body.length - 16))
    const plain = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()])
    return JSON.parse(plain.toString('utf8'))
  } catch {
    return null
  }
}
