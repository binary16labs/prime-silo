export const API_BASE_URL = 'http://localhost:8005';

// Q0: no shipped default key. The normal path is the shell proxy, which injects
// credentials server-side; direct-connect dev sets VITE_BENNY_API_KEY. When no
// key is configured the header is omitted entirely (never an empty credential).
const API_KEY: string = (import.meta as any).env?.VITE_BENNY_API_KEY ?? '';
export const GOVERNANCE_HEADERS: Record<string, string> = API_KEY
  ? { 'X-Benny-API-Key': API_KEY }
  : {};

// Feature flags (UX-REC-001, KG3D-001)
export const UI_FLAGS = {
  kg3d_enabled: true,
  kg3d_webxr_enabled: false,
};
