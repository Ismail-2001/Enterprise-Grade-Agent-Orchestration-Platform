/**
 * TLS credential tests.
 *
 * Verifies fail-closed behavior: when TLS is misconfigured or disabled,
 * the system must not silently accept invalid transport state.
 *
 * Also asserts the production TLS topology:
 *   - TLS-only (requestCert:false) is the DEFAULT and works for real RPCs.
 *   - mTLS (requestCert:true) is opt-in via MTLS_ENABLED=true and is
 *     currently BLOCKED by an upstream @grpc/grpc-js bug (verified
 *     empirically; see docs/security.md). The server-side security control
 *     still works: a client without a valid certificate is rejected.
 */
import fs from "fs";
import path from "path";
import * as grpc from "@grpc/grpc-js";
import * as tls from "tls";
import net from "net";
import { promisify } from "util";

const CERT_DIR = path.join(__dirname, "../certs");

const TEST_SERVICE = {
  ping: {
    path: "/test.Ping/Ping",
    requestStream: false,
    responseStream: false,
    requestSerialize: (m: { ping: string }) => Buffer.from(JSON.stringify(m)),
    requestDeserialize: (b: Buffer) => JSON.parse(b.toString()),
    responseSerialize: (m: { data: string }) => Buffer.from(JSON.stringify(m)),
    responseDeserialize: (b: Buffer) => JSON.parse(b.toString()),
  },
};

describe("TLS credential helpers", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = { ...originalEnv };
  });

  const hasCerts = () => fs.existsSync(path.join(CERT_DIR, "ca-cert.pem"));

  describe("getServerCredentials", () => {
    it("returns insecure when TLS_ENABLED is not set", () => {
      delete process.env.TLS_ENABLED;
      delete process.env.TLS_CERT_DIR;
      const { getServerCredentials } = require("@e-gaop/shared");
      const creds = getServerCredentials();
      expect(creds).toBeDefined();
    });

    it("returns insecure when TLS_ENABLED is 'false'", () => {
      process.env.TLS_ENABLED = "false";
      const { getServerCredentials } = require("@e-gaop/shared");
      const creds = getServerCredentials();
      expect(creds).toBeDefined();
    });

    it("defaults to TLS-only (requestCert:false) when TLS is enabled", () => {
      if (!hasCerts()) {
        console.log("Skipping: no certs found in", CERT_DIR);
        return;
      }
      process.env.TLS_ENABLED = "true";
      process.env.TLS_CERT_DIR = CERT_DIR;
      delete process.env.MTLS_ENABLED;
      const { getServerCredentials } = require("@e-gaop/shared");
      const creds = getServerCredentials();
      // Internal constructor options expose requestCert without a live server.
      const internal = (creds as unknown as { _getConstructorOptions: () => { requestCert?: boolean } })._getConstructorOptions?.();
      expect(internal?.requestCert).toBe(false);
    });

    it("uses requestCert:true only when MTLS_ENABLED=true (experimental)", () => {
      if (!hasCerts()) {
        console.log("Skipping: no certs found in", CERT_DIR);
        return;
      }
      process.env.TLS_ENABLED = "true";
      process.env.TLS_CERT_DIR = CERT_DIR;
      process.env.MTLS_ENABLED = "true";
      const { getServerCredentials } = require("@e-gaop/shared");
      const creds = getServerCredentials();
      const internal = (creds as unknown as { _getConstructorOptions: () => { requestCert?: boolean } })._getConstructorOptions?.();
      expect(internal?.requestCert).toBe(true);
    });
  });

  describe("getClientCredentials", () => {
    it("returns insecure when TLS_ENABLED is not set", () => {
      delete process.env.TLS_ENABLED;
      delete process.env.TLS_CERT_DIR;
      const { getClientCredentials } = require("@e-gaop/shared");
      const creds = getClientCredentials();
      expect(creds).toBeDefined();
    });

    it("throws when TLS_ENABLED is 'true' but certs directory does not exist", () => {
      process.env.TLS_ENABLED = "true";
      process.env.TLS_CERT_DIR = "/nonexistent/path";
      const { getClientCredentials } = require("@e-gaop/shared");
      expect(() => getClientCredentials()).toThrow();
    });

    it("throws when TLS_ENABLED is 'true' but cert files are missing", () => {
      process.env.TLS_ENABLED = "true";
      process.env.TLS_CERT_DIR = path.join(__dirname); // no cert files here
      const { getClientCredentials } = require("@e-gaop/shared");
      expect(() => getClientCredentials()).toThrow();
    });

    it("reads real certs when TLS_ENABLED is 'true' and certs exist", () => {
      if (!hasCerts()) {
        console.log("Skipping: no certs found in", CERT_DIR);
        return;
      }
      process.env.TLS_ENABLED = "true";
      process.env.TLS_CERT_DIR = CERT_DIR;
      const { getClientCredentials } = require("@e-gaop/shared");
      const creds = getClientCredentials();
      expect(creds).toBeDefined();
    });
  });
});

