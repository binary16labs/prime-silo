// Coordination event bus (B1 / EP-B) — the ONE in-process pub/sub for coordination changes.
//
// The B1 contract asked to "reuse the existing EventBus subscribe_all SSE" — but no such bus, no
// coord.* topics, and no shared event system existed in the repo (the cited commits are unrelated
// repo-hygiene/docs changes; the only SSE was an ad-hoc per-request stream in api/workflows_run.js).
// So, per owner direction, this is the single coordination event system: a minimal fan-out over the
// connected SSE responses. Every accepted ledger append is published here and re-broadcast to every
// subscriber, so the Bridge and agents see changes live — without inventing a second system.
export function createBus() {
  const subscribers = new Set();
  return {
    // Attach an SSE response as a subscriber (headers written, kept open until the client leaves).
    subscribe(res) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n"); // comment frame flushes headers + confirms the stream is live
      subscribers.add(res);
      const drop = () => subscribers.delete(res);
      res.on("close", drop);
      res.on("error", drop);
    },
    // Fan a coordination event out to every live subscriber. Never throws for a dead socket.
    publish(event, data) {
      const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const res of subscribers) {
        if (res.writableEnded) {
          subscribers.delete(res);
          continue;
        }
        try {
          res.write(frame);
        } catch {
          subscribers.delete(res);
        }
      }
    },
    size() {
      return subscribers.size;
    },
  };
}
