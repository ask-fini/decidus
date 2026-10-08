#!/usr/bin/env node
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// node:sqlite is stable enough for this and the warning is noise for users
const emit = process.emitWarning;
process.emitWarning = ((w: any, ...rest: any[]) => {
  if (String(typeof w === "string" ? rest[0] : w?.name) === "ExperimentalWarning" && String(w).includes("SQLite")) return;
  return (emit as any).call(process, w, ...rest);
}) as typeof process.emitWarning;

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const db = flag("db", process.env.DECIDUS_DB ?? join(homedir(), ".decidus", "decidus.db"))!;
const cmd = args[0] ?? "help";

if (cmd === "serve") {
  mkdirSync(dirname(db), { recursive: true });
  const { createServer } = await import("./server.js");
  const { writer } = await import("./loop.js");
  const port = Number(flag("port", process.env.PORT ?? "7700"));
  const { server } = createServer({ db });
  server.listen(port, () => {
    const w = writer();
    console.log(`decidus  http://localhost:${port}`);
    console.log(`db       ${db}`);
    console.log(w ? `writer   ${w.provider}/${w.model}` : "writer   none: set OPENAI_API_KEY, ANTHROPIC_API_KEY or GEMINI_API_KEY to write suggestions");
  });
} else if (cmd === "reset") {
  rmSync(db, { force: true }); rmSync(db + "-wal", { force: true }); rmSync(db + "-shm", { force: true });
  console.log(`deleted ${db}`);
} else {
  console.log(`decidus serve [--port 7700] [--db ~/.decidus/decidus.db]   local UI and API
decidus reset [--db path]                                    delete the local database`);
}
