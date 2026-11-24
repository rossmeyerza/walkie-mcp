import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { newRoom, formatInvite, parseInvite, deriveRoomKeys, seal, open } from '../server/crypto.js'

test('an invite round-trips and has a 256-bit secret', () => {
  const room = newRoom('Q3 Pricing!')
  assert.match(room.room, /^q3-pricing-[0-9a-f]{4}$/)
  assert.equal(Buffer.from(room.secret, 'base64url').length, 32)
  assert.deepEqual(parseInvite(formatInvite(room)), room)
})

test('bad invites are rejected', () => {
  const invite = formatInvite(newRoom('x'))
  assert.throws(() => parseInvite('walkie:room:secret'))
  assert.throws(() => parseInvite(invite.slice(0, -3)))
  assert.throws(() => parseInvite(invite + ':extra'))
  const secret = newRoom('x').secret
  assert.throws(() => parseInvite('walkie-mcp:v1:abc-:' + secret), /room name/)
})

test('the topic and the message key are independent', () => {
  const keys = deriveRoomKeys(newRoom('x'))
  assert.notDeepEqual(keys.topic, keys.key)
  assert.equal(keys.topic.length, 32)
  assert.equal(keys.key.length, 32)
})

test('a frame opens only with the right key and the right connection', () => {
  const { key } = deriveRoomKeys(newRoom('x'))
  const other = deriveRoomKeys(newRoom('x')).key
  const a = crypto.randomBytes(32)
  const b = crypto.randomBytes(32)
  const c = crypto.randomBytes(32)
  const frame = seal(key, a, b, { t: 'msg', text: 'hi' })
  assert.deepEqual(open(key, a, b, frame), { t: 'msg', text: 'hi' })
  assert.equal(open(other, a, b, frame), null, 'wrong key')
  assert.equal(open(key, b, a, frame), null, 'reflected back to the sender')
  assert.equal(open(key, a, c, frame), null, 'replayed to another peer')
  const tampered = { ...frame, c: Buffer.from(Buffer.from(frame.c, 'base64').map((x, i) => i === 0 ? x ^ 1 : x)).toString('base64') }
  assert.equal(open(key, a, b, tampered), null, 'tampered')
  assert.equal(open(key, a, b, 'garbage'), null)
})
