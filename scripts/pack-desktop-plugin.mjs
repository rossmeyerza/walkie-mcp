// Builds two plugin zips for the Claude desktop app (Cowork). Neither has the
// channels, userConfig or marketplace.json entries that only Claude Code uses.
//   dist/walkie-desktop-<v>.zip       the plugin points at the .mcpb bundle
//   dist/walkie-desktop-node-<v>.zip  the plugin runs node from its own folder
// Run "npm run pack" first. Needs the zip command.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const bundle = path.join(root, 'dist', 'walkie-mcp-' + pkg.version + '.mcpb')
if (!fs.existsSync(bundle)) throw new Error('Run "npm run pack" first: ' + bundle + ' is missing.')
const PLUGIN_ROOT = '$' + '{CLAUDE_PLUGIN_ROOT}'

function run (cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) throw new Error(cmd + ' ' + args.join(' ') + ' failed')
}

// The desktop zip has its own plugin name. A zip uploaded to claude.ai also
// syncs to Claude Code, and it must not clash with the Claude Code plugin.
function manifest (mcpServers) {
  return { name: 'walkie-desktop', displayName: 'Walkie (desktop)', version: pkg.version, description: pkg.description, author: { name: 'Ross Meyer' }, license: 'MIT', mcpServers }
}

function build (name, mcpServers, fill) {
  const stage = path.join(root, 'build', name)
  fs.rmSync(stage, { recursive: true, force: true })
  fs.mkdirSync(path.join(stage, '.claude-plugin'), { recursive: true })
  fs.writeFileSync(path.join(stage, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest(mcpServers), null, 2) + '\n')
  fs.cpSync(path.join(root, 'skills'), path.join(stage, 'skills'), { recursive: true })
  fill(stage)
  const out = path.join(root, 'dist', name + '-' + pkg.version + '.zip')
  fs.rmSync(out, { force: true })
  run('zip', ['-qr', out, '.', '-x', 'node_modules/**/prebuilds/android-*', 'node_modules/**/prebuilds/ios-*', 'node_modules/**/test/**', 'node_modules/**/*.md', 'node_modules/**/*.map', 'node_modules/**/*.ts'], stage)
  console.log('Built ' + path.relative(root, out) + ' (' + (fs.statSync(out).size / 1e6).toFixed(1) + ' MB)')
}

build('walkie-desktop', './walkie-mcp.mcpb', stage => {
  fs.copyFileSync(bundle, path.join(stage, 'walkie-mcp.mcpb'))
})

build('walkie-desktop-node', {
  walkie: { command: 'node', args: [PLUGIN_ROOT + '/server/index.js'] }
}, stage => {
  fs.cpSync(path.join(root, 'server'), path.join(stage, 'server'), { recursive: true })
  for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(root, f), path.join(stage, f))
  run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--silent'], stage)
})
