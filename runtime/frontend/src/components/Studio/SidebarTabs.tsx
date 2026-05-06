import React from 'react';
import { Layers, Bot, LayoutGrid, FileCode } from 'lucide-react';

interface SidebarTabsProps {
  activeTab: 'flows' | 'agents' | 'nodes' | 'sources';
  onTabChange: (tab: 'flows' | 'agents' | 'nodes' | 'sources') => void;
}

export default function SidebarTabs({ activeTab, onTabChange }: SidebarTabsProps) {
  const tabs = [
    { id: 'flows', label: 'Flows', icon: Layers },
    { id: 'agents', label: 'Agents', icon: Bot },
    { id: 'nodes', label: 'Nodes', icon: LayoutGrid },
    { id: 'sources', label: 'Sources', icon: FileCode },
  ] as const;

  return (
    <div className="sidebar-tabs">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className={`sidebar-tab-btn ${activeTab === tab.id ? 'active' : ''}`}
          onClick={() => onTabChange(tab.id)}
          title={tab.label}
        >
          <tab.icon size={16} />
          {tab.label}
        </button>
      ))}
    </div>
  );
}
