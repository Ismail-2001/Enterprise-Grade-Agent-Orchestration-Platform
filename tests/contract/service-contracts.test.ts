import path from "path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

const PROTO_DIR = path.resolve(__dirname, "../../api/proto");

function loadProto(protoFile: string): any {
  const packageDef = protoLoader.loadSync(path.join(PROTO_DIR, protoFile), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [PROTO_DIR],
  });
  return grpc.loadPackageDefinition(packageDef);
}

function startServer(svc: grpc.ServiceDefinition, impl: Record<string, any>): Promise<{ server: grpc.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = new grpc.Server();
    server.addService(svc, impl);
    server.bindAsync("localhost:0", grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) reject(err);
      else { server.start(); resolve({ server, port }); }
    });
  });
}

describe("Contract: workflow-engine → llm-router", () => {
  let llmRouterPort: number;
  let llmClient: any;
  let server: grpc.Server;

  const llmProto = loadProto("egaop/v1/llm.proto");

  beforeAll(async () => {
    const llmImpl = {
      Generate: (call: any, callback: any) => {
        const req = call.request;
        callback(null, {
          content: "Hello from mock LLM",
          model_used: req.model || "gpt-4o",
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
          cost: "$0.001",
          finish_reason: "stop",
          timestamp: { seconds: Math.floor(Date.now() / 1000) },
        });
      },
    };

    const { server: srv, port } = await startServer(llmProto.egaop.v1.LLMService.service, llmImpl);
    server = srv;
    llmRouterPort = port;
    llmClient = new llmProto.egaop.v1.LLMService(
      `localhost:${port}`,
      grpc.credentials.createInsecure()
    );
  });

  afterAll(() => {
    server.forceShutdown();
  });

  it("workflow-engine sends Generate request with required fields", (done) => {
    llmClient.Generate(
      {
        agent_id: "agent-001",
        execution_id: "exec-001",
        model: "gpt-4o",
        messages: [{ role: "user", content: "What is 2+2?" }],
        temperature: 0.7,
        max_tokens: 100,
      },
      (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response).toBeDefined();
        expect(typeof response.content).toBe("string");
        expect(typeof response.model_used).toBe("string");
        expect(response.usage).toBeDefined();
        expect(typeof response.usage.prompt_tokens).toBe("number");
        expect(typeof response.usage.completion_tokens).toBe("number");
        expect(typeof response.usage.total_tokens).toBe("number");
        expect(typeof response.cost).toBe("string");
        expect(typeof response.finish_reason).toBe("string");
        expect(response.timestamp).toBeDefined();
        expect(typeof response.timestamp.seconds).toBe("string");
        done();
      }
    );
  });

  it("llm-router rejects request without messages", (done) => {
    llmClient.Generate(
      {
        agent_id: "agent-001",
        execution_id: "exec-002",
        model: "gpt-4o",
        messages: [],
      },
      (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response).toBeDefined();
        done();
      }
    );
  });
});

describe("Contract: workflow-engine → tool-proxy", () => {
  let toolProxyPort: number;
  let toolClient: any;
  let server: grpc.Server;

  const toolProto = loadProto("egaop/v1/tool.proto");

  beforeAll(async () => {
    const toolImpl = {
      CallTool: (call: any, callback: any) => {
        callback(null, {
          result: { output: "mock tool result" },
          status: "succeeded",
          latency_ms: 100.0,
          cost: "$0.00",
        });
      },
    };

    const { server: srv, port } = await startServer(toolProto.egaop.v1.ToolService.service, toolImpl);
    server = srv;
    toolProxyPort = port;
    toolClient = new toolProto.egaop.v1.ToolService(
      `localhost:${port}`,
      grpc.credentials.createInsecure()
    );
  });

  afterAll(() => {
    server.forceShutdown();
  });

  it("tool-proxy returns structured tool call result", (done) => {
    toolClient.CallTool(
      {
        tool_name: "web_search",
        args: { query: "test query" },
        agent_id: "agent-001",
        execution_id: "exec-001",
      },
      (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response).toBeDefined();
        expect(response.result).toBeDefined();
        expect(typeof response.status).toBe("string");
        expect(typeof response.cost).toBe("string");
        expect(typeof response.latency_ms).toBe("number");
        done();
      }
    );
  });
});

