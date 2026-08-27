import { spawn } from "node:child_process";
import path from "node:path";

const websocketUrl = "ws://localhost:3001/api/ws";
const nextCli = path.resolve("node_modules/next/dist/bin/next");
const children = [
  spawn(process.execPath, [nextCli, "dev", "--webpack"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NEXT_PUBLIC_WS_URL: websocketUrl,
    },
    stdio: "inherit",
  }),
  spawn(process.execPath, ["--import", "tsx", "server.mjs", "--dev", "--ws-only"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: "3001",
    },
    stdio: "inherit",
  }),
];

let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exitCode = exitCode;
}

for (const child of children) {
  child.on("error", (error) => {
    console.error(error);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    if (!stopping) stop(code ?? (signal ? 1 : 0));
  });
}

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
