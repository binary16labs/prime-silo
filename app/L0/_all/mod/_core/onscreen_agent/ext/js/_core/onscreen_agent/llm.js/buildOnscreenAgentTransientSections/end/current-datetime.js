import { setPromptItem } from "/mod/_core/agent_prompt/prompt-items.js";

// Ambient time/state awareness. The firmware prompt and the other transient
// hooks give the agent space and file-tree context, but nothing tells it what
// day or time it is, so it cannot reason about "today", recency, or schedules.
// This injects a small `current date and time` section every turn, mirroring
// the sibling display-mode / available-spaces hooks. Fail-soft: any error just
// skips the section rather than breaking the chat surface.

const CURRENT_DATETIME_TRANSIENT_HEADING = "current date and time";
const CURRENT_DATETIME_TRANSIENT_KEY = "current-datetime";

function readRuntimeMode() {
  try {
    const mode = document?.documentElement?.getAttribute?.("data-runtime");
    return typeof mode === "string" && mode.trim() ? mode.trim() : "";
  } catch {
    return "";
  }
}

function buildCurrentDateTimeTransientSection() {
  const now = new Date();
  let timeZone = "";
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    timeZone = "";
  }

  const date = now.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });
  const time = now.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit"
  });

  const lines = [
    `today is ${date}`,
    timeZone ? `local time is ${time} (${timeZone})` : `local time is ${time}`,
    `iso timestamp is ${now.toISOString()}`
  ];

  const runtimeMode = readRuntimeMode();
  if (runtimeMode) {
    lines.push(`runtime is ${runtimeMode}`);
  }

  return {
    heading: CURRENT_DATETIME_TRANSIENT_HEADING,
    key: CURRENT_DATETIME_TRANSIENT_KEY,
    order: 1,
    value: lines.join("\n")
  };
}

export default async function injectCurrentDateTimeTransientSection(hookContext) {
  const promptContext = hookContext?.result;

  if (!promptContext) {
    return;
  }

  try {
    promptContext.transientItems = setPromptItem(
      promptContext.transientItems,
      CURRENT_DATETIME_TRANSIENT_KEY,
      buildCurrentDateTimeTransientSection()
    );
  } catch (error) {
    console.error("[onscreen_agent] current date/time transient failed", error);
  }
}
