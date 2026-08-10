import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createDaemonServer, createDaemonClient, connectionFingerprint, daemonChildEnvironment, daemonEnvironment, daemonRequestDeadline, daemonStatus, ensureRuntimeDir, runtimePaths, startDaemon } from "../../../../skills/sandbox-ctl/scripts/lib/cube-sandbox-daemon.mjs";
import { daemonPathsFromEnvironment } from "../../../../skills/sandbox-ctl/scripts/lib/cube-sandbox-daemon-process.mjs";
import { createCubeDirectProxy } from "../../../../skills/sandbox-ctl/scripts/lib/cube-sandbox-proxy.mjs";
import net from "node:net";
import http from "node:http";

function testRuntimeDir() {
  return mkdtempSync(path.join(os.tmpdir(), "sandbox-ctl-daemon-test-"));
}

function testPaths(runtimeDir) {
  return runtimePaths({
    runtimeDir,
    socketPath: path.join(runtimeDir, "cube-sandbox.sock"),
    statePath: path.join(runtimeDir, "cube-sandbox-state.json"),
    lockPath: path.join(runtimeDir, "cube-sandbox.lock"),
  });
}

async function withDaemon(options, callback) {
  const runtimeDir = testRuntimeDir();
  const paths = testPaths(runtimeDir);
  const server = createDaemonServer({ ...paths, ...options });
  await server.listen();
  try { return await callback(server); }
  finally {
    await server.close();
    rmSync(runtimeDir, { recursive: true, force: true });
  }
}

function loadRuntimePathsInChild(env) {
  const moduleUrl = new URL("../../../../skills/sandbox-ctl/scripts/lib/cube-sandbox-daemon.mjs", import.meta.url).href;
  const source = `import { runtimePaths } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(runtimePaths()));`;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", source], { env, encoding: "utf8" }));
}

