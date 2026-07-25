/**
 * E-GAOP TLS credential helpers for gRPC with mTLS support.
 *
 * Accepts certificates from:
 *   1. K8s cert-manager mounted secrets (/etc/egaop/certs/...)
 *   2. Vault PKI mounted secrets (/vault/secrets/...)
 *   3. Custom path via TLS_CERT_DIR env var
 *
 * mTLS is enabled by default when TLS is active and cert files exist.
 * requestCert: true — reject connections without valid client cert.
 */

import * as grpc from "@grpc/grpc-js";
import fs from "fs";
import path from "path";
import pino from "pino";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const CERT_DIR = process.env.TLS_CERT_DIR || "/etc/egaop/certs";
const TLS_ENABLED = process.env.TLS_ENABLED === "true";
const MTLS_ENABLED = TLS_ENABLED && (process.env.MTLS_ENABLED !== "false");

if (TLS_ENABLED) {
  logger.info({ mtls: MTLS_ENABLED }, "TLS enabled");
} else {
  logger.warn("TLS disabled — all gRPC traffic is in plaintext");
}

function readCertBuffer(filename: string): Buffer {
  return fs.readFileSync(path.join(CERT_DIR, filename));
}

function hasCertFile(filename: string): boolean {
  try {
    fs.accessSync(path.join(CERT_DIR, filename), fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function findCertFile(variants: string[]): string | null {
  for (const v of variants) {
    if (hasCertFile(v)) return v;
  }
  return null;
}

export function createMTLSServerCredentials(certDir?: string): grpc.ServerCredentials {
  const dir = certDir ?? CERT_DIR;

  const caCert = readCertBuffer(path.join(dir, "ca.crt"));
  const serverCert = readCertBuffer(path.join(dir, "tls.crt"));
  const serverKey = readCertBuffer(path.join(dir, "tls.key"));

  return grpc.ServerCredentials.createSsl(
    caCert,
    [{ cert_chain: serverCert, private_key: serverKey }],
    true
  );
}

export function createMTLSClientCredentials(certDir?: string): grpc.ChannelCredentials {
  const dir = certDir ?? CERT_DIR;

  const caCert = readCertBuffer(path.join(dir, "ca.crt"));
  const clientCertFile = findCertFile(["tls.crt", "client.crt", "client-cert.pem"]);
  const clientKeyFile = findCertFile(["tls.key", "client.key", "client-key.pem"]);

  if (clientCertFile && clientKeyFile) {
    const clientCert = readCertBuffer(path.join(dir, clientCertFile));
    const clientKey = readCertBuffer(path.join(dir, clientKeyFile));
    return grpc.credentials.createSsl(caCert, clientKey, clientCert);
  }

  return grpc.credentials.createSsl(caCert);
}

export function getServerCredentials(): grpc.ServerCredentials {
  if (!TLS_ENABLED) return grpc.ServerCredentials.createInsecure();
  if (MTLS_ENABLED) return createMTLSServerCredentials(CERT_DIR);
  const caCert = readCertBuffer("ca-cert.pem");
  const serverKey = readCertBuffer("server-key.pem");
  const serverCert = readCertBuffer("server-cert.pem");
  return grpc.ServerCredentials.createSsl(caCert, [{ cert_chain: serverCert, private_key: serverKey }], false);
}

export function getClientCredentials(): grpc.ChannelCredentials {
  if (!TLS_ENABLED) return grpc.credentials.createInsecure();
  if (MTLS_ENABLED) return createMTLSClientCredentials(CERT_DIR);
  const caCert = readCertString("ca-cert.pem");
  const clientKey = readCertString("client-key.pem");
  const clientCert = readCertString("client-cert.pem");
  return grpc.credentials.createSsl(Buffer.from(caCert), Buffer.from(clientKey), Buffer.from(clientCert));
}

function readCertString(filename: string): string {
  return fs.readFileSync(path.join(CERT_DIR, filename), "utf8");
}

export function watchCertificateRotation(certDir: string, onReload: () => void): fs.FSWatcher {
  return fs.watch(certDir, (eventType, filename) => {
    if (filename === "tls.crt" || filename === "tls.key" || filename === "ca.crt") {
      logger.info({ filename }, "Certificate change detected");
      onReload();
    }
  });
}
