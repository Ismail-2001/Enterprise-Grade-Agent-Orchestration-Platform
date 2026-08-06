import { context, trace, SpanStatusCode, type Span, type SpanKind } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  type ServerInterceptor,
  type ServerMethodDefinition,
  type Metadata,
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
    methodDescriptor: ServerMethodDefinition<any, any>,
    call: any
  ): ServerInterceptingCall => {
    const methodPath = methodDescriptor.path ?? "unknown";
    const parts = methodPath.split("/").filter(Boolean);
    const grpcService = parts.length >= 2 ? parts[0]! : "unknown";
    const grpcMethod = parts.length >= 2 ? parts[1]! : parts[parts.length - 1] ?? "unknown";

    const wrappedCall: any = {
      start: (callback: any) => {
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

            call.onServerSpan = span;
          },
          onReceiveMessage: (message: any, passthrough: (m: any) => void) => {
            passthrough(message);
          },
          onReceiveHalfClose: (passthrough: () => void) => {
            passthrough();
          },
          onCancel: () => {
            const span = call.onServerSpan as Span | undefined;
            if (span) {
              span.setStatus({ code: SpanStatusCode.ERROR, message: "call cancelled" });
              span.end();
              call.onServerSpan = undefined;
            }
          },
        };
        callback(wrappedListener);
      },
      sendMetadata: (metadata: any, callback: any) => callback(metadata),
      sendMessage: (message: any, callback: any) => {
        const span = call.onServerSpan as Span | undefined;
        if (span) {
          context.with(trace.setSpan(context.active(), span), () => callback(message));
        } else {
          callback(message);
        }
      },
      sendStatus: (status: any, callback: any) => {
        const span = call.onServerSpan as Span | undefined;
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
          call.onServerSpan = undefined;
        }
        callback(status);
      },
      startRead: () => call.startRead(),
      getPeer: () => call.getPeer(),
      getDeadline: () => call.getDeadline(),
      getHost: () => call.getHost(),
      getAuthContext: () => call.getAuthContext(),
      getConnectionInfo: () => call.getConnectionInfo(),
      getMetricsRecorder: () => call.getMetricsRecorder(),
    };

    return new ServerInterceptingCall(call as any, wrappedCall as any);
  };
}

export { spanEnrichmentInterceptor } from "./span-enrichment.js";
