import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { extname, join, normalize } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { SERVER_PORT, SIM_HZ, SNAPSHOT_HZ, TICK_MS } from "../src/config";
import { PROTOCOL_VERSION, decode, encode, type ClientMsg } from "../src/net/protocol";
import { Room, type Member } from "./room.ts";

const room = new Room();

// Serve the built client if there is one, so the server can host the game itself.
const DIST = join(import.meta.dirname, "..", "dist");
const TYPES: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".webp": "image/webp", ".png": "image/png",
};

function serveClient(req: IncomingMessage, res: ServerResponse): void {
  const url = (req.url ?? "/").split("?")[0];
  const rel = normalize(url === "/" ? "index.html" : url.slice(1)).replace(/^(\.\.[/\\])+/, "");
  const file = join(DIST, rel);
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end("Run `npm run build` to serve the client from here.");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

/**
 * Set TLS_CERT and TLS_KEY (paths to a PEM certificate and key) to serve https and
 * wss instead of http and ws. A page served over https — GitHub Pages — can only
 * open wss connections, and the certificate must be one browsers trust for this
 * server's hostname (e.g. Let's Encrypt); a self-signed one won't be accepted.
 */
const tls =
  process.env.TLS_CERT && process.env.TLS_KEY
    ? { cert: readFileSync(process.env.TLS_CERT), key: readFileSync(process.env.TLS_KEY) }
    : null;
const http = tls ? createSecureServer(tls, serveClient) : createServer(serveClient);

const wss = new WebSocketServer({ server: http });

wss.on("connection", (socket: WebSocket) => {
  let member: Member | null = null;

  socket.on("message", (raw: unknown) => {
    const msg = decode<ClientMsg>(String(raw));
    if (!msg) return;
    if (msg.t === "hello") {
      if (member) return;
      member = {
        name: (msg.name || "Anon").slice(0, 16),
        player: null,
        spectator: msg.spectate === true,
        send: (m) => socket.readyState === socket.OPEN && socket.send(encode(m as never)),
      };
      room.members.add(member);
      if (!member.spectator) room.join(member);
      member.send({
        t: "welcome",
        version: PROTOCOL_VERSION,
        you: member.player ?? 0,
        round: room.roundInfo(),
        players: room.playerDTOs(),
      });
      console.log(`+ ${member.name}${member.spectator ? " (spectating)" : ""} (${room.members.size} connected)`);
      return;
    }
    if (msg.t === "cmd" && member) room.command(member, msg.cmd);
    if (msg.t === "respawn" && member) room.respawn(member);
  });

  const drop = () => {
    if (!member) return;
    console.log(`- ${member.name} (${room.members.size - 1} connected)`);
    room.leave(member);
    member = null;
  };
  socket.on("close", drop);
  socket.on("error", drop);
});

// Authoritative loop: step at SIM_HZ, broadcast at SNAPSHOT_HZ.
let lag = 0;
let last = Date.now();
const every = Math.max(1, Math.round(SIM_HZ / SNAPSHOT_HZ));
setInterval(() => {
  const now = Date.now();
  lag += now - last;
  last = now;
  // Catch up, but never spiral if the process was suspended.
  let steps = 0;
  while (lag >= TICK_MS && steps < 5) {
    room.step();
    lag -= TICK_MS;
    steps++;
  }
  if (lag > TICK_MS * 5) lag = 0;
  if (steps === 0 || room.world.tick % every !== 0) return;
  for (const m of room.members) {
    if (m.spectator) m.send(room.snapshotFor(null));
    else if (m.player != null) m.send(room.snapshotFor(m.player));
  }
}, TICK_MS / 2);

http.listen(SERVER_PORT, () => {
  const [web, socket] = tls ? ["https", "wss"] : ["http", "ws"];
  console.log(`fungi server on ${web}://localhost:${SERVER_PORT} (${socket} on the same port)`);
});
