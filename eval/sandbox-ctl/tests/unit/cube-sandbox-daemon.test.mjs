import { describe, expect, it } from "vitest";

import { createDaemonServer, createDaemonClient, connectionFingerprint, daemonRequestDeadline, runtimePaths } from "../../../../skills/sandbox-ctl/scripts/lib/cube-sandbox-daemon.mjs";
import { createCubeDirectProxy } from "../../../../skills/sandbox-ctl/scripts/lib/cube-sandbox-proxy.mjs";
import net from "node:net";
import http from "node:http";

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

  it("best-effort disconnects cached sandbox and client resources on close", async () => {
    const calls = [];
    const sandbox = { commands: { run: async () => ({ exitCode: 0 }) }, disconnect: async () => calls.push("sandbox") };
    const client = { connect: async () => sandbox, close: async () => calls.push("client") };
    const server = createDaemonServer({ socketPath: "/tmp/sandbox-ctl-daemon-resource-test.sock", client });
    await server.listen();
    await server.handleRequest({ version: 1, op: "exec", sandboxId: "sbx" }, () => {});
    await server.close();
    expect(calls.sort()).toEqual(["client", "sandbox"]);
  });

  it("gives exec requests a deadline after the requested remote timeout", () => {
    expect(daemonRequestDeadline({ op: "exec", timeoutMs: 900000 })).toBe(930000);
    expect(daemonRequestDeadline({ op: "ping" })).toBe(1500);
  });

  it("streams stdout/stderr and returns the exact remote exit code", async () => {
    const calls = { clients: 0, connects: 0, homes: 0, runs: 0 };
    const server = createDaemonServer({
      socketPath: "/tmp/sandbox-ctl-daemon-test.sock",
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
    });
    await server.listen();
    try {
      const result = await createDaemonClient({ socketPath: server.socketPath }).exec({
        sandboxId: "sbx-1", command: "printf test", cwd: "/home/test", timeoutMs: 1000,
      });
      expect(result).toMatchObject({ exitCode: 7, stdout: "out", stderr: "err" });
      expect(calls).toEqual({ clients: 1, connects: 1, homes: 1, runs: 1 });
      const second = await createDaemonClient({ socketPath: server.socketPath }).exec({ sandboxId: "sbx-1", command: "true" });
      expect(second.exitCode).toBe(7);
      expect(calls).toEqual({ clients: 1, connects: 1, homes: 1, runs: 2 });
    } finally { await server.close(); }
  });

  it("exposes the daemon-owned loopback proxy through ping/status", async () => {
    const server = createDaemonServer({ socketPath: "/tmp/sandbox-ctl-daemon-proxy-test.sock", proxyUrl: "http://127.0.0.1:43123" });
    await server.listen();
    try { await expect(createDaemonClient({ socketPath: server.socketPath }).ping()).resolves.toMatchObject({ ok: true, proxyUrl: "http://127.0.0.1:43123" }); }
    finally { await server.close(); }
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
