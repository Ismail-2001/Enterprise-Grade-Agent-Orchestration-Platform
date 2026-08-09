import { Metadata, status as GrpcStatus } from "@grpc/grpc-js";
import {
  createNamespaceEnforcementInterceptor,
  createNamespaceServerInterceptor,
  updateNamespaceCache,
  clearNamespaceCache,
} from "../grpc/namespace-enforcement.js";
import { signJWT } from "../crypto/index.js";

const JWT_SECRET = "test-namespace-secret-aaaaaaaaaaaaaaaaaaaaaaaaaa";

function signClaims(claims: Record<string, unknown>, expiresInSec = 3600): string {
  return signJWT(
    {
      sub: claims.sub as string,
      email: claims.email as string,
      name: claims.name as string,
      role: claims.role as string,
      namespace_access: claims.namespace_access as string[],
      ...(claims.namespace ? { namespace: claims.namespace } : {}),
    },
    JWT_SECRET,
    expiresInSec
  );
}

describe("createNamespaceEnforcementInterceptor (client)", () => {
  beforeEach(() => {
    clearNamespaceCache();
    process.env.JWT_SECRET = JWT_SECRET;
  });

  afterEach(() => {
    clearNamespaceCache();
    delete process.env.JWT_SECRET;
  });

  function makeClientCall(namespace: string, claims: string) {
    const interceptor = createNamespaceEnforcementInterceptor();
    const options = { method_definition: { path: "/egaop.v1.SomeService/Call", namespace } } as any;
    const statusListener = jest.fn();
    const call = interceptor(options, () => ({ start: jest.fn() }));
    const metadata = new Metadata();
    metadata.set("x-agent-claims", claims);
    call.start(metadata, { onReceiveStatus: statusListener });
    return { statusListener };
  }

  it("denies cross-namespace access when caller lacks platform-admin role", () => {
    const { statusListener } = makeClientCall(
      "ns-b",
      signClaims({ sub: "user-1", email: "a@b.com", name: "A", role: "user", namespace_access: ["ns-a"] })
    );
    expect(statusListener).toHaveBeenCalled();
    expect(statusListener.mock.calls[0][0].code).toBe(GrpcStatus.PERMISSION_DENIED);
    expect(statusListener.mock.calls[0][0].details).toContain("Cross-namespace access denied");
  });

  it("does not emit a status for same-namespace access", () => {
    const { statusListener } = makeClientCall(
      "ns-a",
      signClaims({ sub: "user-1", email: "a@b.com", name: "A", role: "user", namespace_access: ["ns-a"] })
    );
    expect(statusListener).not.toHaveBeenCalled();
  });

  it("allows platform-admin cross-namespace access", () => {
    const { statusListener } = makeClientCall(
      "ns-b",
      signClaims({ sub: "admin-1", email: "a@b.com", name: "A", role: "platform-admin", namespace_access: ["ns-a"] })
    );
    expect(statusListener).not.toHaveBeenCalled();
  });

  it("denies when namespace is deleted from cache", () => {
    updateNamespaceCache("ns-a", { exists: true, suspended: false, deleted: true });
    const { statusListener } = makeClientCall(
      "ns-a",
      signClaims({ sub: "user-1", email: "a@b.com", name: "A", role: "user", namespace_access: ["ns-a"] })
    );
    expect(statusListener).toHaveBeenCalled();
    expect(statusListener.mock.calls[0][0].code).toBe(GrpcStatus.NOT_FOUND);
  });

  it("denies when namespace is suspended from cache", () => {
    updateNamespaceCache("ns-a", { exists: true, suspended: true, deleted: false });
    const { statusListener } = makeClientCall(
      "ns-a",
      signClaims({ sub: "user-1", email: "a@b.com", name: "A", role: "user", namespace_access: ["ns-a"] })
    );
    expect(statusListener).toHaveBeenCalled();
    expect(statusListener.mock.calls[0][0].code).toBe(GrpcStatus.UNAVAILABLE);
  });

  it("fails closed (denies) when no JWT_SECRET is configured", () => {
    delete process.env.JWT_SECRET;
    const { statusListener } = makeClientCall("ns-b", "tampered-token");
    expect(statusListener).toHaveBeenCalled();
    expect(statusListener.mock.calls[0][0].code).toBe(GrpcStatus.PERMISSION_DENIED);
  });

  it("fails closed (denies) for invalid JWT claims", () => {
    const { statusListener } = makeClientCall("ns-b", "not-a-valid-jwt");
    expect(statusListener).toHaveBeenCalled();
    expect(statusListener.mock.calls[0][0].code).toBe(GrpcStatus.PERMISSION_DENIED);
  });
});

