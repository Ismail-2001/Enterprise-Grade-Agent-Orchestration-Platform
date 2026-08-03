import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import crypto from "crypto";
import pino from "pino";
import { hashPassword, comparePassword, signJWT, verifyJWT, createAuditEntry, type JWTClaims } from "@e-gaop/shared";
import {
  getUserRepository,
  ensureAdminUser,
  type UserRow,
} from "./repository";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const _jwtSecret = process.env.JWT_SECRET;
if (!_jwtSecret || _jwtSecret.length < 32) {
  throw new Error(
    "FATAL: JWT_SECRET must be set and >= 32 characters. " +
    "Generate with: openssl rand -hex 32"
  );
}
const JWT_SECRET: string = _jwtSecret;
const JWT_EXPIRES_SEC = 86400; // 24 hours

// ── Auth middleware ──────────────────────────────────────────────────────────

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  let token: string | null = null;

  // Check Authorization header first
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  }

  // Fallback to cookie
  if (!token) {
    const cookies = request.cookies;
    token = cookies?.egaop_token ?? null;
  }

  if (!token) {
    reply.code(401).send({ error: { message: "Missing or invalid authorization header", code: "UNAUTHORIZED" } });
    return;
  }

  const claims = verifyJWT(token, JWT_SECRET);
  if (!claims) {
    reply.code(401).send({ error: { message: "Invalid or expired token", code: "UNAUTHORIZED" } });
    return;
  }

  // Attach claims to request for downstream use
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (request as any).user = claims;
}

