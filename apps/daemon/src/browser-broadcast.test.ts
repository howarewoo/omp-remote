import { WebSocket } from "ws";
import { describe, expect, it, vi } from "vitest";
import { broadcastBrowserFrame, MAX_BROWSER_BUFFERED_BYTES, sendBrowserFrame } from "./browser-broadcast.js";

type BrowserPeer = Pick<WebSocket, "bufferedAmount" | "readyState" | "send" | "terminate">;

function makePeer(readyState: WebSocket["readyState"] = WebSocket.OPEN, bufferedAmount = 0) {
  const send = vi.fn();
  const terminate = vi.fn();
  const peer = { bufferedAmount, readyState, send, terminate } satisfies BrowserPeer;

  return { peer, send, terminate };
}

describe("browser frame delivery", () => {
  it("terminates a lagging open peer without serializing or sending another frame", () => {
    expect(MAX_BROWSER_BUFFERED_BYTES).toBe(8 * 1024 * 1024);
    const lagging = makePeer(WebSocket.OPEN, MAX_BROWSER_BUFFERED_BYTES);
    const toJSON = vi.fn(() => ({ type: "snapshot" }));
    const frame = { toJSON };
    const serialize = vi.fn((value: unknown) => JSON.stringify(value));

    const result = sendBrowserFrame(lagging.peer, frame, serialize);

    expect(lagging.terminate).toHaveBeenCalledOnce();
    expect(lagging.send).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
    expect(serialize).not.toHaveBeenCalled();
    expect(result).toEqual({
      sent: 0,
      terminated: 1,
      maxRejectedBufferedBytes: MAX_BROWSER_BUFFERED_BYTES,
    });
  });

  it.each([
    ["below", MAX_BROWSER_BUFFERED_BYTES - Buffer.byteLength("😀", "utf8") - 1, true],
    ["equal to", MAX_BROWSER_BUFFERED_BYTES - Buffer.byteLength("😀", "utf8"), false],
    ["above", MAX_BROWSER_BUFFERED_BYTES - Buffer.byteLength("😀", "utf8") + 1, false],
  ] as const)(
    "%s the UTF-8 byte cap admits only payloads whose resulting buffer remains below it",
    (_boundary, bufferedAmount, accepted) => {
      const payload = "😀";
      const peer = makePeer(WebSocket.OPEN, bufferedAmount);
      const serialize = vi.fn(() => payload);

      const result = sendBrowserFrame(peer.peer, { type: "event" }, serialize);

      expect(peer.send).toHaveBeenCalledTimes(accepted ? 1 : 0);
      expect(peer.terminate).toHaveBeenCalledTimes(accepted ? 0 : 1);
      expect(serialize).toHaveBeenCalledOnce();
      expect(result).toEqual({
        sent: accepted ? 1 : 0,
        terminated: accepted ? 0 : 1,
        maxRejectedBufferedBytes: accepted ? 0 : bufferedAmount,
      });
    },
  );

  it("sends one serialized payload to every healthy peer while terminating lagging peers and ignoring non-open peers", () => {
    const firstHealthy = makePeer();
    const secondHealthy = makePeer(WebSocket.OPEN, MAX_BROWSER_BUFFERED_BYTES - 1024);
    const lagging = makePeer(WebSocket.OPEN, MAX_BROWSER_BUFFERED_BYTES + 11);
    const mostLagging = makePeer(WebSocket.OPEN, MAX_BROWSER_BUFFERED_BYTES + 29);
    const closing = makePeer(WebSocket.CLOSING, MAX_BROWSER_BUFFERED_BYTES + 100);
    const toJSON = vi.fn(() => ({ type: "event", value: "same payload" }));
    const frame = { toJSON };
    const serialize = vi.fn((value: unknown) => JSON.stringify(value));

    const result = broadcastBrowserFrame(
      new Set([firstHealthy.peer, lagging.peer, closing.peer, secondHealthy.peer, mostLagging.peer]),
      frame,
      serialize,
    );

    const expectedPayload = JSON.stringify({ type: "event", value: "same payload" });
    expect(firstHealthy.send).toHaveBeenCalledOnce();
    expect(firstHealthy.send).toHaveBeenCalledWith(expectedPayload);
    expect(secondHealthy.send).toHaveBeenCalledOnce();
    expect(secondHealthy.send).toHaveBeenCalledWith(expectedPayload);
    expect(firstHealthy.terminate).not.toHaveBeenCalled();
    expect(secondHealthy.terminate).not.toHaveBeenCalled();
    expect(toJSON).toHaveBeenCalledOnce();
    expect(serialize).toHaveBeenCalledOnce();
    expect(serialize).toHaveBeenCalledWith(frame);
    expect(lagging.terminate).toHaveBeenCalledOnce();
    expect(mostLagging.terminate).toHaveBeenCalledOnce();
    const [serializationInvocationOrder] = serialize.mock.invocationCallOrder;
    if (serializationInvocationOrder === undefined) {
      throw new Error("Expected the serializer to record an invocation order");
    }
    expect(lagging.terminate.mock.invocationCallOrder[0]).toBeLessThan(serializationInvocationOrder);
    expect(mostLagging.terminate.mock.invocationCallOrder[0]).toBeLessThan(serializationInvocationOrder);
    expect(lagging.send).not.toHaveBeenCalled();
    expect(mostLagging.send).not.toHaveBeenCalled();
    expect(closing.terminate).not.toHaveBeenCalled();
    expect(closing.send).not.toHaveBeenCalled();
    expect(result).toEqual({
      sent: 2,
      terminated: 2,
      maxRejectedBufferedBytes: MAX_BROWSER_BUFFERED_BYTES + 29,
    });
  });

  it("does not serialize a frame when every peer is unavailable or lagging", () => {
    const lagging = makePeer(WebSocket.OPEN, MAX_BROWSER_BUFFERED_BYTES + 7);
    const connecting = makePeer(WebSocket.CONNECTING);
    const closed = makePeer(WebSocket.CLOSED);
    const toJSON = vi.fn(() => ({ type: "event" }));
    const frame = { toJSON };
    const serialize = vi.fn((value: unknown) => JSON.stringify(value));

    const result = broadcastBrowserFrame(
      new Set([lagging.peer, connecting.peer, closed.peer]),
      frame,
      serialize,
    );

    expect(serialize).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
    expect(lagging.terminate).toHaveBeenCalledOnce();
    expect(lagging.send).not.toHaveBeenCalled();
    expect(connecting.terminate).not.toHaveBeenCalled();
    expect(connecting.send).not.toHaveBeenCalled();
    expect(closed.terminate).not.toHaveBeenCalled();
    expect(closed.send).not.toHaveBeenCalled();
    expect(result).toEqual({
      sent: 0,
      terminated: 1,
      maxRejectedBufferedBytes: MAX_BROWSER_BUFFERED_BYTES + 7,
    });
  });
});