describe("Cube Sandbox daemon protocol", () => {
  it("fingerprints the CUBE connection without exposing the API key or URL query", () => {
    const fingerprint = connectionFingerprint({ CUBE_API_KEY: "cube-secret", E2B_API_KEY: "wrong", CUBE_API_URL: "https://user:pass@cube.example/api?token=secret", E2B_API_URL: "https://e2b.example", CUBE_PROXY_URL: "http://proxy.example/?key=secret" });
    expect(fingerprint).toMatchObject({ apiUrl: "https://cube.example/api", proxy: "http://proxy.example/" });
    expect(fingerprint.apiKeyDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(fingerprint)).not.toContain("cube-secret");
    expect(fingerprint.apiUrlSensitiveDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(fingerprint.proxySensitiveDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(connectionFingerprint({ ...process.env, CUBE_API_URL: "https://cube.example/api?token=other", CUBE_API_NODE_IP: "10.0.0.2", CUBE_API_SANDBOX_DOMAIN: "other.example" })).not.toEqual(fingerprint);
    expect(runtimePaths({ runtimeDir: "/tmp/cube-runtime" })).toMatchObject({ socketPath: "/tmp/cube-runtime/cube-sandbox.sock", statePath: "/tmp/cube-runtime/cube-sandbox-state.json", lockPath: "/tmp/cube-runtime/cube-sandbox.lock" });
  });

  it("uses one stable default runtime path across independently loaded shells", () => {
    const makeEnv = (suffix) => {
      const env = { ...process.env };
      for (const key of ["SANDBOX_CTL_RUNTIME_DIR", "SANDBOX_CTL_DAEMON_SOCKET", "SANDBOX_CTL_DAEMON_RUNTIME_DIR_INTERNAL", "SANDBOX_CTL_DAEMON_SOCKET_PATH_INTERNAL", "SANDBOX_CTL_DAEMON_STATE_PATH_INTERNAL", "SANDBOX_CTL_DAEMON_LOCK_PATH_INTERNAL", "SANDBOX_CTL_USER_CONFIG"]) delete env[key];
      env.TMPDIR = `/tmp/tmp-${suffix}`;
      env.HOME = `/tmp/home-${suffix}`;
      env.XDG_RUNTIME_DIR = `/tmp/runtime-${suffix}`;
      return env;
    };
    const first = loadRuntimePathsInChild(makeEnv("one"));
    const second = loadRuntimePathsInChild(makeEnv("two"));
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      runtimeDir: `/tmp/sandbox-ctl-${process.getuid?.() ?? "user"}`,
      socketPath: `/tmp/sandbox-ctl-${process.getuid?.() ?? "user"}/cube-sandbox.sock`,
    });
  });

  it("applies runtime and socket overrides in the documented order", () => {
    const originalRuntime = process.env.SANDBOX_CTL_RUNTIME_DIR;
    const originalSocket = process.env.SANDBOX_CTL_DAEMON_SOCKET;
    try {
      process.env.SANDBOX_CTL_RUNTIME_DIR = "/tmp/env-runtime";
      process.env.SANDBOX_CTL_DAEMON_SOCKET = "/tmp/env-daemon.sock";
      expect(runtimePaths()).toMatchObject({ runtimeDir: "/tmp/env-runtime", socketPath: "/tmp/env-runtime/cube-sandbox.sock" });
      expect(runtimePaths({ runtimeDir: "/tmp/option-runtime" })).toMatchObject({ runtimeDir: "/tmp/option-runtime", socketPath: "/tmp/option-runtime/cube-sandbox.sock" });
      expect(runtimePaths({ socketPath: "/tmp/option-daemon.sock" })).toMatchObject({ runtimeDir: "/tmp/env-runtime", socketPath: "/tmp/option-daemon.sock" });
      expect(runtimePaths({ runtimeDir: "/tmp/option-runtime", socketPath: "/tmp/option-daemon.sock" })).toMatchObject({ runtimeDir: "/tmp/option-runtime", socketPath: "/tmp/option-daemon.sock" });
    } finally {
      if (originalRuntime === undefined) delete process.env.SANDBOX_CTL_RUNTIME_DIR; else process.env.SANDBOX_CTL_RUNTIME_DIR = originalRuntime;
      if (originalSocket === undefined) delete process.env.SANDBOX_CTL_DAEMON_SOCKET; else process.env.SANDBOX_CTL_DAEMON_SOCKET = originalSocket;
    }
  });

  it("passes the parent-resolved address to the child without a public socket override", () => {
    const runtimeDir = testRuntimeDir();
    const paths = testPaths(runtimeDir);
    const configPath = path.join(runtimeDir, "missing-config.json");
    const childEnv = daemonChildEnvironment(paths, { PATH: process.env.PATH, SANDBOX_CTL_DAEMON_SOCKET: "/tmp/public-daemon.sock", SANDBOX_CTL_USER_CONFIG: configPath });
    try {
      expect(childEnv.SANDBOX_CTL_DAEMON_SOCKET).toBeUndefined();
      expect(daemonPathsFromEnvironment(childEnv)).toEqual(paths);
      for (const key of ["SANDBOX_CTL_DAEMON_RUNTIME_DIR_INTERNAL", "SANDBOX_CTL_DAEMON_SOCKET_PATH_INTERNAL", "SANDBOX_CTL_DAEMON_STATE_PATH_INTERNAL", "SANDBOX_CTL_DAEMON_LOCK_PATH_INTERNAL"]) expect(childEnv[key]).toBeUndefined();
    } finally { rmSync(runtimeDir, { recursive: true, force: true }); }
  });

  it("does not pass the removed public socket override to daemonEnvironment", () => {
    const runtimeDir = testRuntimeDir();
    try {
      const env = daemonEnvironment({ PATH: process.env.PATH, SANDBOX_CTL_DAEMON_SOCKET: "/tmp/public-daemon.sock", SANDBOX_CTL_USER_CONFIG: path.join(runtimeDir, "missing-config.json") });
      expect(env.SANDBOX_CTL_DAEMON_SOCKET).toBeUndefined();
    } finally { rmSync(runtimeDir, { recursive: true, force: true }); }
  });

  it("ignores hostile internal address variables during ordinary default lookup", async () => {
    const names = ["SANDBOX_CTL_DAEMON_RUNTIME_DIR_INTERNAL", "SANDBOX_CTL_DAEMON_SOCKET_PATH_INTERNAL", "SANDBOX_CTL_DAEMON_STATE_PATH_INTERNAL", "SANDBOX_CTL_DAEMON_LOCK_PATH_INTERNAL"];
    const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    const paths = testPaths(testRuntimeDir());
    try {
      for (const name of names) process.env[name] = "/tmp/attacker-controlled";
      expect(runtimePaths()).toMatchObject({ runtimeDir: `/tmp/sandbox-ctl-${process.getuid?.() ?? "user"}`, socketPath: `/tmp/sandbox-ctl-${process.getuid?.() ?? "user"}/cube-sandbox.sock` });
      await expect(daemonStatus(paths)).resolves.toMatchObject({ running: false, socketPath: paths.socketPath });
    } finally {
      for (const [name, value] of Object.entries(original)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
      rmSync(paths.runtimeDir, { recursive: true, force: true });
    }
  });

  it("only accepts a private real runtime directory and re-verifies mode", () => {
    const runtimeDir = testRuntimeDir();
    const filePath = path.join(runtimeDir, "not-a-directory");
    const linkPath = path.join(runtimeDir, "symlink");
    try {
      chmodSync(runtimeDir, 0o755);
      ensureRuntimeDir(runtimeDir);
      expect(lstatSync(runtimeDir).mode & 0o777).toBe(0o700);
      writeFileSync(filePath, "test");
      symlinkSync(runtimeDir, linkPath);
      expect(() => ensureRuntimeDir(filePath)).toThrow("not a directory");
      expect(() => ensureRuntimeDir(linkPath)).toThrow("symlinked");
    } finally { rmSync(runtimeDir, { recursive: true, force: true }); }
  });

  it("reports the exact socket path when no daemon is listening", async () => {
    const runtimeDir = testRuntimeDir();
    const paths = testPaths(runtimeDir);
    const socketPath = paths.socketPath;
    try {
      await expect(createDaemonClient({ socketPath, connectTimeoutMs: 50 }).ping()).rejects.toThrow(socketPath);
      await expect(daemonStatus(paths)).resolves.toMatchObject({ running: false, socketPath });
    } finally { rmSync(runtimeDir, { recursive: true, force: true }); }
  });

  it("best-effort disconnects cached sandbox and client resources on close", async () => {
    const calls = [];
    const sandbox = { commands: { run: async () => ({ exitCode: 0 }) }, disconnect: async () => calls.push("sandbox") };
    const client = { connect: async () => sandbox, close: async () => calls.push("client") };
    await withDaemon({ client }, async (server) => {
      await server.handleRequest({ version: 1, op: "exec", sandboxId: "sbx" }, () => {});
    });
    expect(calls.sort()).toEqual(["client", "sandbox"]);
  });

  it("includes the exact socket path for an indeterminate daemon identity", async () => {
    const configDir = testRuntimeDir();
    const configPath = path.join(configDir, "missing-config.json");
    const originalConfig = process.env.SANDBOX_CTL_USER_CONFIG;
    process.env.SANDBOX_CTL_USER_CONFIG = configPath;
    try {
      await withDaemon({}, async (server) => {
        const paths = testPaths(server.runtimeDir);
        await expect(daemonStatus(paths)).resolves.toMatchObject({ daemonDetected: true, identityError: `daemon state identity is unavailable at ${server.socketPath}` });
        await expect(startDaemon(paths)).rejects.toThrow(server.socketPath);
      });
    } finally {
      if (originalConfig === undefined) delete process.env.SANDBOX_CTL_USER_CONFIG; else process.env.SANDBOX_CTL_USER_CONFIG = originalConfig;
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("gives exec requests a deadline after the requested remote timeout", () => {
    expect(daemonRequestDeadline({ op: "exec", timeoutMs: 900000 })).toBe(930000);
    expect(daemonRequestDeadline({ op: "ping" })).toBe(1500);
  });

  it("streams stdout/stderr and returns the exact remote exit code", async () => {
    const calls = { clients: 0, connects: 0, homes: 0, runs: 0 };
    await withDaemon({
      createClient: async () => { calls.clients += 1; return {
        connect: async () => { calls.connects += 1; return {
          commands: { run: async (_command, options) => {
            calls.runs += 1;
            options.onStdout("out");
            options.onStderr("err");
            return { exitCode: 7 };
          } },
        }; },
      }; },
      resolveRemoteHome: async () => { calls.homes += 1; return "/home/test"; },
    }, async (server) => {
      const result = await createDaemonClient({ socketPath: server.socketPath }).exec({
        sandboxId: "sbx-1", command: "printf test", cwd: "/home/test", timeoutMs: 1000,
      });
      expect(result).toMatchObject({ exitCode: 7, stdout: "out", stderr: "err" });
      expect(calls).toEqual({ clients: 1, connects: 1, homes: 1, runs: 1 });
      const second = await createDaemonClient({ socketPath: server.socketPath }).exec({ sandboxId: "sbx-1", command: "true" });
      expect(second.exitCode).toBe(7);
      expect(calls).toEqual({ clients: 1, connects: 1, homes: 1, runs: 2 });
    });
  });

  it("exposes the daemon-owned loopback proxy through ping/status", async () => {
    await withDaemon({ proxyUrl: "http://127.0.0.1:43123" }, async (server) => {
      await expect(createDaemonClient({ socketPath: server.socketPath }).ping()).resolves.toMatchObject({ ok: true, proxyUrl: "http://127.0.0.1:43123" });
    });
  });

  it("routes CONNECT through the configured Cube node without rewriting the target", async () => {
    let targetSawProbe = false;
    let clientSocket;
    const target = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.on("data", (data) => { if (String(data) === "probe") targetSawProbe = true; socket.write(data); });
    });
    await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetPort = target.address().port;
    const proxy = await createCubeDirectProxy({ nodeIp: "127.0.0.1", httpsPort: targetPort, sandboxDomain: "example" });
    try {
      const response = await new Promise((resolve, reject) => {
        const socket = clientSocket = net.connect(proxy.port, proxy.host, () => {
          socket.write("CONNECT sandbox.example:443 HTTP/1.1\r\nHost: sandbox.example:443\r\n\r\n");
        });
        let data = "";
        socket.on("data", (chunk) => { data += chunk; if (data.includes("\r\n\r\n")) { socket.write("probe"); resolve(data); } });
        socket.on("error", reject);
      });
      expect(response).toContain("200 Connection Established");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(targetSawProbe).toBe(true);
    } finally { clientSocket?.destroy(); await proxy.close(); await new Promise((resolve) => target.close(resolve)); }
  });

  it("dials the control API node for the exact API CONNECT target", async () => {
    const makeTarget = (marker) => net.createServer((socket) => {
      socket.on("error", () => {});
      socket.on("data", () => socket.write(marker));
    });
    const sandboxTarget = makeTarget("sandbox");
    const apiTarget = makeTarget("api");
    await new Promise((resolve) => sandboxTarget.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve) => apiTarget.listen(0, "127.0.0.1", resolve));
    const sandboxPort = sandboxTarget.address().port;
    const apiPort = apiTarget.address().port;
    const proxy = await createCubeDirectProxy({ nodeIp: "127.0.0.1", httpsPort: sandboxPort, apiNodeIp: "127.0.0.1", apiUrl: `https://api.example:${apiPort}`, sandboxDomain: "cube.app" });
    const sockets = [];
    const through = (authority) => new Promise((resolve, reject) => {
      const socket = net.connect(proxy.port, proxy.host, () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
      sockets.push(socket); let data = "";
      socket.on("data", (chunk) => { data += chunk; if (data.includes("200 Connection Established")) socket.write("probe"); if (data.includes("api") || data.includes("sandbox")) resolve(data); });
      socket.on("error", reject);
    });
    try {
      expect(await through(`api.example:${apiPort}`)).toContain("api");
      expect(await through("worker.cube.app:443")).toContain("sandbox");
    } finally { sockets.forEach((socket) => socket.destroy()); await proxy.close(); await new Promise((resolve) => sandboxTarget.close(resolve)); await new Promise((resolve) => apiTarget.close(resolve)); }
  });

  it("dials apiNodeIp for absolute-form API requests while preserving Host", async () => {
    let seen;
    const apiTarget = http.createServer((request, response) => {
      seen = { host: request.headers.host, url: request.url, address: request.socket.remoteAddress };
      response.end("api-http-ok");
    });
    await new Promise((resolve) => apiTarget.listen(0, "127.0.0.1", resolve));
    const apiPort = apiTarget.address().port;
    const proxy = await createCubeDirectProxy({ nodeIp: "127.0.0.1", apiNodeIp: "127.0.0.1", apiUrl: `http://api.example:${apiPort}`, sandboxDomain: "cube.app" });
    try {
      const body = await new Promise((resolve, reject) => {
        const request = http.request({ host: proxy.host, port: proxy.port, path: `http://api.example:${apiPort}/v1/sandboxes?token=redact-me`, headers: { Host: `api.example:${apiPort}` } }, (response) => {
          let data = ""; response.on("data", (chunk) => { data += chunk; }); response.on("end", () => resolve(data));
        });
        request.on("error", reject); request.end();
      });
      expect(body).toBe("api-http-ok");
      expect(seen).toMatchObject({ host: `api.example:${apiPort}`, url: "/v1/sandboxes?token=redact-me" });
    } finally { await proxy.close(); await new Promise((resolve) => apiTarget.close(resolve)); }
  });
});
