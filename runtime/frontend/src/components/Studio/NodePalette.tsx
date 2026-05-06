import { 
  Play, 
  MessageSquare, 
  Clock, 
  Webhook,
  Brain,
  Bot,
  Wrench,
  GitBranch,
  ArrowRightLeft,
  Repeat,
  FileText,
  Database,
  Search,
  Download,
  Globe
} from 'lucide-react';

const nodeCategories = [
  {
    title: 'Triggers',
    items: [
      { type: 'trigger', label: 'Manual Trigger', icon: Play },
      { type: 'trigger', label: 'Chat Input', icon: MessageSquare },
      { type: 'trigger', label: 'Schedule', icon: Clock },
      { type: 'trigger', label: 'Webhook', icon: Webhook },
    ],
  },
  {
    title: 'AI / LLM',
    items: [
      { type: 'llm', label: 'LLM', icon: Brain },
      { type: 'llm', label: 'Agent (with skills)', icon: Bot },
      { type: 'tool', label: 'Tool Executor', icon: Wrench },
      { type: 'a2a', label: '🌐 A2A Agent', description: 'Delegate to external agent', icon: Globe },
    ],
  },
  {
    title: 'Logic',
    items: [
      { type: 'logic', label: 'If/Else', icon: GitBranch },
      { type: 'logic', label: 'Switch', icon: ArrowRightLeft },
      { type: 'logic', label: 'Loop', icon: Repeat },
    ],
  },
  {
    title: 'Data',
    items: [
      { type: 'data', label: 'Read File', icon: FileText },
      { type: 'data', label: 'Write File', icon: Download },
      { type: 'data', label: 'Search KB', icon: Search },
      { type: 'data', label: 'Database', icon: Database },
    ],
  },
];

export default function NodePalette() {
  const onDragStart = (event: React.DragEvent, type: string, label: string) => {
    event.dataTransfer.setData('application/reactflow/type', type);
    event.dataTransfer.setData('application/reactflow/label', label);
    event.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div className="node-palette">
      {nodeCategories.map((category) => (
        <div key={category.title} className="palette-section">
          <div className="palette-section-title">{category.title}</div>
          {category.items.map((item) => (
            <div
              key={`${item.type}-${item.label}`}
              className="palette-item"
              draggable
              onDragStart={(e) => onDragStart(e, item.type, item.label)}
            >
              <div className={`palette-icon ${item.type}`}>
                <item.icon size={16} />
              </div>
              <span className="palette-item-label">{item.label}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
