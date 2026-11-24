// Builds dist/walkie-mcp-<version>.mcpb from a clean staging directory.
// Plain Node, no shell syntax, so it works on macOS, Linux and Windows.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const MCPB_VERSION = '2.1.2'
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const stage = path.join(root, 'build', 'stage')
const output = path.join(root, 'dist', `walkie-mcp-${version}.mcpb`)

const manifestVersion = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version
if (manifestVersion !== version) {
  console.error(`manifest.json version (${manifestVersion}) does not match package.json version (${version}).`)
  process.exit(1)
}

function run (command, args, cwd) {
  console.log('> ' + [command, ...args].join(' '))
  // npm and npx are .cmd files on Windows, which need a shell. The arguments are fixed.
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    console.error(`Command failed with exit code ${result.status}: ${command} ${args.join(' ')}`)
    process.exit(result.status ?? 1)
  }
}

fs.rmSync(stage, { recursive: true, force: true })
fs.mkdirSync(stage, { recursive: true })
fs.mkdirSync(path.dirname(output), { recursive: true })
fs.rmSync(output, { force: true })

for (const item of ['server', 'manifest.json', 'package.json', 'package-lock.json', '.mcpbignore', 'icon.png']) {
  const source = path.join(root, item)
  if (fs.existsSync(source)) fs.cpSync(source, path.join(stage, item), { recursive: true })
}

// Production dependencies only. Scripts are off because the prebuilds are already in the packages.
run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage)
run('npx', ['-y', `@anthropic-ai/mcpb@${MCPB_VERSION}`, 'pack', stage, output], root)

console.log(`Built ${path.relative(root, output)} (${(fs.statSync(output).size / 1048576).toFixed(1)} MB)`)
