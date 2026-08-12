export const MAX_BROWSER_BUFFERED_BYTES = 8 * 1024 * 1024;

const OPEN_READY_STATE = 1;

export interface BrowserFrameDeliveryResult {
  sent: number;
  terminated: number;
  maxRejectedBufferedBytes: number;
}

interface BrowserPeer {
  readonly bufferedAmount: number;
  readonly readyState: number;
  send(payload: string): void;
  terminate(): void;
}

type Serializer = (value: unknown) => string;

function serializeJson(value: unknown): string {
  const payload = JSON.stringify(value);
  if (payload === undefined) throw new TypeError("Browser frame could not be serialized");
  return payload;
}

export function sendBrowserFrame(
  peer: BrowserPeer,
  frame: unknown,
  serialize: Serializer = serializeJson,
): BrowserFrameDeliveryResult {
  if (peer.readyState !== OPEN_READY_STATE) {
    return { sent: 0, terminated: 0, maxRejectedBufferedBytes: 0 };
  }

  if (peer.bufferedAmount >= MAX_BROWSER_BUFFERED_BYTES) {
    const rejectedBufferedBytes = peer.bufferedAmount;
    peer.terminate();
    return { sent: 0, terminated: 1, maxRejectedBufferedBytes: rejectedBufferedBytes };
  }

  const payload = serialize(frame);
  if (peer.bufferedAmount + Buffer.byteLength(payload, "utf8") >= MAX_BROWSER_BUFFERED_BYTES) {
    const rejectedBufferedBytes = peer.bufferedAmount;
    peer.terminate();
    return { sent: 0, terminated: 1, maxRejectedBufferedBytes: rejectedBufferedBytes };
  }

  peer.send(payload);
  return { sent: 1, terminated: 0, maxRejectedBufferedBytes: 0 };
}

export function broadcastBrowserFrame(
  peers: ReadonlySet<BrowserPeer>,
  frame: unknown,
  serialize: Serializer = serializeJson,
): BrowserFrameDeliveryResult {
  let healthy = 0;
  let terminated = 0;
  const rejectedPeers = new Set<BrowserPeer>();
  let maxRejectedBufferedBytes = 0;

  for (const peer of peers) {
    if (peer.readyState !== OPEN_READY_STATE) continue;
    if (peer.bufferedAmount < MAX_BROWSER_BUFFERED_BYTES) {
      healthy += 1;
      continue;
    }

    const rejectedBufferedBytes = peer.bufferedAmount;
    peer.terminate();
    rejectedPeers.add(peer);
    terminated += 1;
    if (rejectedBufferedBytes > maxRejectedBufferedBytes) {
      maxRejectedBufferedBytes = rejectedBufferedBytes;
    }
  }

  if (healthy === 0) return { sent: 0, terminated, maxRejectedBufferedBytes };

  const payload = serialize(frame);
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  let sent = 0;
  for (const peer of peers) {
    if (peer.readyState !== OPEN_READY_STATE || rejectedPeers.has(peer)) continue;
    if (peer.bufferedAmount + payloadBytes >= MAX_BROWSER_BUFFERED_BYTES) {
      const rejectedBufferedBytes = peer.bufferedAmount;
      peer.terminate();
      rejectedPeers.add(peer);
      terminated += 1;
      if (rejectedBufferedBytes > maxRejectedBufferedBytes) {
        maxRejectedBufferedBytes = rejectedBufferedBytes;
      }
      continue;
    }
    peer.send(payload);
    sent += 1;
  }

  return { sent, terminated, maxRejectedBufferedBytes };
}
