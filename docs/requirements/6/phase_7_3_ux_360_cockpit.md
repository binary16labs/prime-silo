# Phase 7.3 — UX 360: The Cognitive Cockpit

## 1. Objective
Transform the Benny Studio UI into a **Cognitive Control Center**. Surface all internal telemetry—security hashes, agent negotiations, and recursive task expansions—to ensure 100% transparency.

## 2. Architectural Changes

### 2.1 The Trust Bar (`frontend/src/components/Studio/ExecutionBar.tsx`)
- **Integrity Validation**: Periodically calls the `/governance/verify-audit` endpoint.
- **Visual Feedback**: 
    - 🟢 Verified: SHA-256 chain matches.
    - 🔴 Tampered: Audit trail integrity compromised.
    - 🟡 Pending: Validation in progress.

### 2.2 A2A Pulse View (`frontend/src/components/Studio/A2APulse.tsx`)
- **A2A Monitoring**: Displays a live feed of inter-agent messages from the `A2ARegistry`.
- **Capability Discovery**: Visual representation of when an agent "discovers" a skill from another agent.

### 2.3 Dynamic Wave Timeline (`frontend/src/components/Studio/WaveTimeline.tsx`)
- **Recursive Visualization**: Updates the timeline in real-time as sub-tasks are added (supporting the nested `parent_id` structure from Phase 7.1).

### 2.4 Compute Config Panel (`frontend/src/components/Studio/ConfigPanel.tsx`)
- **Resource Governor Tab**: A new "Compute" tab allowing users to set:
    - `max_concurrency`: Limits simultaneous LLM calls / NPU load.
    - `recursion_limit`: Hard cap on task re-planning depth.
    - `model_selection`: Global toggle for Local (Lemonade) vs. Cloud.

## 3. Implementation Details

### [MODIFY] [frontend/src/components/Studio/ExecutionBar.tsx](file:///C:/Users/nsdha/OneDrive/code/benny/frontend/src/components/Studio/ExecutionBar.tsx)
```tsx
const TrustBar = ({ executionId }) => {
  const { status, verifiedCount } = useAuditVerification(executionId);
  return (
    <div className={`trust-bar status-${status}`}>
      <ShieldCheckIcon /> {verifiedCount} Events Verified
    </div>
  );
};
```

### [MODIFY] [frontend/src/components/Studio/ConfigPanel.tsx](file:///C:/Users/nsdha/OneDrive/code/benny/frontend/src/components/Studio/ConfigPanel.tsx)
```tsx
const ComputeSettings = () => {
  return (
    <div className="compute-tab">
      <label>Max Parallel Agents (Concurrency)</label>
      <input type="number" defaultValue={1} min={1} max={8} />
      <label>Max Recursion Depth</label>
      <input type="number" defaultValue={2} min={0} max={5} />
      <Alert title="Laptop Safety" type="info">
        Keep concurrency low (1-2) when running large local models to prevent system lag.
      </Alert>
    </div>
  );
};
```

## 4. Acceptance Criteria (BDD)
- **Scenario**: User manages system resources.
  - **Given** an active Strategic Swarm.
  - **When** the user decreases `max_concurrency` to 1.
  - **Then** the `Dispatcher` must immediately pause extra parallel tasks.
  - **And** the `WaveTimeline` must correctly serialize the remaining tasks.

## 5. Test Plan (TDD)
- **Component Tests**:
    - `A2APulse.test.tsx`: Verify that mock A2A messages are rendered in the feed.
    - `TrustBar.test.tsx`: Verify UI state changes when the verification API returns a "tampered" status.
    - `ComputeSettings.test.tsx`: Verify that slider/input changes sync to `SwarmState`.