describe("createNamespaceServerInterceptor", () => {
  function makeFakeCall(): { call: any } {
    const call: any = {
      start: jest.fn(),
      sendMetadata: jest.fn(),
      sendMessage: jest.fn(),
      sendStatus: jest.fn(),
      startRead: jest.fn(),
      getPeer: jest.fn(() => "10.0.0.1:5000"),
      getDeadline: jest.fn(() => new Date()),
      getHost: jest.fn(() => "host"),
      getAuthContext: jest.fn(() => ({})),
      getConnectionInfo: jest.fn(() => null),
      getMetricsRecorder: jest.fn(),
    };
    return { call };
  }

  beforeEach(() => {
    clearNamespaceCache();
    process.env.JWT_SECRET = JWT_SECRET;
  });

  afterEach(() => {
    clearNamespaceCache();
    delete process.env.JWT_SECRET;
  });

  function startServerCall(metadata: Metadata) {
    const fake = makeFakeCall();
    const interceptor = createNamespaceServerInterceptor();
    const methodDescriptor = { path: "/egaop.v1.SomeService/Call" } as any;
    const outerListener = {
      onReceiveMetadata: jest.fn(),
      onReceiveMessage: jest.fn(),
      onReceiveHalfClose: jest.fn(),
      onCancel: jest.fn(),
    };
    const interceptorCall = interceptor(methodDescriptor, fake.call);
    interceptorCall.start(outerListener);
    expect(fake.call.start).toHaveBeenCalled();
    const wrappedListener = fake.call.start.mock.calls[0][0];
    return { fake, interceptorCall, wrappedListener, outerListener };
  }

  it("denies cross-namespace access on server side", () => {
    const metadata = new Metadata();
    metadata.set("x-agent-claims", signClaims({ sub: "user-1", email: "a@b.com", name: "A", role: "user", namespace_access: ["ns-a"] }));
    metadata.set("x-resolved-namespace", "ns-b");

    const { fake, wrappedListener, outerListener } = startServerCall(metadata);
    wrappedListener.onReceiveMetadata(metadata);

    expect(fake.call.sendStatus).toHaveBeenCalled();
    expect(fake.call.sendStatus.mock.calls[0][0].code).toBe(GrpcStatus.PERMISSION_DENIED);
    expect(outerListener.onReceiveMetadata).not.toHaveBeenCalled();
  });

  it("passes through same-namespace metadata", () => {
    const metadata = new Metadata();
    metadata.set("x-agent-claims", signClaims({ sub: "user-1", email: "a@b.com", name: "A", role: "user", namespace_access: ["ns-a"] }));
    metadata.set("x-resolved-namespace", "ns-a");

    const { fake, wrappedListener, outerListener } = startServerCall(metadata);
    wrappedListener.onReceiveMetadata(metadata);

    expect(fake.call.sendStatus).not.toHaveBeenCalled();
    expect(outerListener.onReceiveMetadata).toHaveBeenCalledWith(metadata);
    expect(metadata.get("x-caller-namespace")[0]).toBe("ns-a");
  });

  it("denies deleted namespace on server side", () => {
    updateNamespaceCache("ns-a", { exists: true, suspended: false, deleted: true });
    const metadata = new Metadata();
    metadata.set("x-agent-claims", signClaims({ sub: "user-1", email: "a@b.com", name: "A", role: "user", namespace_access: ["ns-a"] }));
    metadata.set("x-resolved-namespace", "ns-a");

    const { fake, wrappedListener } = startServerCall(metadata);
    wrappedListener.onReceiveMetadata(metadata, jest.fn());

    expect(fake.call.sendStatus).toHaveBeenCalled();
    expect(fake.call.sendStatus.mock.calls[0][0].code).toBe(GrpcStatus.NOT_FOUND);
  });

  it("denies suspended namespace on server side", () => {
    updateNamespaceCache("ns-a", { exists: true, suspended: true, deleted: false });
    const metadata = new Metadata();
    metadata.set("x-agent-claims", signClaims({ sub: "user-1", email: "a@b.com", name: "A", role: "user", namespace_access: ["ns-a"] }));
    metadata.set("x-resolved-namespace", "ns-a");

    const { fake, wrappedListener } = startServerCall(metadata);
    wrappedListener.onReceiveMetadata(metadata, jest.fn());

    expect(fake.call.sendStatus).toHaveBeenCalled();
    expect(fake.call.sendStatus.mock.calls[0][0].code).toBe(GrpcStatus.UNAVAILABLE);
  });

  it("forwards messages, half-close, and cancel", () => {
    const metadata = new Metadata();
    metadata.set("x-resolved-namespace", "ns-a");

    const { fake, wrappedListener, outerListener } = startServerCall(metadata);
    wrappedListener.onReceiveMessage({ hello: "world" });
    expect(outerListener.onReceiveMessage).toHaveBeenCalledWith({ hello: "world" });

    wrappedListener.onReceiveHalfClose();
    expect(outerListener.onReceiveHalfClose).toHaveBeenCalled();

    expect(() => wrappedListener.onCancel()).not.toThrow();
    expect(outerListener.onCancel).toHaveBeenCalled();
  });

  it("exposes call accessors via wrapped call", () => {
    const metadata = new Metadata();
    const { fake, interceptorCall, wrappedListener } = startServerCall(metadata);
    wrappedListener.onReceiveMetadata(metadata, jest.fn());

    expect(interceptorCall.getPeer()).toBe("10.0.0.1:5000");
    expect(interceptorCall.getHost()).toBe("host");
    expect(interceptorCall.getDeadline()).toBeInstanceOf(Date);
  });
});
