import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { API_BASE_URL, GOVERNANCE_HEADERS } from '../constants';

interface ProviderStatus {
  name: string;
  running: boolean;
  port: number;
  description: string;
  can_start: boolean;
  can_stop: boolean;
  models?: any;
}

export function useLLMStatus(pollInterval: number = 10000) {
  const queryClient = useQueryClient();

  const { data: providers = {}, isLoading: loading, error, refetch: refresh } = useQuery({
    queryKey: ['llmStatus'],
    queryFn: async (): Promise<Record<string, ProviderStatus>> => {
      const resp = await fetch(`${API_BASE_URL}/api/llm/status`, {
        headers: { ...GOVERNANCE_HEADERS }
      });
      if (!resp.ok) throw new Error('API not available');
      return resp.json();
    },
    refetchInterval: pollInterval,
  });

  const startMutation = useMutation({
    mutationFn: async (provider: string) => {
      await fetch(`${API_BASE_URL}/api/llm/${provider}/start`, { 
        method: 'POST',
        headers: { ...GOVERNANCE_HEADERS }
      });
    },
    onSuccess: () => {
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ['llmStatus'] }), 2000);
    }
  });

  const stopMutation = useMutation({
    mutationFn: async (provider: string) => {
      await fetch(`${API_BASE_URL}/api/llm/${provider}/stop`, { 
        method: 'POST',
        headers: { ...GOVERNANCE_HEADERS }
      });
    },
    onSuccess: () => {
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ['llmStatus'] }), 1000);
    }
  });

  return {
    providers,
    loading,
    error: error ? error.message : null,
    refresh,
    startProvider: (provider: string) => startMutation.mutate(provider),
    stopProvider: (provider: string) => stopMutation.mutate(provider),
  };
}