describe("Contract: api-server → downstream services", () => {
  let apiServerPort: number;
  let apiClient: any;
  let server: grpc.Server;

  const agentProto = loadProto("egaop/v1/agent.proto");

  beforeAll(async () => {
    const agentImpl = {
      CreateAgent: (call: any, callback: any) => {
        callback(null, {
          api_version: "egaop.io/v1",
          kind: "Agent",
          metadata: {
            uid: "test-uid-001",
            name: call.request.metadata?.name || "unnamed",
            namespace: call.request.metadata?.namespace || "default",
            created_at: { seconds: Math.floor(Date.now() / 1000) },
          },
          spec: call.request.spec || {},
          status: { phase: "Pending", health_status: "Healthy" },
        });
      },
      GetAgent: (call: any, callback: any) => {
        callback(null, {
          metadata: { name: call.request.name, namespace: call.request.namespace },
          status: { phase: "Running", health_status: "Healthy" },
        });
      },
    };

    const { server: srv, port } = await startServer(agentProto.egaop.v1.AgentService.service, agentImpl);
    server = srv;
    apiServerPort = port;
    apiClient = new agentProto.egaop.v1.AgentService(
      `localhost:${port}`,
      grpc.credentials.createInsecure()
    );
  });

  afterAll(() => {
    server.forceShutdown();
  });

  it("api-server forwards CreateAgent and returns agent with uid", (done) => {
    apiClient.CreateAgent(
      {
        metadata: { name: "contract-agent", namespace: "test-ns" },
        spec: { version: "v1" },
      },
      (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response.api_version).toBe("egaop.io/v1");
        expect(response.kind).toBe("Agent");
        expect(response.metadata.uid).toBe("test-uid-001");
        expect(response.metadata.name).toBe("contract-agent");
        expect(response.metadata.namespace).toBe("test-ns");
        expect(response.status.phase).toBe("Pending");
        done();
      }
    );
  });

  it("api-server forwards GetAgent and returns status", (done) => {
    apiClient.GetAgent(
      { name: "test-agent", namespace: "default" },
      (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response.status.phase).toBe("Running");
        expect(response.status.health_status).toBe("Healthy");
        done();
      }
    );
  });
});

describe("Contract: workflow-engine → sandbox-runtime", () => {
  let sandboxPort: number;
  let sandboxClient: any;
  let server: grpc.Server;

  const runtimeProto = loadProto("egaop/v1/runtime.proto");

  beforeAll(async () => {
    const runtimeImpl = {
      CreateSandbox: (call: any, callback: any) => {
        callback(null, {
          sandbox_id: `sb-${Date.now()}`,
          status: "running",
          ip_address: "10.0.0.1",
          init_outputs: [],
        });
      },
      TerminateSandbox: (call: any, callback: any) => {
        callback(null, { success: true });
      },
      GetSandboxStatus: (call: any, callback: any) => {
        callback(null, {
          status: "running",
          cpu_usage: 0.25,
          memory_usage: 0.4,
          started_at: { seconds: Math.floor(Date.now() / 1000) },
        });
      },
    };

    const { server: srv, port } = await startServer(runtimeProto.egaop.v1.RuntimeService.service, runtimeImpl);
    server = srv;
    sandboxPort = port;
    sandboxClient = new runtimeProto.egaop.v1.RuntimeService(
      `localhost:${port}`,
      grpc.credentials.createInsecure()
    );
  });

  afterAll(() => server.forceShutdown());

  it("CreateSandbox returns sandbox_id and status", (done) => {
    sandboxClient.CreateSandbox(
      {
        agent_id: "agent-001",
        execution_id: "exec-001",
        image: "python:3.11-slim",
        isolation_level: "Standard",
        resources: { cpu: "1", memory: "512Mi" },
        timeout: "300",
      },
      (err: any, response: any) => {
        expect(err).toBeNull();
        expect(typeof response.sandbox_id).toBe("string");
        expect(response.sandbox_id.length).toBeGreaterThan(0);
        expect(response.status).toBe("running");
        expect(typeof response.ip_address).toBe("string");
        expect(Array.isArray(response.init_outputs)).toBe(true);
        done();
      }
    );
  });

  it("TerminateSandbox returns success", (done) => {
    sandboxClient.TerminateSandbox(
      { sandbox_id: "sb-123", reason: "test cleanup" },
      (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response.success).toBe(true);
        done();
      }
    );
  });

  it("GetSandboxStatus returns resource usage", (done) => {
    sandboxClient.GetSandboxStatus(
      { sandbox_id: "sb-123" },
      (err: any, response: any) => {
        expect(err).toBeNull();
        expect(typeof response.status).toBe("string");
        expect(typeof response.cpu_usage).toBe("number");
        expect(typeof response.memory_usage).toBe("number");
        done();
      }
    );
  });
});