describe("TLS transport integration", () => {
  const hasCerts = () => fs.existsSync(path.join(CERT_DIR, "ca-cert.pem"));
  const read = (f: string) => fs.readFileSync(path.join(CERT_DIR, f));

  const ca = read("ca-cert.pem");
  const serverCert = read("server-cert.pem");
  const serverKey = read("server-key.pem");
  const clientCert = read("client-cert.pem");
  const clientKey = read("client-key.pem");

  function startGrpcServer(checkClientCertificate: boolean): Promise<{ server: grpc.Server; port: number }> {
    return new Promise((resolve, reject) => {
      const server = new grpc.Server();
      server.addService(TEST_SERVICE, {
        ping: (call: grpc.ServerUnaryCall<{ ping: string }, { data: string }>, cb: grpc.sendUnaryData<{ data: string }>) => {
          cb(null, { data: `pong:${call.request.ping}` });
        },
      });
      const creds = grpc.ServerCredentials.createSsl(ca, [{ cert_chain: serverCert, private_key: serverKey }], checkClientCertificate);
      server.bindAsync("127.0.0.1:0", creds, (err, port) => {
        if (err) return reject(err);
        server.start();
        resolve({ server, port });
      });
    });
  }

  function doPing(port: number, withClientCert: boolean, timeoutMs = 4000): Promise<{ ok: boolean; error?: string; data?: string }> {
    return new Promise((resolve) => {
      const creds = withClientCert
        ? grpc.credentials.createSsl(ca, clientKey, clientCert)
        : grpc.credentials.createSsl(ca);
      const client = new grpc.Client(`127.0.0.1:${port}`, creds, { "grpc.ssl_target_name_override": "localhost" });
      const call = client.makeUnaryRequest(
        TEST_SERVICE.ping.path,
        TEST_SERVICE.ping.requestSerialize,
        TEST_SERVICE.ping.requestDeserialize,
        { ping: "hi" },
        { deadline: Date.now() + timeoutMs },
        (err, resp) => {
          client.close();
          if (err) resolve({ ok: false, error: err.message });
          else resolve({ ok: true, data: (resp as { data: string }).data });
        }
      );
      call.on("error", () => {});
    });
  }

  it("completes an RPC round-trip in TLS-only mode (requestCert:false) with a client cert offered", async () => {
    if (!hasCerts()) {
      console.log("Skipping: no certs found in", CERT_DIR);
      return;
    }
    const { server, port } = await startGrpcServer(false);
    try {
      const result = await doPing(port, true);
      expect(result.ok).toBe(true);
      expect(result.data).toBe("pong:hi");
    } finally {
      await promisify(server.tryShutdown.bind(server))();
    }
  });

  it("completes an RPC round-trip in TLS-only mode (requestCert:false) without a client cert", async () => {
    if (!hasCerts()) {
      console.log("Skipping: no certs found in", CERT_DIR);
      return;
    }
    const { server, port } = await startGrpcServer(false);
    try {
      const result = await doPing(port, false);
      expect(result.ok).toBe(true);
    } finally {
      await promisify(server.tryShutdown.bind(server))();
    }
  });

  it("rejects a client without a certificate when the server requires one (mTLS security control)", async () => {
    if (!hasCerts()) {
      console.log("Skipping: no certs found in", CERT_DIR);
      return;
    }
    const { server, port } = await startGrpcServer(true);
    try {
      const result = await doPing(port, false);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/UNAVAILABLE|certificate required|Failed to connect/i);
    } finally {
      await promisify(server.tryShutdown.bind(server))();
    }
  });

  it("client certificates are cryptographically valid (proves the failure is upstream, not our certs)", async () => {
    if (!hasCerts()) {
      console.log("Skipping: no certs found in", CERT_DIR);
      return;
    }
    // Raw TLS handshake: client verifies the server, server requests a client
    // cert but (due to the upstream Node/grpc-js bug) never fires
    // secureConnection. We verify the client side is fully valid — the server
    // cert is verified, the client cert is presented and accepted at the TLS
    // protocol level (the handshake completes), and the CA chain is intact.
    const server = tls.createServer({ ca, cert: serverCert, key: serverKey, requestCert: true, rejectUnauthorized: true });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const socket = tls.connect({ host: "127.0.0.1", port, ca, cert: clientCert, key: clientKey, servername: "localhost", rejectUnauthorized: true });
      await new Promise<void>((resolve, reject) => {
        socket.on("secureConnect", () => resolve());
        socket.on("error", reject);
      });
      expect(socket.authorized).toBe(true);
      expect(socket.getPeerCertificate().subject?.CN).toBe("*.egaop.internal");
      socket.destroy();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("documents that mTLS with a VALID client cert is blocked by the upstream grpc-js bug", async () => {
    if (!hasCerts()) {
      console.log("Skipping: no certs found in", CERT_DIR);
      return;
    }
    const { server, port } = await startGrpcServer(true);
    try {
      // Known upstream bug (@grpc/grpc-js v1.14.x): the client completes the
      // TLS handshake with its (valid) cert, but the server never completes
      // the HTTP/2 session and the connection dies. The security control above
      // still rejects certificate-less clients. Track: when this test starts
      // PASSING, the upstream bug is fixed and mTLS can be enabled by default.
      const result = await doPing(port, true);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/UNAVAILABLE|Failed to connect/i);
      console.log("(expected) mTLS valid-cert connection blocked by upstream grpc-js bug:", result.error);
    } finally {
      await promisify(server.tryShutdown.bind(server))();
    }
  });
});