// ── Auth routes ─────────────────────────────────────────────────────────────

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  const repo = getUserRepository();

  // Ensure admin user exists on first boot
  if (process.env.NODE_ENV !== "test") {
    const adminPassword = await ensureAdminUser(repo);
    if (adminPassword) {
      logger.warn({ username: "admin" }, "First boot: admin account created. Check /run/secrets/ for initial password.");
    }
  }

  // POST /api/auth/register
  fastify.post("/api/auth/register", {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: "10 minutes",
        keyGenerator: (request: FastifyRequest) => request.ip ?? "unknown",
      },
    },
  }, async (request, reply) => {
    const body = request.body as { name?: string; email?: string; password?: string };

    if (!body?.email || !body?.password || !body?.name) {
      reply.code(400).send({ error: { message: "Name, email, and password are required", code: "VALIDATION_ERROR" } });
      return;
    }

    const email = body.email.toLowerCase().trim();
    const password = body.password;

    // Validate password strength
    if (password.length < 12) {
      reply.code(400).send({ error: { message: "Password must be at least 12 characters", code: "VALIDATION_ERROR" } });
      return;
    }

    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
      reply.code(400).send({ error: { message: "Password must contain uppercase, lowercase, and numbers", code: "VALIDATION_ERROR" } });
      return;
    }

    // Check if user already exists
    const existing = await repo.findByEmail(email);
    if (existing) {
      reply.code(409).send({ error: { message: "An account with this email already exists", code: "CONFLICT" } });
      return;
    }

    const user = await repo.create({
      email,
      password,
      name: body.name.trim(),
      role: "developer",
      namespaceAccess: ["default"],
    });

    try {
      createAuditEntry(
        "auth.login",
        "info",
        { type: "user", id: user.id, authMethod: "jwt" },
        { name: "register", result: "allowed" },
        { type: "user", id: user.id },
        { ipAddress: request.ip, userAgent: request.headers["user-agent"] },
      );
    } catch { /* audit failure is non-fatal */ }

    // Generate JWT
    const claims: Omit<JWTClaims, "iat" | "exp"> = {
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      namespace_access: user.namespace_access,
    };
    const token = signJWT(claims, JWT_SECRET, JWT_EXPIRES_SEC);

    return {
      data: {
        user: { id: user.id, email, name: user.name, role: user.role },
        token,
      },
      meta: { traceId: crypto.randomUUID(), timestamp: new Date().toISOString() },
    };
  });

  // POST /api/auth/login
  fastify.post("/api/auth/login", {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: "1 minute",
        keyGenerator: (request: FastifyRequest) => request.ip ?? "unknown",
      },
    },
  }, async (request, reply) => {
    const body = request.body as { email?: string; password?: string };

    if (!body?.email || !body?.password) {
      reply.code(400).send({ error: { message: "Email and password are required", code: "VALIDATION_ERROR" } });
      return;
    }

    const email = body.email.toLowerCase().trim();
    const user = await repo.findByEmail(email);

    if (!user) {
      // Always return same error for invalid email/password to prevent enumeration
      try {
        createAuditEntry(
          "auth.failed_login",
          "warn",
          { type: "user", id: email, authMethod: "jwt" },
          { name: "login", result: "denied", reason: "user not found" },
          { type: "user", id: email },
          { ipAddress: request.ip, userAgent: request.headers["user-agent"] },
        );
      } catch { /* audit failure is non-fatal */ }
      reply.code(401).send({ error: { message: "Invalid email or password", code: "INVALID_CREDENTIALS" } });
      return;
    }

    if (!user.is_active) {
      try {
        createAuditEntry(
          "auth.failed_login",
          "warn",
          { type: "user", id: user.id, authMethod: "jwt" },
          { name: "login", result: "denied", reason: "account disabled" },
          { type: "user", id: user.id },
          { ipAddress: request.ip, userAgent: request.headers["user-agent"] },
        );
      } catch { /* audit failure is non-fatal */ }
      reply.code(403).send({ error: { message: "Account is deactivated", code: "ACCOUNT_DISABLED" } });
      return;
    }

    // Check lockout
    const lockStatus = await repo.isLocked(email);
    if (lockStatus.locked) {
      reply.code(429).send({
        error: {
          message: `Account is locked. Try again in ${lockStatus.remainingMinutes} minute${lockStatus.remainingMinutes > 1 ? "s" : ""}`,
          code: "ACCOUNT_LOCKED",
        },
      });
      return;
    }

    const valid = await comparePassword(body.password, user.password_hash);

    if (!valid) {
      const { locked } = await repo.incrementFailedLogin(email);

      try {
        createAuditEntry(
          "auth.failed_login",
          "warn",
          { type: "user", id: user.id, authMethod: "jwt" },
          { name: "login", result: "denied", reason: "invalid password" },
          { type: "user", id: user.id },
          { ipAddress: request.ip, userAgent: request.headers["user-agent"] },
        );
      } catch { /* audit failure is non-fatal */ }

      reply.code(401).send({ error: { message: "Invalid email or password", code: "INVALID_CREDENTIALS" } });
      return;
    }

    // Reset failed attempts on success
    await repo.resetFailedLogin(email);

    try {
      createAuditEntry(
        "auth.login",
        "info",
        { type: "user", id: user.id, authMethod: "jwt" },
        { name: "login", result: "allowed" },
        { type: "user", id: user.id },
        { ipAddress: request.ip, userAgent: request.headers["user-agent"] },
      );
    } catch { /* audit failure is non-fatal */ }

    // Generate JWT
    const claims: Omit<JWTClaims, "iat" | "exp"> = {
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      namespace_access: user.namespace_access,
    };
    const token = signJWT(claims, JWT_SECRET, JWT_EXPIRES_SEC);

    return {
      data: {
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
        token,
        must_change_password: user.must_change_password,
      },
      meta: { traceId: crypto.randomUUID(), timestamp: new Date().toISOString() },
    };
  });

  // POST /api/auth/change-password (protected)
  fastify.post("/api/auth/change-password", {
    preHandler: [authenticate],
    config: {
      rateLimit: {
        max: 5,
        timeWindow: "15 minutes",
        keyGenerator: (request: FastifyRequest) => request.ip ?? "unknown",
      },
    },
  }, async (request, reply) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const claims = (request as any).user as JWTClaims;
    const body = request.body as { current_password?: string; new_password?: string };

    if (!body?.current_password || !body?.new_password) {
      reply.code(400).send({ error: { message: "Current and new passwords are required", code: "VALIDATION_ERROR" } });
      return;
    }

    const user = await repo.findByEmail(claims.email);
    if (!user) {
      reply.code(404).send({ error: { message: "User not found", code: "NOT_FOUND" } });
      return;
    }

    const valid = await comparePassword(body.current_password, user.password_hash);
    if (!valid) {
      reply.code(401).send({ error: { message: "Current password is incorrect", code: "INVALID_CREDENTIALS" } });
      return;
    }

    const newPassword = body.new_password;
    if (newPassword.length < 12) {
      reply.code(400).send({ error: { message: "Password must be at least 12 characters", code: "VALIDATION_ERROR" } });
      return;
    }
    if (!/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      reply.code(400).send({ error: { message: "Password must contain uppercase, lowercase, and numbers", code: "VALIDATION_ERROR" } });
      return;
    }

    // Update password and clear must_change_password
    const newHash = await hashPassword(newPassword);
    const pool = (repo as unknown as { pool: import("pg").Pool }).pool;
    await pool.query(
      `UPDATE users SET password_hash = $1, must_change_password = false, updated_at = NOW()
       WHERE lower(email) = lower($2) AND deleted_at IS NULL`,
      [newHash, claims.email]
    );

    try {
      createAuditEntry(
        "auth.login",
        "info",
        { type: "user", id: claims.sub, authMethod: "jwt" },
        { name: "change-password", result: "allowed" },
        { type: "user", id: claims.sub },
        { ipAddress: request.ip, userAgent: request.headers["user-agent"] },
      );
    } catch { /* audit failure is non-fatal */ }

    return {
      data: { message: "Password changed successfully" },
      meta: { traceId: crypto.randomUUID(), timestamp: new Date().toISOString() },
    };
  });

  // GET /api/auth/me (protected)
  fastify.get("/api/auth/me", { preHandler: [authenticate] }, async (request) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const claims = (request as any).user as JWTClaims;

    // Fetch fresh must_change_password from DB
    const user = await repo.findByEmail(claims.email);

    return {
      data: {
        id: claims.sub,
        email: claims.email,
        name: claims.name,
        role: claims.role,
        namespace_access: claims.namespace_access,
        must_change_password: user?.must_change_password ?? false,
      },
      meta: { traceId: crypto.randomUUID(), timestamp: new Date().toISOString() },
    };
  });

  // POST /api/auth/logout (protected)
  fastify.post("/api/auth/logout", { preHandler: [authenticate] }, async (request) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const claims = (request as any).user as JWTClaims;

    try {
      createAuditEntry(
        "auth.logout",
        "info",
        { type: "user", id: claims.sub, authMethod: "jwt" },
        { name: "logout", result: "allowed" },
        { type: "user", id: claims.sub },
        { ipAddress: request.ip, userAgent: request.headers["user-agent"] },
      );
    } catch { /* audit failure is non-fatal */ }

    // In a real implementation, invalidate the token/session
    return {
      data: { message: "Logged out successfully" },
      meta: { traceId: crypto.randomUUID(), timestamp: new Date().toISOString() },
    };
  });
}
