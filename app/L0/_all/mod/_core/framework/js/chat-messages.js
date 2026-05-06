function normalizeChatMessage(message) {
  if (!message || typeof message !== "object") {
    return null;
  }

  const role = typeof message.role === "string" ? message.role.trim() : "";

  if (!["system", "user", "assistant"].includes(role)) {
    return null;
  }

  return {
    ...message,
    content: typeof message.content === "string" ? message.content : "",
    role
  };
}

function joinMessageContent(left = "", right = "") {
  return [left, right].filter((content) => typeof content === "string" && content.length).join("\n\n");
}

export function mergeConsecutiveChatMessages(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .map((message) => normalizeChatMessage(message))
    .filter(Boolean)
    .reduce((mergedMessages, message) => {
      const previousMessage = mergedMessages[mergedMessages.length - 1];

      if (
        previousMessage &&
        previousMessage.role === message.role &&
        ["user", "assistant"].includes(message.role)
      ) {
        previousMessage.content = joinMessageContent(previousMessage.content, message.content);
        return mergedMessages;
      }

      mergedMessages.push({
        ...message
      });
      return mergedMessages;
    }, []);
}
