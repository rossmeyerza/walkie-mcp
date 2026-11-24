// Smoke test for the packed .mcpb bundle.
// Unzips dist/walkie-mcp-<version>.mcpb, starts its server on a private testnet, lists tools and calls create_room.
// It never joins the public DHT.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import createTestnet from 'hyperdht/testnet.js'

const root = path.resolve(import.meta.dirname, '..')
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const bundle = path.join(root, 'dist', `walkie-mcp-${version}.mcpb`)
const EXPECTED_TOOLS = ['create_room', 'join_room', 'leave_room', 'list_rooms', 'read_messages', 'send_message', 'set_name']

function fail (message) {
  throw new Error('Smoke test failed: ' + message)
}

function unzip (archive, target) {
  // tar reads zip files on Windows 10+ and macOS. Linux uses unzip.
  const [command, args] = process.platform === 'linux'
    ? ['unzip', ['-q', archive, '-d', target]]
    : ['tar', ['-xf', archive, '-C', target]]
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error || result.status !== 0) fail('could not unzip the bundle with ' + command)
}

if (!fs.existsSync(bundle)) fail(`${path.relative(root, bundle)} not found. Run "npm run pack" first.`)

fs.mkdirSync(path.join(root, 'build'), { recursive: true })
const work = fs.mkdtempSync(path.join(root, 'build', 'smoke-'))
const unpacked = path.join(work, 'bundle')
const dataDir = path.join(work, 'data')
fs.mkdirSync(unpacked)
fs.mkdirSync(dataDir)
unzip(bundle, unpacked)

const net = await createTestnet(3)
const bootstrap = net.bootstrap.map(b => b.host + ':' + b.port).join(',')
let client
try {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(unpacked, 'server', 'index.js')],
    cwd: unpacked,
    env: { ...process.env, WALKIE_MCP_DIR: dataDir, WALKIE_MCP_NAME: 'Smoke', WALKIE_MCP_BOOTSTRAP: bootstrap },
    stderr: 'inherit'
  })
  client = new Client({ name: 'smoke', version: '0.0.0' })
  await client.connect(transport)

  const tools = (await client.listTools()).tools.map(tool => tool.name).sort()
  console.log('tools:', tools.join(', '))
  if (JSON.stringify(tools) !== JSON.stringify(EXPECTED_TOOLS)) fail('unexpected tool list')

  const result = await client.callTool({ name: 'create_room', arguments: { name: 'smoke' } })
  if (result.isError) fail('create_room returned an error: ' + result.content[0].text)
  const created = JSON.parse(result.content[0].text)
  console.log('create_room invite:', created.invite.slice(0, 32) + '...')
  if (!/^walkie-mcp:v1:smoke-[0-9a-f]{4}:/.test(created.invite)) fail('invite has an unexpected format')
  console.log('OK')
} finally {
  await client?.close().catch(() => {})
  await net.destroy()
  fs.rmSync(work, { recursive: true, force: true })
}
process.exit(0)
