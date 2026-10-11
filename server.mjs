// Serves the game and the level editor, and lets the editor save levels.
//
//   node server.mjs [port]
//
// Everything in this folder is served as-is, never cached (so an edited
// module is always the one that loads). The editor uses three routes:
//   GET  /api/levels          every level file: { order, levels: [{ id, name }] }
//   PUT  /api/levels/<id>     save the level that was <id>: to levels/<slug of its name>.level.json
//                             (renaming it, in order.json too, if its name changed)
//   DELETE /api/levels/<id>   delete levels/<id>.level.json and take it out of order.json
//   PUT  /api/order           write levels/order.json (the levels in the game, in order)
import { createServer } from "node:http";
import { readFile, writeFile, readdir, stat, unlink } from "node:fs/promises";
import { slugOf } from "./grid.mjs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const LEVELS = join(ROOT, "levels");
const PORT = Number(process.argv[2] || 8981);
const TYPES = {
  ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
};
const ID = /^[a-z0-9][a-z0-9-]*$/;

const send = (res, status, body, type = "application/json") => {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const bodyOf = (req) => new Promise((ok, fail) => {
  let s = "";
  req.on("data", (c) => (s += c));
  req.on("end", () => { try { ok(JSON.parse(s)); } catch (e) { fail(e); } });
});

// A level file, laid out to read well and diff well: one line per car,
// goal, plate, turntable and path.
export function formatLevel(level) {
  const keys = ["name", "track", "turntables", "switches", "plates", "cars", "couplings", "goals"];
  const lines = [];
  for (const k of [...keys, ...Object.keys(level).filter((k) => !keys.includes(k))]) {
    const v = level[k];
    if (v == null || (Array.isArray(v) && !v.length)) continue;
    if (Array.isArray(v)) {
      const items = v.map((x) => "    " + JSON.stringify(x).replace(/,(?=["{\[]|-?\d)/g, ", ").replace(/":/g, "\": ").replace(/^\{/, "{ ").replace(/\}$/, " }").replace(/\{ \}/g, "{}"));
      lines.push(`  ${JSON.stringify(k)}: [\n${items.join(",\n")}\n  ]`);
    } else lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  }
  return `{\n${lines.join(",\n")}\n}\n`;
}

async function api(req, res, path) {
  if (req.method === "GET" && path === "/api/levels") {
    const files = (await readdir(LEVELS)).filter((f) => f.endsWith(".level.json"));
    const levels = await Promise.all(files.map(async (f) => {
      const id = f.slice(0, -".level.json".length);
      const lv = JSON.parse(await readFile(join(LEVELS, f), "utf8"));
      return { id, name: lv.name || id };
    }));
    const order = JSON.parse(await readFile(join(LEVELS, "order.json"), "utf8"));
    return send(res, 200, { order, levels });
  }
  if (req.method === "PUT" && path === "/api/order") {
    const order = await bodyOf(req);
    if (!Array.isArray(order) || !order.every((id) => ID.test(id))) return send(res, 400, { error: "bad order" });
    await writeFile(join(LEVELS, "order.json"), JSON.stringify(order, null, 2) + "\n");
    return send(res, 200, { ok: true });
  }
  // Save a level. Its file is named after its title, so a level whose title
  // changed moves to a new file, keeping its place in the game.
  const m = path.match(/^\/api\/levels\/([^/]+)$/);
  if (req.method === "PUT" && m) {
    const was = decodeURIComponent(m[1]);
    const level = await bodyOf(req);
    const id = slugOf(level.name || "");
    if (!ID.test(id)) return send(res, 400, { error: "give the level a name first" });
    const file = (x) => join(LEVELS, `${x}.level.json`);
    if (id !== was && (await stat(file(id)).catch(() => null))) return send(res, 409, { error: `there's already a level called ${level.name}` });
    await writeFile(file(id), formatLevel(level));
    if (id !== was && ID.test(was)) {
      await unlink(file(was)).catch(() => {});
      const order = JSON.parse(await readFile(join(LEVELS, "order.json"), "utf8"));
      if (order.includes(was)) await writeFile(join(LEVELS, "order.json"), JSON.stringify(order.map((x) => (x === was ? id : x)), null, 2) + "\n");
    }
    return send(res, 200, { ok: true, id });
  }
  // Delete a level: its file, and its place in the game.
  if (req.method === "DELETE" && m) {
    const id = decodeURIComponent(m[1]);
    if (!ID.test(id)) return send(res, 400, { error: "no such level" });
    await unlink(join(LEVELS, `${id}.level.json`)).catch(() => {});
    const order = JSON.parse(await readFile(join(LEVELS, "order.json"), "utf8"));
    if (order.includes(id)) await writeFile(join(LEVELS, "order.json"), JSON.stringify(order.filter((x) => x !== id), null, 2) + "\n");
    return send(res, 200, { ok: true });
  }
  send(res, 404, { error: "no such route" });
}

const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path.startsWith("/api/")) return await api(req, res, path);
    let file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) return send(res, 403, "no", "text/plain");
    if ((await stat(file).catch(() => null))?.isDirectory()) file = join(file, "index.html");
    const data = await readFile(file).catch(() => null);
    if (!data) return send(res, 404, "not found", "text/plain");
    send(res, 200, data, TYPES[extname(file)] || "application/octet-stream");
  } catch (e) {
    send(res, 500, { error: String(e) });
  }
});
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => console.log(`shunting yard on http://localhost:${PORT}  (editor: /editor.html)`));
}
