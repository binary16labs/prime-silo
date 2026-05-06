import { create } from 'zustand';
import { createWorkflowSlice } from './slices/workflowSlice';
import type { WorkflowSlice } from './slices/workflowSlice';

import { createExecutionSlice } from './slices/executionSlice';
import type { ExecutionSlice, HITLRequest, ExecutionEvent, AERTrace } from './slices/executionSlice';

import { createUISlice } from './slices/uiSlice';
import type { UISlice, UIVersion, ViewMode } from './slices/uiSlice';

export type { HITLRequest, ExecutionEvent, AERTrace, UIVersion, ViewMode };

type StoreState = WorkflowSlice & ExecutionSlice & UISlice;

export const useWorkflowStore = create<StoreState>((set, get) => ({
  ...createWorkflowSlice(set, get),
  ...createExecutionSlice(set, get),
  ...createUISlice(set, get),
}));


