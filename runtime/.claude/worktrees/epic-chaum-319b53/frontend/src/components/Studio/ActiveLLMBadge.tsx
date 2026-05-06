import { useWorkspaceStore } from '../../hooks/useWorkspaceStore';
import { useLLMStatus } from '../../hooks/useLLMStatus';
import { Cpu } from 'lucide-react';

interface ActiveLLMBadgeProps {
  onNavigateToLLM?: () => void;
}

export default function ActiveLLMBadge({ onNavigateToLLM }: ActiveLLMBadgeProps) {
  const { activeLLMProvider, activeLLMModels } = useWorkspaceStore();
  const { providers } = useLLMStatus(10000);

  const provider = providers[activeLLMProvider];
  const isRunning = provider?.running ?? false;
  const providerName = provider?.name ?? activeLLMProvider;
  const activeModel = activeLLMModels[activeLLMProvider];

  // Truncate model name for display
  const displayModel = activeModel
    ? activeModel.length > 28
      ? '…' + activeModel.slice(-26)
      : activeModel
    : 'No model selected';

  return (
    <button
      className="active-llm-badge"
      onClick={onNavigateToLLM}
      title={`Active: ${providerName} — ${activeModel || 'none'}\nClick to open LLM Management`}
    >
      <div className={`active-llm-status-dot ${isRunning ? 'running' : 'stopped'}`} />
      <Cpu size={14} />
      <span className="active-llm-provider">{providerName}</span>
      <span className="active-llm-separator">·</span>
      <span className="active-llm-model">{displayModel}</span>
    </button>
  );
}
