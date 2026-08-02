import { execFileSync } from "node:child_process";

const DEV_PORTS = [1422, 1423];
const projectRoot = process.cwd();

function commandOutput(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function listenersOn(port) {
  return commandOutput("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"])
    .split("\n")
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function processCwd(pid) {
  const output = commandOutput("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  return output.split("\n").find((line) => line.startsWith("n"))?.slice(1) ?? "";
}

function processCommand(pid) {
  return commandOutput("ps", ["-p", String(pid), "-o", "command="]);
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const listeners = new Map();
for (const port of DEV_PORTS) {
  for (const pid of listenersOn(port)) {
    const ports = listeners.get(pid) ?? [];
    ports.push(port);
    listeners.set(pid, ports);
  }
}

for (const [pid, ports] of listeners) {
  const command = processCommand(pid);
  const cwd = processCwd(pid);
  const isProjectVite = cwd === projectRoot && /(?:^|[/\s])vite(?:\.js)?(?:\s|$)/i.test(command);

  if (!isProjectVite) {
    throw new Error(
      `Cannot start LemonPi: port ${ports.join(", ")} is owned by another process.\n` +
      `PID ${pid}: ${command || "unknown command"}`,
    );
  }

  process.kill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 20 && isRunning(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (isRunning(pid)) process.kill(pid, "SIGKILL");

  console.log(`Stopped stale LemonPi Vite process ${pid} on port ${ports.join(", ")}.`);
}
