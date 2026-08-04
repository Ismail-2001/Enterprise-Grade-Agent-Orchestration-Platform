import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

// ─── Custom metrics ───────────────────────────────────────────────────────
const errorRate = new Rate("errors");
const healthDuration = new Trend("health_duration_ms");
const authDuration = new Trend("auth_duration_ms");
const agentCrudDuration = new Trend("agent_crud_duration_ms");
const namespaceDuration = new Trend("namespace_duration_ms");

// ─── SLO thresholds (enforced by CI) ──────────────────────────────────────
export const options = {
  vus: 2,
  iterations: 10,
  thresholds: {
    http_req_duration:      ["p(95)<500", "max<3000"],
    http_req_failed:        ["rate<0.01"],
    health_duration_ms:     ["p(95)<200"],
    auth_duration_ms:       ["p(95)<1000"],
    agent_crud_duration_ms: ["p(95)<1500"],
    namespace_duration_ms:  ["p(95)<1500"],
    errors:                 ["rate<0.01"],
  },
};

// ─── Configuration ────────────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || "http://localhost:3001";
const CLUSTER_ID = __ENV.K6_CLUSTER_ID || "default";
const TEST_USER = {
  email: `k6-ci-${CLUSTER_ID}@egaop.io`,
  password: "CiLoadTest-2026",
  name: `k6-ci-load-${CLUSTER_ID}`,
};

const JSON_HEADERS = { "Content-Type": "application/json" };

function bearer(token) {
  return { ...JSON_HEADERS, Authorization: `Bearer ${token}` };
}

// ─── Setup: run once before any VU ────────────────────────────────────────
export function setup() {
  // Wait for the API server to accept traffic before registering.
  for (let attempt = 0; attempt < 30; attempt++) {
    const res = http.get(`${BASE_URL}/health`);
    if (res.status === 200) break;
    sleep(1);
  }

  // Register once; a 409 means the user already exists, which is fine.
  http.post(`${BASE_URL}/api/auth/register`, JSON.stringify(TEST_USER), {
    headers: JSON_HEADERS,
    tags: { name: "register" },
  });

  let token = null;
  for (let attempt = 0; attempt < 5 && !token; attempt++) {
    const res = http.post(
      `${BASE_URL}/api/auth/login`,
      JSON.stringify({ email: TEST_USER.email, password: TEST_USER.password }),
      { headers: JSON_HEADERS, tags: { name: "login" } }
    );
    if (res.status === 200 || res.status === 201) {
      const body = res.json();
      token = body?.data?.token || body?.token;
    } else {
      sleep(1);
    }
  }
  return { token };
}

// ─── Default: control-plane REST smoke under a small load ─────────────────
export default function (data) {
  const token = data?.token;

  const t0 = Date.now();
  const health = http.get(`${BASE_URL}/health`, { tags: { name: "health" } });
  healthDuration.add(Date.now() - t0);
  check(health, { "health returns 200": (r) => r.status === 200 });

  if (!token) {
    errorRate.add(1);
    return;
  }

  const t1 = Date.now();
  const namespaces = http.get(`${BASE_URL}/api/namespaces?limit=50`, {
    headers: bearer(token),
    tags: { name: "list_namespaces" },
  });
  namespaceDuration.add(Date.now() - t1);
  check(namespaces, { "namespaces listed": (r) => r.status === 200 });

  const t2 = Date.now();
  const create = http.post(
    `${BASE_URL}/api/agents`,
    JSON.stringify({
      name: `ci-agent-${__VU}-${__ITER}`,
      namespace: "default",
      spec: {
        description: `CI load test agent ${__VU}-${__ITER}`,
        model: "gpt-4o-mini",
        prompt: "You are a helpful assistant.",
        tools: ["file_read", "file_write"],
        maxIterations: 3,
        timeout: "30s",
      },
    }),
    { headers: bearer(token), tags: { name: "create_agent" } }
  );
  check(create, { "agent created": (r) => r.status === 201 });

  const list = http.get(`${BASE_URL}/api/agents?namespace=default&limit=50`, {
    headers: bearer(token),
    tags: { name: "list_agents" },
  });
  agentCrudDuration.add(Date.now() - t2);
  check(list, { "agents listed": (r) => r.status === 200 });

  errorRate.add(0);
  sleep(0.2);
}
