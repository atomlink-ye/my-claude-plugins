import http from "node:http";
import https from "node:https";
import net from "node:net";

/**
 * Start the optional Cube direct-dial proxy. CONNECT payloads are opaque: the
 * proxy never inspects or logs headers, and the TLS client retains the original
 * target hostname as SNI while the TCP leg dials the fixed Cube proxy node.
 */
export async function createCubeDirectProxy({ nodeIp, httpsPort = 443, apiUrl, apiNodeIp = nodeIp, sandboxDomain = "cube.app", host = "127.0.0.1", port = 0 } = {}) {
  if (!nodeIp) throw new Error("CUBE_PROXY_NODE_IP is required for direct-dial proxy mode");
  const targetPort = Number(httpsPort) || 443;
  const apiTarget = apiUrl ? (() => { try { const u = new URL(apiUrl); return `${u.hostname}:${u.port || (u.protocol === "https:" ? 443 : 80)}`; } catch { return null; } })() : null;
  const allowedConnect = (authority) => {
    const [hostname, portText] = String(authority).split(":");
    const target = `${hostname}:${portText || 443}`;
    return target === apiTarget || ((portText || "443") === "443" && (hostname === sandboxDomain || hostname.endsWith(`.${sandboxDomain}`)));
  };
  const server = http.createServer((request, response) => {
    let target;
    try { target = new URL(request.url); } catch { response.writeHead(400); response.end("invalid proxy target"); return; }
    const targetAuthority = `${target.hostname}:${target.port || (target.protocol === "https:" ? 443 : 80)}`;
    if (targetAuthority !== apiTarget) { response.writeHead(403); response.end(); return; }
    const transport = target.protocol === "https:" ? https : http;
    const headers = { ...request.headers }; delete headers["proxy-authorization"]; delete headers["Proxy-Authorization"];
    // Absolute-form requests still carry the logical API authority in Host.
    // Dial the fixed API node IP while retaining that authority (and TLS SNI)
    // so virtual-host routing and certificate validation remain correct.
    const isApi = targetAuthority === apiTarget;
    const upstream = transport.request({
      hostname: isApi ? apiNodeIp : target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      servername: target.hostname,
      path: `${target.pathname}${target.search}`,
      method: request.method,
      headers: { ...headers, host: headers.host ?? target.host },
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.pipe(upstream);
  });
  const connectSockets = new Set();
  const trackConnectSocket = (socket) => {
    connectSockets.add(socket);
    // A peer can report ECONNRESET while the paired leg is being torn down;
    // shutdown must not turn that expected transport race into an uncaught
    // exception in the daemon process.
    socket.on("error", () => {});
    socket.once("close", () => connectSockets.delete(socket));
    return socket;
  };
  server.on("connect", (request, clientSocket, head) => {
    trackConnectSocket(clientSocket);
    if (!allowedConnect(request.url)) { clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); clientSocket.destroy(); return; }
    const isApi = `${String(request.url).split(":")[0]}:${String(request.url).split(":")[1] || 443}` === apiTarget;
    const dialIp = isApi ? apiNodeIp : nodeIp;
    const dialPort = isApi ? Number(apiTarget.split(":")[1]) : targetPort;
    const upstream = trackConnectSocket(net.connect(dialPort, dialIp, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket); clientSocket.pipe(upstream);
    }));
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  const address = server.address();
  const actualPort = typeof address === "object" ? address.port : port;
  return {
    server,
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    close: () => new Promise((resolve) => {
      const pendingSockets = [...connectSockets];
      for (const socket of pendingSockets) {
        try { socket.end(); } catch {}
        // Destroy after the graceful FIN has had a chance to flush.  This
        // still guarantees closure for a stalled peer without generating a
        // reset on the upstream test/server socket.
        setTimeout(() => socket.destroy(), 25);
      }
      const finish = () => { for (const socket of pendingSockets) socket.destroy(); resolve(); };
      if (!server.listening) { finish(); return; }
      server.close(finish);
    }),
  };
}

export async function ensureCubeProxy(env = process.env) {
  const nodeIp = env.CUBE_PROXY_NODE_IP;
  if (!nodeIp) return null;
  return createCubeDirectProxy({ nodeIp, httpsPort: env.CUBE_PROXY_PORT_HTTPS || 443, apiNodeIp: env.CUBE_API_NODE_IP || nodeIp, apiUrl: env.CUBE_API_URL || env.E2B_API_URL, sandboxDomain: env.CUBE_API_SANDBOX_DOMAIN || "cube.app" });
}
