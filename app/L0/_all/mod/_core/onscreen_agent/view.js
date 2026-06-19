import * as execution from "/mod/_core/onscreen_agent/execution.js";
import { formatAttachmentSize } from "/mod/_core/onscreen_agent/attachments.js";
import { createAgentThreadView } from "/mod/_core/visual/conversation/thread-view.js";

const threadView = createAgentThreadView({
  assistantAvatarPath: "/mod/_core/visual/res/chat/overlay/dog_head_256.svg",
  assistantMarkdownClassName: "onscreen-agent-response-markdown",
  autoResizeMaxHeight: 120,
  emptyStateText: "Send a message to start the onscreen agent thread.",
  execution,
  formatAttachmentSize,
  groupConsecutiveAvatars: true,
  renderMarkdownWithMarked: true
});

export const autoResizeTextarea = threadView.autoResizeTextarea;
export const copyTextToClipboard = threadView.copyTextToClipboard;
export const findExecuteSection = threadView.findExecuteSection;
export const getAssistantMessageCopyText = threadView.getAssistantMessageCopyText;
export const getTerminalInputText = threadView.getTerminalInputText;
export const getTerminalOutputText = threadView.getTerminalOutputText;
export const renderMessages = threadView.renderMessages;
export const summarizeLlmConfig = threadView.summarizeLlmConfig;
export const summarizeSystemPrompt = threadView.summarizeSystemPrompt;
export const updateStreamingAssistantMessage = threadView.updateStreamingAssistantMessage;