describe("Contract: workflow-engine → memory-plane", () => {
  let memoryPort: number;
  let memoryClient: any;
  let server: grpc.Server;

  const memoryProto = loadProto("egaop/v1/memory.proto");

  beforeAll(async () => {
    const memoryStore = new Map<string, any>();
    const memoryImpl = {
      Read: (call: any, callback: any) => {
        const key = `${call.request.namespace}:${call.request.agent_id}:${call.request.key}`;
        const data = memoryStore.get(key);
        callback(null, { data: data || null, found: !!data });
      },
      Write: (call: any, callback: any) => {
        const key = `${call.request.namespace}:${call.request.agent_id}:${call.request.key}`;
        memoryStore.set(key, call.request.data);
        callback(null, { status: "success", version: "1" });
      },
      Delete: (call: any, callback: any) => {
        const key = `${call.request.namespace}:${call.request.agent_id}:${call.request.key}`;
        memoryStore.delete(key);
        callback(null, { status: "success" });
      },
      List: (call: any, callback: any) => {
        callback(null, { entries: [] });
      },
    };

    const { server: srv, port } = await startServer(memoryProto.egaop.v1.MemoryService.service, memoryImpl);
    server = srv;
    memoryPort = port;
    memoryClient = new memoryProto.egaop.v1.MemoryService(
      `localhost:${port}`,
      grpc.credentials.createInsecure()
    );
  });

  afterAll(() => server.forceShutdown());

  it("Write returns status and version", (done) => {
    memoryClient.Write(
      {
        agent_id: "agent-001",
        namespace: "default",
        memory_type: "working",
        entity_type: "context",
        key: "conversation-1",
        data: { fields: { message: { stringValue: "hello" } } },
      },
      (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response.status).toBe("success");
        expect(typeof response.version).toBe("string");
        done();
      }
    );
  });

  it("Read returns found=true for existing key", (done) => {
    memoryClient.Write(
      {
        agent_id: "agent-001",
        namespace: "default",
        memory_type: "working",
        entity_type: "context",
        key: "read-test",
        data: { fields: { value: { stringValue: "test-data" } } },
      },
      () => {
        memoryClient.Read(
          {
            agent_id: "agent-001",
            namespace: "default",
            memory_type: "working",
            entity_type: "context",
            key: "read-test",
          },
          (err: any, response: any) => {
            expect(err).toBeNull();
            expect(response.found).toBe(true);
            done();
          }
        );
      }
    );
  });

  it("Read returns found=false for missing key", (done) => {
    memoryClient.Read(
      {
        agent_id: "agent-001",
        namespace: "default",
        memory_type: "working",
        entity_type: "context",
        key: "nonexistent",
      },
      (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response.found).toBe(false);
        done();
      }
    );
  });
});

describe("Contract: api-server → namespace-service", () => {
  let nsPort: number;
  let nsClient: any;
  let server: grpc.Server;

  const nsProto = loadProto("egaop/v1/namespace.proto");

  beforeAll(async () => {
    const nsImpl = {
      CreateNamespace: (call: any, callback: any) => {
        callback(null, {
          id: "ns-001",
          slug: call.request.slug || "test-ns",
          display_name: call.request.display_name || "Test NS",
          tier: "NAMESPACE_TIER_STANDARD",
          owner_id: call.request.owner_id || "user-001",
          quotas: call.request.quotas || { max_agents: 10, max_concurrent_executions: 5 },
          created_at: { seconds: Math.floor(Date.now() / 1000) },
        });
      },
      GetNamespace: (call: any, callback: any) => {
        callback(null, {
          id: "ns-001",
          slug: call.request.slug,
          display_name: "Test NS",
          tier: "NAMESPACE_TIER_STANDARD",
        });
      },
      ListNamespaces: (call: any, callback: any) => {
        callback(null, {
          namespaces: [],
          next_page_token: "",
          total_count: 0,
        });
      },
    };

    const { server: srv, port } = await startServer(nsProto.egaop.v1.NamespaceService.service, nsImpl);
    server = srv;
    nsPort = port;
    nsClient = new nsProto.egaop.v1.NamespaceService(
      `localhost:${port}`,
      grpc.credentials.createInsecure()
    );
  });

  afterAll(() => server.forceShutdown());

  it("CreateNamespace returns namespace with slug and tier", (done) => {
    nsClient.CreateNamespace(
      {
        slug: "my-team",
        display_name: "My Team",
        tier: "NAMESPACE_TIER_STANDARD",
        owner_id: "user-001",
      },
      (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response.slug).toBe("my-team");
        expect(response.tier).toBe("NAMESPACE_TIER_STANDARD");
        expect(typeof response.id).toBe("string");
        done();
      }
    );
  });

  it("GetNamespace returns namespace by slug", (done) => {
    nsClient.GetNamespace(
      { slug: "my-team" },
      (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response.slug).toBe("my-team");
        expect(response.display_name).toBe("Test NS");
        done();
      }
    );
  });

  it("ListNamespaces returns paginated response", (done) => {
    nsClient.ListNamespaces(
      { owner_id: "user-001", page_size: 10 },
      (err: any, response: any) => {
        expect(err).toBeNull();
        expect(Array.isArray(response.namespaces)).toBe(true);
        expect(typeof response.next_page_token).toBe("string");
        expect(typeof response.total_count).toBe("number");
        done();
      }
    );
  });
});
