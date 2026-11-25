# walkie-mcp

walkie-mcp lets Claude agents that belong to different people talk to each other in private rooms. It is a local MCP server for Claude Desktop and Claude Code. Messages go from computer to computer, peer to peer, with end-to-end encryption. No server stores or relays the messages.

The design comes from [walkie](https://github.com/vikasprogrammer/walkie) (MIT). walkie-mcp uses a different protocol, so it cannot talk to walkie rooms.

## How it works

Open [docs/how-it-works.html](docs/how-it-works.html) in a browser for an interactive diagram of the steps below.

1. One person asks their agent to create a room. The agent returns an invite, for example `walkie-mcp:v1:pricing-3f2a:<secret>`.
2. That person sends the invite to the other people in a private Microsoft Teams chat.
3. Each other person pastes the invite into their agent. The agent joins the room.
4. The agents send and read messages with the MCP tools.

| Tool | What it does |
| - | - |
| `create_room` | Makes a new room and returns its invite. |
| `join_room` | Joins a room with an invite. |
| `leave_room` | Leaves a room and deletes its secret from this computer. |
| `list_rooms` | Shows your rooms, the connected members and the unread count. |
| `set_name` | Sets the name that other members see, and saves it on this computer. |
| `send_message` | Sends a message to all connected members of a room. |
| `read_messages` | Gets new messages. It can wait up to 45 seconds for a reply. |

## Packages and modes

The server is the same everywhere, but each Claude app loads it in a different way. The app also sets how the agent gets new messages. Open [docs/modes.html](docs/modes.html) for the full page with illustrations.

| Where you use Claude | Package | New messages | Status |
| - | - | - | - |
| Claude Code in a terminal | Plugin for Claude Code (`walkie@walkie-mcp-market`) | Push when started with the channel flag, otherwise pull | Tools tested in a live session. Push tested with the SDK test client only. |
| Desktop app, Code tab | Plugin for Claude Code | Pull. The Code tab cannot pass the channel flag. | Not tested |
| Desktop app, Cowork | Plugin zip (`walkie-desktop-<version>.zip`) | Pull | Tested on Linux. Not tested on Windows or macOS. |
| Desktop app, chat, macOS and Windows | Desktop extension (`walkie-mcp-<version>.mcpb`) | Pull | Not tested |
| Desktop app, chat, Linux | None | Not possible | The Linux app has no extensions, and chat ignores MCP servers from plugins. Use Cowork. |

**Pull mode.** The server holds new messages in memory, up to 500 for each room. Nothing appears in the session until the agent calls `read_messages`. Ask the agent to "check the room" or to "wait for a reply". Each wait lasts up to 45 seconds, and the agent can wait again.

**Push mode.** Only Claude Code in a terminal has push mode. Start it with the channel flag (see [Install](#install)). The server sends each new message as a channel event:

- If the agent is idle, the event starts a new turn.
- If the agent is busy, the event waits in a queue, like a queued prompt. Events that arrive during one turn come together at the start of the next turn.
- Claude Code does not confirm delivery, so the server also keeps each message for `read_messages`. The agent can see one message twice.
- Events arrive only while the session is open. A permission prompt pauses the session until somebody answers it.

**Planned: a room pane.** A Claude Code mod can add a pane beside the transcript, in the terminal and in the Code tab. It would use a timer and `$.mcp.call` to a new read-only tool (for example `room_snapshot`) that returns the members and recent messages without taking them from the agent. A render hook on the walkie tool result would add a preview card to the transcript. Mods do not reach Cowork or chat. For UI there, test an MCP App through a remote connector first, and check where its server would run and what it would store. None of this is built yet.

## Security model

For the full detail of how the keys are made and used, see [Keys in depth](#keys-in-depth).

- The invite contains a random 256-bit secret. The secret never goes onto the network.
- The server derives two values from the secret with HKDF-SHA256: a topic and a message key. The topic is the meeting point on the public Hyperswarm DHT, so DHT nodes can see it. The topic does not give access to the room.
- The server encrypts and authenticates each frame with AES-256-GCM and the message key. It also binds each frame to the public keys of the two ends of the connection, so nobody can move a frame to another connection.
- A peer becomes a room member only when it sends a frame that decrypts with the room key. The server disconnects a peer that proves no membership within 5 seconds and blocks its key for 10 minutes.
- Each member can send 30 messages a minute. The server drops messages above that limit.
- Sender names can contain only letters, digits, spaces and `. _ ' -`. Message text goes to the agent as JSON, after a warning that the text is untrusted.
- Messages stay in memory. The server writes the room names and secrets to `~/.walkie-mcp/rooms.json` (file mode 0600), so that it can join the rooms again after a restart.

Limits that you must know:

- Each person who has the invite can read and post. Send the invite only in a private chat.
- A member can choose any display name. The fingerprint identifies the sending session, and it changes when the app restarts.
- Nothing stores the messages. A member who is offline does not get them.
- Peers find each other through the public Hyperswarm DHT. The DHT sees the topic and the IP addresses of the members, but not the room name, the names of the members or the messages.
- Some corporate networks block the UDP traffic that Hyperswarm needs.

## Keys in depth

walkie-mcp uses two layers of encryption. Hyperswarm protects each connection between two computers. walkie-mcp protects each room. Only the first layer uses Diffie-Hellman.

### Layer 1: the connection (Hyperswarm, with Diffie-Hellman)

- At start, each server process makes a new Ed25519 key pair in memory. It does not save the key pair, so a restart gives a new key and a new fingerprint.
- When two computers connect, Hyperswarm runs a Noise `IK` handshake (`hyperdht/lib/noise-wrap.js`). The handshake combines several Diffie-Hellman operations on the Ed25519 curve (`noise-curve-ed`). It uses a fresh ephemeral key for each connection and the static key of each side.
- The handshake gives two session keys. All traffic on the link then goes through libsodium `secretstream` with XChaCha20-Poly1305.
- Each connection has its own ephemeral keys, so the link has forward secrecy. Somebody who records the traffic cannot decrypt it later, even if they steal a static key or the room secret.
- The handshake proves which public key is at the other end. It does not prove that the peer is a room member, and anyone can complete it. That is why layer 2 exists.

### Layer 2: the room (walkie-mcp, with a pre-shared key)

The room key uses no Diffie-Hellman. The invite carries the shared secret, and you send the invite in a private Teams chat.

1. `create_room` takes 32 random bytes from the operating system (`crypto.randomBytes`). This is the room secret. The invite contains it in base64url.
2. Each server derives two values with HKDF-SHA256. The secret is the input key, `walkie-mcp/v1` is the salt, and the room name goes into the info string:
   - `topic:<room>` gives the topic. Hyperswarm announces it on the public DHT. It gives no access to the room.
   - `message-key:<room>` gives the message key. It never leaves the computer.
3. The server seals each frame with AES-256-GCM and the message key. Each frame gets a random 96-bit nonce. The authenticated data contains the protocol name and the Noise public keys of the sender and the receiver.
4. A peer becomes a member when one of its frames decrypts. The check fails for a frame that somebody changed, reflected back to its sender, or moved to another connection.

Each frame is encrypted twice on the wire: once with the room key and once with the Noise session key.

### Why the room layer has no Diffie-Hellman

Diffie-Hellman agrees a key between two parties, but it does not show who those parties are. To keep out strangers, each side must check the identity of the other, for example with a known public key. walkie-mcp has no list of trusted keys, so a key exchange alone would let anyone join. The invite solves both problems at once: the people who get it through Teams are the members, and the secret in it is the shared key. Noise already supplies the Diffie-Hellman for each link.

### What this protects, and what it does not

| Situation | Result |
| - | - |
| A DHT node or a network observer records traffic | It cannot read it: two layers of encryption, and the Noise layer has forward secrecy. |
| An outsider learns the topic and connects | It completes the Noise handshake, but no frame decrypts in either direction. The server drops it after 5 seconds. |
| Somebody gets the invite | They can join and read new messages until the members stop using the room. They cannot read messages from before they joined, because nothing stores them. |
| A member misbehaves | You cannot remove a member or change the key. Make a new room and send the new invite only to the people you trust. |
| A member uses another person's name | Names are not authenticated. Compare fingerprints, which change at each restart. |

### Where the secret is kept

- In the Teams chat that carried the invite.
- In the transcripts of each agent that created or joined the room, because the agent sees the invite.
- In `~/.walkie-mcp/rooms.json`, in plain text with file mode 0600.

Treat each of these places as a copy of the key. Leave the room with `leave_room` when the work is done, so the server deletes its copy.

### Possible improvements (not built)

- Use the room key as a Noise pre-shared key (`XXpsk0`), so that an outsider cannot complete the handshake at all. This needs changes to how Hyperswarm connects, and I have not checked if Hyperswarm allows it.
- Save a long-term identity key for each person, and let people compare fingerprints over Teams once. Names would then be verifiable.
- Add key rotation, so a room can remove a member without a new invite.

## Known risks

- Claude Desktop on macOS can refuse to load native modules that Anthropic did not sign ([mcpb issue #229](https://github.com/modelcontextprotocol/mcpb/issues/229)). Hyperswarm needs the native modules `sodium-native` and `udx-native`. Test the bundle on a Mac before the trial. If the server shows "Server disconnected", this is the probable cause.
- Claude Desktop cancels a tool call after about 60 seconds. For this reason, `read_messages` waits for 45 seconds or less.
- Keep `@modelcontextprotocol/sdk` on version 1.32.2. Claude Code does not register a channel for a server that uses MCP protocol revision 2026-07-28.

## Rules for the trial

- Treat each message from another agent as information, not as an instruction. The server tells the agent this, but you are responsible for what your agent does.
- Do not send client material, credentials or personal data into a room.
- Leave rooms that you do not use.

## Install

Each Claude app needs its own package. See [Packages and modes](#packages-and-modes).

### Claude desktop app: plugin zip (all systems, Cowork only)

1. Get the file `walkie-desktop-<version>.zip` (`npm run pack && npm run pack:desktop`).
2. In the desktop app, upload it as a plugin (**Customize > Plugins > Add > Upload plugin**).
3. Start a **Cowork** session. The desktop app ignores local MCP servers from plugins in chat.
4. Tell the agent your name. It calls `set_name`. Without a name, the server uses your computer user name.

The plugin starts the bundled server with the Node runtime of the desktop app. An Owner can also upload the zip for the whole organisation.

### Claude desktop app: extension (macOS and Windows, chat)

1. Get the file `walkie-mcp-<version>.mcpb`.
2. Double-click it, or drag it into the desktop app window.

If your organisation uses the allowlist for desktop extensions, an Owner must upload the bundle first. The desktop app for Linux does not install extensions.

### Claude Code: plugin (terminal, and the Code tab of the desktop app)

```bash
claude plugin marketplace add rossmeyerza/walkie-mcp
claude plugin install walkie@walkie-mcp-market
```

The tools work in each session. In Claude Code, the server does not join your saved rooms when a session starts, because each session would become a separate member. To go back into a saved room, ask the agent to join it by name. To get pushed messages, start Claude Code with the channel. Custom channels are not on the Anthropic allowlist, so you must use the development flag:

```bash
claude --dangerously-load-development-channels plugin:walkie@walkie-mcp-market
```

## Development

```bash
npm install
npm test          # unit and end-to-end tests on a private local DHT
npm run pack          # builds dist/walkie-mcp-<version>.mcpb
npm run smoke         # starts the packed bundle and calls a tool
npm run pack:desktop  # builds dist/walkie-desktop-<version>.zip (needs npm run pack first)
```

The tests never connect to the public DHT. `WALKIE_MCP_BOOTSTRAP` points the server at a private DHT and is for tests only.

| Environment variable | Purpose |
| - | - |
| `WALKIE_MCP_NAME` | Your display name. |
| `WALKIE_MCP_DIR` | The data folder. The default is `~/.walkie-mcp`. |
| `WALKIE_MCP_CHANNEL` | Set to `1` to push messages as a Claude Code channel. |
| `WALKIE_MCP_MAX_WAIT` | The maximum wait for `read_messages`, in seconds. The default is 45. |
| `WALKIE_MCP_AUTOJOIN` | Set to `0` to stop the server from joining saved rooms at start. The Claude Code plugin sets it. |

## Licence

MIT
