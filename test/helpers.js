import createTestnet from 'hyperdht/testnet.js'

export async function testnet (t) {
  const net = await createTestnet(3, { teardown: fn => t.after(fn) })
  return net.bootstrap.map(b => b.host + ':' + b.port)
}

export async function until (fn, ms = 15000, step = 100) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await fn()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, step))
  }
  throw new Error('Timed out')
}
