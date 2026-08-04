import { context, trace, SpanStatusCode, type SpanContext, type Tracer } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Metadata } from "@grpc/grpc-js";
import { createTraceServerInterceptor } from "../grpc/trace-propagation.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_SPAN_ID = "00f067aa0ba902b7";

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

describe("createTraceServerInterceptor", () => {
  let exporter: InMemorySpanExporter;
  let tracer: Tracer;

  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager());
    exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
  });

  beforeEach(() => {
    tracer = trace.getTracer("trace-propagation-test");
    exporter.reset();
  });

  afterAll(async () => {
    await exporter.shutdown();
  });

  function startCall(metadata: Metadata, onReceiveMetadata?: (m: any) => void): { call: any; listener: any } {
    const fake = makeFakeCall();
    const interceptor = createTraceServerInterceptor();
    const methodDescriptor = { path: "/helloworld.Greeter/SayHello" } as any;
    const interceptorCall = interceptor(methodDescriptor, fake.call);
    interceptorCall.start({
      onReceiveMetadata: onReceiveMetadata ?? jest.fn(),
      onReceiveMessage: jest.fn(),
      onReceiveHalfClose: jest.fn(),
      onCancel: jest.fn(),
    });
    expect(fake.call.start).toHaveBeenCalled();
    const listener = fake.call.start.mock.calls[0][0];
    return { call: interceptorCall, listener };
  }

  it("extracts W3C trace context and creates a SERVER span with rpc attributes", () => {
    const metadata = new Metadata();
    metadata.set("traceparent", `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`);
    metadata.set("x-namespace", "acme-prod");
    metadata.set("x-agent-id", "agent-42");

    const { call, listener } = startCall(metadata);
    listener.onReceiveMetadata(metadata, (m: any) => {});

    call.sendStatus({ code: 0, details: "ok" }, () => {});

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBe(1);
    const span = spans[0]!;

    expect(span.name).toBe("grpc.helloworld.Greeter.SayHello");
    expect(span.kind).toBe(2); // SERVER
    expect(span.spanContext().traceId).toBe(TRACE_ID);
    expect(span.parentSpanContext?.spanId).toBe(PARENT_SPAN_ID);
    expect(span.attributes["rpc.system"]).toBe("grpc");
    expect(span.attributes["rpc.service"]).toBe("helloworld.Greeter");
    expect(span.attributes["rpc.method"]).toBe("SayHello");
    expect(span.attributes["rpc.grpc.status_code"]).toBe(0);
    expect(span.attributes["namespace"]).toBe("acme-prod");
    expect(span.attributes["agent.id"]).toBe("agent-42");
    expect(span.status.code).toBe(SpanStatusCode.OK);
  });

  it("defaults namespace to 'default' when no metadata is present", () => {
    const metadata = new Metadata();
    const { call, listener } = startCall(metadata);
    listener.onReceiveMetadata(metadata, (m: any) => {});

    call.sendStatus({ code: 0, details: "ok" }, () => {});

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.attributes["namespace"]).toBe("default");
    expect(span.attributes["agent.id"]).toBeUndefined();
  });

  it("makes the server span active for the handler (child spans inherit parent)", async () => {
    const metadata = new Metadata();
    metadata.set("traceparent", `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`);

    let childSpanContext: SpanContext | undefined;
    const { call, listener } = startCall(metadata, (m: any) => {
      const child = tracer.startSpan("handler-work");
      childSpanContext = child.spanContext();
      child.end();
    });
    listener.onReceiveMetadata(metadata, (m: any) => {});

    call.sendStatus({ code: 0, details: "ok" }, () => {});

    const spans = exporter.getFinishedSpans();
    const serverSpan = spans.find((s) => s.name === "grpc.helloworld.Greeter.SayHello")!;
    const child = spans.find((s) => s.name === "handler-work")!;

    expect(child).toBeDefined();
    expect(child.parentSpanContext?.spanId).toBe(serverSpan.spanContext().spanId);
    expect(child.spanContext().traceId).toBe(TRACE_ID);
    expect(serverSpan.spanContext().traceId).toBe(TRACE_ID);
    expect(childSpanContext!.traceId).toBe(TRACE_ID);
  });

  it("records an ERROR status and gRPC status code on non-OK responses", () => {
    const metadata = new Metadata();
    metadata.set("traceparent", `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`);

    const { call, listener } = startCall(metadata);
    listener.onReceiveMetadata(metadata, (m: any) => {});

    call.sendStatus({ code: 13, details: "internal error" }, () => {});

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toContain("internal error");
    expect(span.attributes["rpc.grpc.status_code"]).toBe(13);
  });

  it("ends the span with an ERROR status when the call is cancelled", () => {
    const metadata = new Metadata();
    metadata.set("traceparent", `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`);

    const { listener } = startCall(metadata);
    listener.onReceiveMetadata(metadata, (m: any) => {});
    listener.onCancel();

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toContain("cancelled");
  });

  it("propagates no trace context when traceparent is absent (fresh root span)", () => {
    const metadata = new Metadata();
    const { call, listener } = startCall(metadata);
    listener.onReceiveMetadata(metadata, (m: any) => {});

    call.sendStatus({ code: 0, details: "ok" }, () => {});

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.spanContext().traceId).not.toBe(TRACE_ID);
    expect(span.parentSpanContext).toBeUndefined();
  });
});
