import React, { useState, useEffect } from 'react';
import { useWorkspaceStore } from '../../hooks/useWorkspaceStore';
import { Activity, Clock, Terminal, ChevronDown, ChevronUp } from 'lucide-react';
import { GOVERNANCE_HEADERS } from '../../constants';

interface AEREntry {
    timestamp: string;
    intent: string;
    observation: string;
    inference: string;
    plan: string;
}

interface Task {
    task_id: string;
    type: string;
    status: string;
    progress: number;
    message: string;
    aer_log: AEREntry[];
    updated_at: string;
}

const WorkspaceActivityLog: React.FC = () => {
    const { currentWorkspace } = useWorkspaceStore();
    const [tasks, setTasks] = useState<Task[]>([]);
    const [expandedTask, setExpandedTask] = useState<string | null>(null);

    const fetchTasks = async () => {
        try {
            // Cognitive Mesh: Secure governance call with X-Benny-API-Key
            const response = await fetch(`/api/tasks?workspace=${currentWorkspace}`, {
                headers: { ...GOVERNANCE_HEADERS }
            });
            if (!response.ok) return;
            const data = await response.json();
            setTasks(Array.isArray(data) ? data : []);
        } catch (error) {
            console.log('Log fetch failed:', error);
        }
    };

    useEffect(() => {
        if (currentWorkspace) {
            fetchTasks();
            const interval = setInterval(fetchTasks, 3000);
            return () => clearInterval(interval);
        }
    }, [currentWorkspace]);

    if (tasks.length === 0) {
        return (
            <div className="p-8 text-center text-secondary bg-surface/30 rounded-xl border border-dashed border-white/5">
                <Activity className="mx-auto mb-2 opacity-10" size={32} />
                <p className="text-xs italic">No reasoning traces recorded in this workspace.</p>
            </div>
        );
    }

    return (
        <div className="workspace-activity-log p-2 space-y-3 overflow-y-auto max-h-full scrollbar-hidden">
            <div className="text-[10px] uppercase tracking-widest text-primary font-bold px-2 py-1 bg-primary/5 inline-block rounded mb-1">
                Active Reasoning Provencance
            </div>
            
            {tasks.slice().reverse().map(task => (
                <div key={task.task_id} className="card-glass overflow-hidden border border-white/10 rounded-xl bg-white/5 transition-all">
                    <div 
                        className="p-3 flex items-center justify-between cursor-pointer hover:bg-white/10"
                        onClick={() => setExpandedTask(expandedTask === task.task_id ? null : task.task_id)}
                    >
                        <div className="flex items-center gap-3">
                            <div className={`w-2 h-2 rounded-full ${task.status === 'running' ? 'bg-primary animate-pulse shadow-[0_0_8px_rgba(var(--primary-rgb),0.8)]' : task.status === 'completed' ? 'bg-green-500' : 'bg-red-500'}`} />
                            <div>
                                <div className="text-[11px] font-bold text-white uppercase tracking-tight">{task.type.replace('_', ' ')}</div>
                                <div className="text-[10px] text-gray-500 font-mono truncate max-w-[150px]">{task.message}</div>
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="text-[10px] font-mono text-gray-400 bg-black/40 px-1.5 py-0.5 rounded">{task.progress}%</span>
                            {expandedTask === task.task_id ? <ChevronUp size={12} className="text-gray-500" /> : <ChevronDown size={12} className="text-gray-500" />}
                        </div>
                    </div>

                    {expandedTask === task.task_id && (
                        <div className="px-3 pb-3 bg-black/30 border-t border-white/5 pt-3">
                            <div className="text-[9px] uppercase tracking-wider text-gray-500 mb-3 flex items-center gap-1.5">
                                <Terminal size={10} className="text-primary" /> Trace Frames
                            </div>
                            
                            <div className="space-y-4 relative before:absolute before:left-1.5 before:top-2 before:bottom-2 before:w-[1.5px] before:bg-gradient-to-b before:from-primary/50 before:to-transparent">
                                {task.aer_log.length === 0 ? (
                                    <div className="pl-5 text-[10px] text-gray-600 italic">No frames emitted yet.</div>
                                ) : task.aer_log.slice().reverse().map((entry, i) => (
                                    <div key={i} className="pl-5 relative group">
                                        <div className="absolute left-[0.5px] top-1.5 w-2 h-2 rounded-full bg-surface border border-primary group-first:bg-primary z-10" />
                                        <div className="text-[9px] text-gray-600 flex items-center gap-1 mb-1 font-mono">
                                            <Clock size={8} /> {new Date(entry.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'})}
                                        </div>
                                        <div className="text-[11px] text-gray-100 font-semibold leading-tight">{entry.intent}</div>
                                        <div className="text-[10px] text-gray-500 mt-1 leading-relaxed bg-white/5 p-2 rounded-lg border border-white/5">{entry.observation}</div>
                                        
                                        {entry.plan && (
                                            <div className="mt-2 p-2 bg-primary/10 border border-primary/20 rounded-lg text-[9px] text-primary flex items-start gap-2">
                                                <span className="font-bold whitespace-nowrap opacity-60">NEXT_PLAN:</span>
                                                <span className="opacity-90">{entry.plan}</span>
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                    
                    <div className="h-0.5 w-full bg-gray-800">
                        <div className="h-full bg-gradient-to-r from-primary to-blue-500 transition-all duration-1000 ease-out" style={{ width: `${task.progress}%` }} />
                    </div>
                </div>
            ))}
            
            <div className="pt-4 text-center">
                <button 
                  onClick={fetchTasks}
                  className="text-[9px] text-gray-600 uppercase tracking-tighter hover:text-primary transition-colors"
                >
                    -- FORCE MESH SYNC --
                </button>
            </div>
        </div>
    );
};

export default WorkspaceActivityLog;
