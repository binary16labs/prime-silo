const IPC_MESSAGE_TYPES = Object.freeze({
  STATE_DELTA: "space:state_delta",
  STATE_REQUEST: "space:state_request",
  STATE_RESPONSE: "space:state_response",
  STATE_SNAPSHOT: "space:state_snapshot",
  WORKER_LISTENING: "space:worker_listening",
  WORKER_READY: "space:worker_ready"
});

let nextIpcRequestId = 0;

function createIpcRequestId(prefix = "ipc") {
  nextIpcRequestId += 1;
  return `${prefix}-${process.pid}-${Date.now().toString(36)}-${nextIpcRequestId}`;
}

export { IPC_MESSAGE_TYPES, createIpcRequestId };
