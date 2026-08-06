/**
 * E-GAOP TLS credential helpers for gRPC with mTLS support.
 *
 * Accepts certificates from:
 *   1. K8s cert-manager mounted secrets (/etc/egaop/certs/...)
 *   2. Vault PKI mounted secrets (/vault/secrets/...)
 *   3. Custom path via TLS_CERT_DIR env var
 *
 * TLS is enabled via TLS_ENABLED=true and encrypts all gRPC traffic.
 *
 * mTLS (mutual TLS / client-cert verification) is OFF by default and must be
 * explicitly requested with MTLS_ENABLED=true. This is a deliberate default:
 * @grpc/grpc-js v1.14.x cannot complete an HTTP/2 connection when the server
 * sets requestCert:true, even with a valid client certificate (verified
 * empirically against Node 24 — the client handshake finishes, the server
 * never acknowledges the HTTP/2 session, and the socket dies with a
 * "socket hang up" / bad-certificate alert). See docs/security.md. Until that
 * upstream bug is fixed, MTLS_ENABLED=true must be treated as experimental.
 *
 * TLS-only mode (the default) uses requestCert:false: the server presents its
 * certificate and clients verify it, but clients are not required to present
 * their own certificate.
 *
 * Supports two cert naming conventions:
 *   - Dev/self-signed: ca-cert.pem, server-cert.pem, server-key.pem,
 *     client-cert.pem, client-key.pem (see certs/gen-certs.sh)
 *   - cert-manager:    ca.crt, tls.crt, tls.key (standard Secret keys)
 */

import * as grpc from "@grpc/grpc-js";
import fs from "fs";
import path from "path";
import pino from "pino";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const CERT_DIR = process.env.TLS_CERT_DIR || "/etc/egaop/certs";
const TLS_ENABLED = process.env.TLS_ENABLED === "true";
const MTLS_ENABLED = TLS_ENABLED && process.env.MTLS_ENABLED === "true";

if (TLS_ENABLED) {
  logger.info({ mtls: MTLS_ENABLED }, "TLS enabled");
} else {
  logger.warn("TLS disabled — all gRPC traffic is in plaintext");
}

function readCertBuffer(dir: string, filename: string): Buffer {
  return fs.readFileSync(path.join(dir, filename));
}

function hasCertFile(dir: string, filename: string): boolean {
  try {
    fs.accessSync(path.join(dir, filename), fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function findCertFile(dir: string, variants: string[]): string | null {
  for (const v of variants) {
    if (hasCertFile(dir, v)) return v;
  }
  return null;
}

function readCertString(dir: string, filename: string): string {
  return fs.readFileSync(path.join(dir, filename), "utf8");
}

/** Standard cert-manager Secret keys (ca.crt / tls.crt / tls.key). */
function resolveServerFiles(dir: string): { ca: string; cert: string; key: string } {
  const ca = findCertFile(dir, ["ca.crt", "ca-cert.pem", "ca.pem"]);
  const cert = findCertFile(dir, ["tls.crt", "server-cert.pem", "server.crt", "cert.pem"]);
  const key = findCertFile(dir, ["tls.key", "server-key.pem", "server.key", "key.pem"]);
  return {
    ca: ca ?? "ca.crt",
    cert: cert ?? "tls.crt",
    key: key ?? "tls.key",
  };
}

function resolveClientFiles(dir: string): { ca: string; cert?: string; key?: string } {
  const ca = findCertFile(dir, ["ca.crt", "ca-cert.pem", "ca.pem"]);
  const cert = findCertFile(dir, ["tls.crt", "client.crt", "client-cert.pem"]);
  const key = findCertFile(dir, ["tls.key", "client.key", "client-key.pem"]);
  return {
    ca: ca ?? "ca.crt",
    cert: cert ?? undefined,
    key: key ?? undefined,
  };
}

/**
 * Creates mTLS server credentials (requestCert:true). Requires MTLS_ENABLED=true.
 * NOTE: blocked by upstream @grpc/grpc-js bug (see module header + docs/security.md).
 */
export function createMTLSServerCredentials(certDir?: string): grpc.ServerCredentials {
  const dir = certDir ?? CERT_DIR;
  const { ca, cert, key } = resolveServerFiles(dir);

  const caCert = readCertBuffer(dir, ca);
  const serverCert = readCertBuffer(dir, cert);
  const serverKey = readCertBuffer(dir, key);

  return grpc.ServerCredentials.createSsl(
    caCert,
    [{ cert_chain: serverCert, private_key: serverKey }],
    true
  );
}

export function createMTLSClientCredentials(certDir?: string): grpc.ChannelCredentials {
  const dir = certDir ?? CERT_DIR;
  const { ca, cert, key } = resolveClientFiles(dir);

  const caCert = readCertBuffer(dir, ca);

  if (cert && key) {
    const clientCert = readCertBuffer(dir, cert);
    const clientKey = readCertBuffer(dir, key);
    return grpc.credentials.createSsl(caCert, clientKey, clientCert);
  }

  return grpc.credentials.createSsl(caCert);
}

export function getServerCredentials(): grpc.ServerCredentials {
  if (!TLS_ENABLED) return grpc.ServerCredentials.createInsecure();
  if (MTLS_ENABLED) return createMTLSServerCredentials(CERT_DIR);

  // TLS-only mode (the default): server presents its cert, requestCert:false.
  const { ca, cert, key } = resolveServerFiles(CERT_DIR);
  const caCert = readCertBuffer(CERT_DIR, ca);
  const serverKey = readCertBuffer(CERT_DIR, key);
  const serverCert = readCertBuffer(CERT_DIR, cert);
  return grpc.ServerCredentials.createSsl(caCert, [{ cert_chain: serverCert, private_key: serverKey }], false);
}

export function getClientCredentials(): grpc.ChannelCredentials {
  if (!TLS_ENABLED) return grpc.credentials.createInsecure();
  if (MTLS_ENABLED) return createMTLSClientCredentials(CERT_DIR);

  // TLS-only mode (the default): client verifies the server cert; if client
  // certs are present they are offered but not required by the server.
  const { ca, cert, key } = resolveClientFiles(CERT_DIR);
  const caCert = readCertString(CERT_DIR, ca);
  if (cert && key) {
    const clientKey = readCertString(CERT_DIR, key);
    const clientCert = readCertString(CERT_DIR, cert);
    return grpc.credentials.createSsl(Buffer.from(caCert), Buffer.from(clientKey), Buffer.from(clientCert));
  }
  return grpc.credentials.createSsl(Buffer.from(caCert));
}

export function watchCertificateRotation(certDir: string, onReload: () => void): fs.FSWatcher {
  return fs.watch(certDir, (eventType, filename) => {
    if (filename === "tls.crt" || filename === "tls.key" || filename === "ca.crt") {
      logger.info({ filename }, "Certificate change detected");
      onReload();
    }
  });
}
