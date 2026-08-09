import { context, trace, SpanStatusCode, type Tracer } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Metadata, status as GrpcStatus, InterceptingCall } from "@grpc/grpc-js";
import {
  getStandardInterceptors,
  createServiceTokenServerInterceptor,
} from "../grpc/interceptors.js";

jest.mock("@grpc/grpc-js", () => {
  const actual = jest.requireActual("@grpc/grpc-js");
  const MockInterceptingCall = jest.fn(function (this: any, nextCall: any, requester: any) {
    this.nextCall = nextCall;
    this.requester = requester;
    this.start = jest.fn();
  });
  return { ...actual, InterceptingCall: MockInterceptingCall };
});

const MockInterceptingCall = InterceptingCall as unknown as jest.Mock;

describe("getStandardInterceptors", () => {
  it("returns the six standard interceptors in order", () => {
    const interceptors = getStandardInterceptors({ serviceName: "svc" });
    expect(interceptors.length).toBe(6);
    for (const interceptor of interceptors) {
      expect(typeof interceptor).toBe("function");
    }
  });
});

describe("retryInterceptor (index 0)", () => {
  function buildRetry() {
    const interceptor = getStandardInterceptors({ serviceName: "svc" })[0]!;
    const nextCall = jest.fn(() => ({ start: jest.fn() }));
    MockInterceptingCall.mockClear();
    interceptor({ method_definition: { path: "/egaop.v1.SomeService/Call" } }, nextCall);
    const requester = MockInterceptingCall.mock.calls[0][1];
    const listener = { onReceiveStatus: jest.fn() };
    return { nextCall, requester, listener };
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("passes through non-retryable status immediately", () => {
    const { nextCall, requester, listener } = buildRetry();
    const partial = requester.start(new Metadata(), listener, jest.fn());

    partial.onReceiveStatus({ code: GrpcStatus.NOT_FOUND, details: "nope" });

    expect(listener.onReceiveStatus).toHaveBeenCalledWith({ code: GrpcStatus.NOT_FOUND, details: "nope" });
    expect(nextCall).toHaveBeenCalledTimes(1);
  });

  it.each([
    GrpcStatus.UNAVAILABLE,
    GrpcStatus.DEADLINE_EXCEEDED,
    GrpcStatus.RESOURCE_EXHAUSTED,
    GrpcStatus.INTERNAL,
  ])("retries retryable status code %s", (code) => {
    const { nextCall, requester, listener } = buildRetry();
    const partial = requester.start(new Metadata(), listener, jest.fn());

    partial.onReceiveStatus({ code, details: "retry me" });
    jest.runAllTimers();

    expect(nextCall).toHaveBeenCalledTimes(2);
    const retryListener = nextCall.mock.results[1].value.start.mock.calls[0][1];
    expect(retryListener).toBeDefined();
    expect(listener.onReceiveStatus).not.toHaveBeenCalled();
  });

  it("stops retrying after exhausting MAX_RETRIES and forwards the final status", () => {
    const { nextCall, requester, listener } = buildRetry();
    const partial = requester.start(new Metadata(), listener, jest.fn());

    const status = { code: GrpcStatus.UNAVAILABLE, details: "down" };
    partial.onReceiveStatus(status); // retriesLeft 3 -> 2
    partial.onReceiveStatus(status); // retriesLeft 2 -> 1
    partial.onReceiveStatus(status); // retriesLeft 1 -> 0
    partial.onReceiveStatus(status); // retriesLeft 0 -> forward

    jest.runAllTimers();

    expect(nextCall).toHaveBeenCalledTimes(4);
    expect(listener.onReceiveStatus).toHaveBeenCalledWith(status);
  });
});

describe("authInterceptor (index 2)", () => {
  it("attaches the INTERNAL_SERVICE_TOKEN to outgoing metadata", () => {
    process.env.INTERNAL_SERVICE_TOKEN = "svc-token-123";
    try {
      const interceptor = getStandardInterceptors({ serviceName: "svc" })[2]!;
      MockInterceptingCall.mockClear();
      interceptor({ method_definition: { path: "/svc/M" } }, () => ({ start: jest.fn() }));
      const requester = MockInterceptingCall.mock.calls[0][1];

      const metadata = new Metadata();
      requester.start(metadata, { onReceiveStatus: jest.fn() });

      expect(metadata.get("x-service-token")[0]).toBe("svc-token-123");
    } finally {
      delete process.env.INTERNAL_SERVICE_TOKEN;
    }
  });

  it("leaves metadata untouched when no token is configured", () => {
    delete process.env.INTERNAL_SERVICE_TOKEN;
    const interceptor = getStandardInterceptors({ serviceName: "svc" })[2]!;
    MockInterceptingCall.mockClear();
    interceptor({ method_definition: { path: "/svc/M" } }, () => ({ start: jest.fn() }));
    const requester = MockInterceptingCall.mock.calls[0][1];

    const metadata = new Metadata();
    requester.start(metadata, { onReceiveStatus: jest.fn() });

    expect(metadata.get("x-service-token")).toHaveLength(0);
  });
});

describe("loggingInterceptor (index 3)", () => {
  it("logs successful calls and forwards status", () => {
    const interceptor = getStandardInterceptors({ serviceName: "svc" })[3]!;
    MockInterceptingCall.mockClear();
    interceptor({ method_definition: { path: "/svc/M" } }, () => ({ start: jest.fn() }));
    const requester = MockInterceptingCall.mock.calls[0][1];
    const listener = { onReceiveStatus: jest.fn() };

    const partial = requester.start(new Metadata(), listener, jest.fn());
    partial.onReceiveStatus({ code: 0, details: "" });

    expect(listener.onReceiveStatus).toHaveBeenCalledWith({ code: 0, details: "" });
  });

  it("logs failed calls with error details", () => {
    const interceptor = getStandardInterceptors({ serviceName: "svc" })[3]!;
    MockInterceptingCall.mockClear();
    interceptor({ method_definition: { path: "/svc/M" } }, () => ({ start: jest.fn() }));
    const requester = MockInterceptingCall.mock.calls[0][1];
    const listener = { onReceiveStatus: jest.fn() };

    const partial = requester.start(new Metadata(), listener, jest.fn());
    partial.onReceiveStatus({ code: 13, details: "boom" });

    expect(listener.onReceiveStatus).toHaveBeenCalledWith({ code: 13, details: "boom" });
  });
});

describe("metricsInterceptor (index 4)", () => {
  it("emits a call duration metric and forwards status", () => {
    const interceptor = getStandardInterceptors({ serviceName: "svc" })[4]!;
    MockInterceptingCall.mockClear();
    interceptor({ method_definition: { path: "/svc/M" } }, () => ({ start: jest.fn() }));
    const requester = MockInterceptingCall.mock.calls[0][1];
    const listener = { onReceiveStatus: jest.fn() };

    const partial = requester.start(new Metadata(), listener, jest.fn());
    partial.onReceiveStatus({ code: 3, details: "" });

    expect(listener.onReceiveStatus).toHaveBeenCalledWith({ code: 3, details: "" });
  });
});

describe("rateLimitInterceptor (index 5)", () => {
  it("allows requests under the per-namespace limit", () => {
    const interceptor = getStandardInterceptors({ serviceName: "svc", rateLimitPerNamespace: 2 })[5]!;
    MockInterceptingCall.mockClear();
    interceptor({ method_definition: { path: "/svc/M" } }, () => ({ start: jest.fn() }));
    const requester = MockInterceptingCall.mock.calls[0][1];
    const listener = { onReceiveStatus: jest.fn() };

    requester.start(new Metadata(), listener, jest.fn());
    requester.start(new Metadata(), listener, jest.fn());

    expect(listener.onReceiveStatus).not.toHaveBeenCalled();
  });

  it("rejects requests over the per-namespace limit with RATE_LIMIT", () => {
    const interceptor = getStandardInterceptors({ serviceName: "svc", rateLimitPerNamespace: 2 })[5]!;
    MockInterceptingCall.mockClear();
    interceptor({ method_definition: { path: "/svc/M" } }, () => ({ start: jest.fn() }));
    const requester = MockInterceptingCall.mock.calls[0][1];
    const listener = { onReceiveStatus: jest.fn() };

    requester.start(new Metadata(), listener, jest.fn());
    requester.start(new Metadata(), listener, jest.fn());
    requester.start(new Metadata(), listener, jest.fn());

    expect(listener.onReceiveStatus).toHaveBeenCalledTimes(1);
    expect(listener.onReceiveStatus.mock.calls[0][0].code).toBe(8);
    expect(listener.onReceiveStatus.mock.calls[0][0].details).toBe("Rate limit exceeded");
  });
});

describe("createServiceTokenServerInterceptor", () => {
  function makeFakeCall(): { call: any } {
    const call: any = {
      start: jest.fn(),
      sendMetadata: jest.fn(),
      sendMessage: jest.fn(),
      sendStatus: jest.fn(),
      startRead: jest.fn(),
      getPeer: jest.fn(),
      getDeadline: jest.fn(),
      getHost: jest.fn(),
      getAuthContext: jest.fn(),
      getConnectionInfo: jest.fn(),
      getMetricsRecorder: jest.fn(),
    };
    return { call };
  }

  function startServerCall(metadata: Metadata) {
    const fake = makeFakeCall();
    const interceptor = createServiceTokenServerInterceptor();
    const outerListener = {
      onReceiveMetadata: jest.fn(),
      onReceiveMessage: jest.fn(),
      onReceiveHalfClose: jest.fn(),
      onCancel: jest.fn(),
    };
    const interceptorCall = interceptor({ path: "/egaop.v1.SomeService/Call" } as any, fake.call);
    interceptorCall.start(outerListener);
    expect(fake.call.start).toHaveBeenCalled();
    const wrappedListener = fake.call.start.mock.calls[0][0];
    return { fake, wrappedListener, outerListener };
  }

  afterEach(() => {
    delete process.env.INTERNAL_SERVICE_TOKEN;
  });

  it("passes through when no INTERNAL_SERVICE_TOKEN is configured (dev mode)", () => {
    delete process.env.INTERNAL_SERVICE_TOKEN;
    const metadata = new Metadata();

    const { fake, wrappedListener, outerListener } = startServerCall(metadata);
    wrappedListener.onReceiveMetadata(metadata);

    expect(outerListener.onReceiveMetadata).toHaveBeenCalledWith(metadata);
    expect(fake.call.sendStatus).not.toHaveBeenCalled();
  });

  it("accepts a valid x-service-token", () => {
    process.env.INTERNAL_SERVICE_TOKEN = "valid-secret";
    const metadata = new Metadata();
    metadata.set("x-service-token", "valid-secret");

    const { fake, wrappedListener, outerListener } = startServerCall(metadata);
    wrappedListener.onReceiveMetadata(metadata);

    expect(outerListener.onReceiveMetadata).toHaveBeenCalledWith(metadata);
    expect(fake.call.sendStatus).not.toHaveBeenCalled();
  });

  it("rejects a mismatched token with code 16", () => {
    process.env.INTERNAL_SERVICE_TOKEN = "valid-secret";
    const metadata = new Metadata();
    metadata.set("x-service-token", "wrong-token");

    const { fake, wrappedListener, outerListener } = startServerCall(metadata);
    wrappedListener.onReceiveMetadata(metadata);

    expect(fake.call.sendStatus).toHaveBeenCalled();
    expect(fake.call.sendStatus.mock.calls[0][0].code).toBe(16);
    expect(outerListener.onReceiveMetadata).not.toHaveBeenCalled();
  });

  it("rejects when token length differs", () => {
    process.env.INTERNAL_SERVICE_TOKEN = "long-secret-abc";
    const metadata = new Metadata();
    metadata.set("x-service-token", "short");

    const { fake, wrappedListener, outerListener } = startServerCall(metadata);
    wrappedListener.onReceiveMetadata(metadata);

    expect(fake.call.sendStatus).toHaveBeenCalled();
    expect(fake.call.sendStatus.mock.calls[0][0].code).toBe(16);
    expect(outerListener.onReceiveMetadata).not.toHaveBeenCalled();
  });

  it("forwards messages, half-close, and cancel", () => {
    process.env.INTERNAL_SERVICE_TOKEN = "valid-secret";
    const metadata = new Metadata();
    metadata.set("x-service-token", "valid-secret");

    const { wrappedListener, outerListener } = startServerCall(metadata);
    wrappedListener.onReceiveMetadata(metadata);

    wrappedListener.onReceiveMessage({ hello: "world" });
    expect(outerListener.onReceiveMessage).toHaveBeenCalledWith({ hello: "world" });

    wrappedListener.onReceiveHalfClose();
    expect(outerListener.onReceiveHalfClose).toHaveBeenCalled();

    expect(() => wrappedListener.onCancel()).not.toThrow();
    expect(outerListener.onCancel).toHaveBeenCalled();
  });
});

describe("spanEnrichmentInterceptor (index 1)", () => {
  let exporter: InMemorySpanExporter;
  let tracer: Tracer;

  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager());
    exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
    tracer = trace.getTracer("interceptors-test");
  });

  beforeEach(() => {
    exporter.reset();
  });

  afterAll(async () => {
    await exporter.shutdown();
  });

  it("creates a client span, injects traceparent, and records status", () => {
    const interceptor = getStandardInterceptors({ serviceName: "svc" })[1]!;
    MockInterceptingCall.mockClear();
    interceptor(
      { method_definition: { path: "/egaop.v1.SomeService/Call" } },
      () => ({ start: jest.fn() })
    );
    const requester = MockInterceptingCall.mock.calls[0][1];
    const listener = { onReceiveStatus: jest.fn() };

    const metadata = new Metadata();
    metadata.set("x-namespace", "acme-prod");
    metadata.set("x-agent-id", "agent-42");

    const partial = requester.start(metadata, listener, jest.fn());

    expect(metadata.get("traceparent")[0]).toBeDefined();

    partial.onReceiveStatus({ code: 0, details: "" });

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBe(1);
    expect(spans[0].name).toBe("grpc.egaop.v1.SomeService.Call");
    expect(spans[0].attributes["rpc.system"]).toBe("grpc");
    expect(spans[0].attributes["namespace"]).toBe("acme-prod");
    expect(spans[0].attributes["agent.id"]).toBe("agent-42");
    expect(spans[0].status.code).toBe(SpanStatusCode.OK);
    expect(listener.onReceiveStatus).toHaveBeenCalledTimes(1);
  });

  it("marks the span as ERROR on non-OK status", () => {
    const interceptor = getStandardInterceptors({ serviceName: "svc" })[1]!;
    MockInterceptingCall.mockClear();
    interceptor(
      { method_definition: { path: "/egaop.v1.SomeService/Call" } },
      () => ({ start: jest.fn() })
    );
    const requester = MockInterceptingCall.mock.calls[0][1];

    const metadata = new Metadata();
    const partial = requester.start(metadata, { onReceiveStatus: jest.fn() }, jest.fn());

    partial.onReceiveStatus({ code: 13, details: "boom" });

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBe(1);
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
  });

  it("defaults namespace to 'default' and only sets traceparent when span has a trace id", () => {
    const interceptor = getStandardInterceptors({ serviceName: "svc" })[1]!;
    MockInterceptingCall.mockClear();
    interceptor(
      { method_definition: { path: "/egaop.v1.SomeService/Call" } },
      () => ({ start: jest.fn() })
    );
    const requester = MockInterceptingCall.mock.calls[0][1];

    const metadata = new Metadata();
    const partial = requester.start(metadata, { onReceiveStatus: jest.fn() }, jest.fn());

    partial.onReceiveStatus({ code: 3, details: "" });
    const spans = exporter.getFinishedSpans();
    expect(spans[0].attributes["namespace"]).toBe("default");
    expect(spans[0].attributes["agent.id"]).toBeUndefined();
  });
});
