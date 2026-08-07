import { context, trace, SpanStatusCode, type Span, type SpanKind } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  type ServerInterceptor,
  type ServerMethodDefinition,
  type Metadata,
  type StatusObject,
  type ServerInterceptingCallInterface,
  ServerInterceptingCall,
} from "@grpc/grpc-js";
import { getTracer } from "../telemetry/index.js";

const propagator = new W3CTraceContextPropagator();

const metadataGetter = {
  get(carrier: Record<string, string>, key: string): string | undefined {
    return carrier[key];
  },
  keys(carrier: Record<string, string>): string[] {
    return Object.keys(carrier);
  },
};

/**
 * Server-side interceptor: extracts W3C trace context from the incoming
 * gRPC metadata, creates a SERVER span as a child of the caller's client
 * span, and makes it the active span for the duration of the handler. This
 * gives us end-to-end distributed traces across every service boundary.
 */
export function createTraceServerInterceptor(): ServerInterceptor {
  const tracer = getTracer();

  return (
    methodDescriptor: ServerMethodDefinition<unknown, unknown>,
    call: ServerInterceptingCallInterface
  ): ServerInterceptingCall => {
    const methodPath = methodDescriptor.path ?? "unknown";
    const parts = methodPath.split("/").filter(Boolean);
    const grpcService = parts.length >= 2 ? parts[0]! : "unknown";
    const grpcMethod = parts.length >= 2 ? parts[1]! : parts[parts.length - 1] ?? "unknown";

    const wrappedCall: {
      start: (callback: (listener: {
        onReceiveMetadata: (metadata: Metadata, passthrough: (m: Metadata) => void) => void;
        onReceiveMessage: (message: unknown, passthrough: (m: unknown) => void) => void;
        onReceiveHalfClose: (passthrough: () => void) => void;
        onCancel: () => void;
      }) => void) => void;
      sendMetadata: (metadata: Metadata, callback: (metadata: Metadata) => void) => void;
      sendMessage: (message: unknown, callback: (message: unknown) => void) => void;
      sendStatus: (status: StatusObject, callback: (status: StatusObject) => void) => void;
      startRead: () => void;
      getPeer: () => string;
      getDeadline: () => Date;
      getHost: () => string;
      getAuthContext: () => Record<string, string[]>;
      getConnectionInfo: () => Record<string, unknown> | null;
      getMetricsRecorder: () => unknown;
    } & { onServerSpan?: Span } = {
      start: (callback) => {
        const wrappedListener = {
          onReceiveMetadata: (metadata: Metadata, passthrough: (m: Metadata) => void) => {
            const carrier: Record<string, string> = {};
            const metadataMap = metadata.getMap();
            for (const [key, value] of Object.entries(metadataMap)) {
              carrier[key] = typeof value === "string" ? value : new TextDecoder().decode(value);
            }

            const extractedContext = propagator.extract(context.active(), carrier, metadataGetter);

            const span = tracer.startSpan(
              `grpc.${grpcService}.${grpcMethod}`,
              {
                kind: 2 as SpanKind, // SERVER
                attributes: {
                  "rpc.system": "grpc",
                  "rpc.service": grpcService,
                  "rpc.method": grpcMethod,
                  "rpc.grpc.status_code": 0,
                },
              },
              extractedContext
            );

            const namespaceValues = metadata.get("x-namespace");
            const agentIdValues = metadata.get("x-agent-id");
            const namespace = (namespaceValues[0] as string) ?? "default";
            const agentId = (agentIdValues[0] as string) ?? "";
            span.setAttribute("namespace", namespace);
            if (agentId) {
              span.setAttribute("agent.id", agentId);
            }

            // Make the server span active so all downstream work in the handler
            // (DB queries, HTTP calls, nested gRPC) becomes part of the trace.
            const serverContext = trace.setSpan(extractedContext, span);
            context.with(serverContext, () => {
              passthrough(metadata);
            });

            wrappedCall.onServerSpan = span;
          },
          onReceiveMessage: (message: unknown, passthrough: (m: unknown) => void) => {
            passthrough(message);
          },
          onReceiveHalfClose: (passthrough: () => void) => {
            passthrough();
          },
          onCancel: () => {
            const span = wrappedCall.onServerSpan;
            if (span) {
              span.setStatus({ code: SpanStatusCode.ERROR, message: "call cancelled" });
              span.end();
              wrappedCall.onServerSpan = undefined;
            }
          },
        };
        callback(wrappedListener);
      },
      sendMetadata: (metadata: Metadata, callback: (metadata: Metadata) => void) => callback(metadata),
      sendMessage: (message: unknown, callback: (message: unknown) => void) => {
        const span = wrappedCall.onServerSpan;
        if (span) {
          context.with(trace.setSpan(context.active(), span), () => callback(message));
        } else {
          callback(message);
        }
      },
      sendStatus: (status: StatusObject, callback: (status: StatusObject) => void) => {
        const span = wrappedCall.onServerSpan;
        if (span) {
          const grpcStatusCode = typeof status.code === "number" ? status.code : 0;
          if (grpcStatusCode !== 0) {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: status.details || `gRPC error: ${grpcStatusCode}`,
            });
            span.setAttribute("rpc.grpc.status_code", grpcStatusCode);
            if (status.details) {
              span.recordException(new Error(status.details));
            }
          } else {
            span.setStatus({ code: SpanStatusCode.OK });
            span.setAttribute("rpc.grpc.status_code", 0);
          }
          span.end();
          wrappedCall.onServerSpan = undefined;
        }
        callback(status);
      },
      startRead: () => call.startRead(),
      getPeer: () => call.getPeer(),
      getDeadline: () => call.getDeadline() as unknown as Date,
      getHost: () => call.getHost(),
      getAuthContext: () => call.getAuthContext() as unknown as Record<string, string[]>,
      getConnectionInfo: () => call.getConnectionInfo() as unknown as Record<string, unknown>,
      getMetricsRecorder: () => call.getMetricsRecorder(),
    };

    return new ServerInterceptingCall(call as never, wrappedCall as never);
  };
}

export { spanEnrichmentInterceptor } from "./span-enrichment.js";
