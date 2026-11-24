import test from 'node:test'
import assert from 'node:assert/strict'
import Hyperswarm from 'hyperswarm'
import { Mesh } from '../server/mesh.js'
import { newRoom, deriveRoomKeys } from '../server/crypto.js'
import { testnet, until } from './helpers.js'

function connected (mesh, room, n = 1) {
  return () => (mesh.status().find(r => r.room === room)?.peers.length || 0) >= n
}

test('two members exchange messages; a wrong secret gets nothing', async t => {
  const bootstrap = await testnet(t)
  const room = newRoom('trial')
  const alice = new Mesh({ name: 'Alice', bootstrap })
  const bob = new Mesh({ name: 'Bob', bootstrap })
  const eve = new Mesh({ name: 'Eve', bootstrap })
  t.after(() => Promise.all([alice.destroy(), bob.destroy(), eve.destroy()]))

  alice.join(room)
  bob.join(room)
  eve.join({ room: room.room, secret: newRoom('x').secret })
  await until(connected(alice, room.room))
  await until(connected(bob, room.room))

  const joined = await bob.read(room.room)
  assert.ok(joined.some(m => m.kind === 'joined' && m.from === 'Alice'))

  const sent = alice.send(room.room, 'hello Bob')
  assert.equal(sent.delivered, 1)
  const got = await bob.read(room.room, 5000)
  assert.equal(got.length, 1)
  assert.equal(got[0].text, 'hello Bob')
  assert.equal(got[0].from, 'Alice')
  assert.equal(got[0].fingerprint, alice.fingerprint)

  assert.equal(eve.status()[0].peers.length, 0)
  assert.deepEqual(await eve.read(undefined, 500), [])
})

test('read waits for a message', async t => {
  const bootstrap = await testnet(t)
  const room = newRoom('wait')
  const a = new Mesh({ name: 'A', bootstrap })
  const b = new Mesh({ name: 'B', bootstrap })
  t.after(() => Promise.all([a.destroy(), b.destroy()]))
  a.join(room); b.join(room)
  await until(connected(a, room.room))
  await until(connected(b, room.room))
  await b.read()
  setTimeout(() => a.send(room.room, 'later'), 300)
  const got = await b.read(room.room, 10000)
  assert.equal(got[0].text, 'later')
})

test('a peer that knows only the topic cannot read or post', async t => {
  const bootstrap = await testnet(t)
  const room = newRoom('target')
  const { topic } = deriveRoomKeys(room)
  const member = new Mesh({ name: 'Member', bootstrap })
  const other = new Mesh({ name: 'Other', bootstrap })
  const attacker = new Hyperswarm({ bootstrap })
  t.after(() => Promise.all([member.destroy(), other.destroy(), attacker.destroy()]))

  const seen = []
  attacker.on('connection', conn => {
    conn.on('data', d => seen.push(d.toString()))
    conn.on('error', () => {})
    // Stock walkie admits a peer that echoes the topic hash. Try that, and a forged frame.
    conn.write(JSON.stringify({ t: 'hello', topics: [topic.toString('hex')], id: 'x' }) + '\n')
    conn.write(JSON.stringify({ t: 'msg', topic: topic.toString('hex'), data: 'injected', id: 'x', ts: Date.now() }) + '\n')
    conn.write(JSON.stringify({ v: 1, n: Buffer.alloc(12).toString('base64'), c: Buffer.alloc(40).toString('base64') }) + '\n')
  })
  attacker.join(topic, { server: true, client: true })
  member.join(room)
  other.join(room)
  await until(connected(member, room.room))
  await until(() => seen.length > 0)

  member.send(room.room, 'secret plan')
  await other.read(room.room, 5000)
  await new Promise(resolve => setTimeout(resolve, 500))

  assert.equal(member.status()[0].peers.length, 1, 'only the real member is a peer')
  assert.ok(!seen.join('').includes('secret plan'), 'the attacker sees no plaintext')
  assert.ok(!seen.join('').includes('Member'), 'the attacker does not see member names')
  const inbox = await member.read(room.room)
  assert.ok(!inbox.some(m => m.text === 'injected'))
})
