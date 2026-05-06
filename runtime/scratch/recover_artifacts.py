import json
import os

registry_path = 'f:/optimus/workspace/test/runs/task_registry.json'
run_id = 'run-70976b46696b'

with open(registry_path, 'r', encoding='utf-8') as f:
    data = json.load(f)

run_data = data.get(run_id, {})
event_log = run_data.get('event_log', [])

tasks = {}
current_task = None

for e in event_log:
    event_type = e.get('type')
    data_payload = e.get('data', {})
    
    if event_type == 'node_started':
        node_name = data_payload.get('nodeName', '')
        if 'Executor: Task' in node_name:
            current_task = node_name.split('Task ')[1]
    
    elif event_type == 'node_completed':
        if current_task:
            tasks[current_task] = data_payload.get('output')
            current_task = None

# Create output directory
output_base = 'f:/optimus/workspace/test/data_out_recovered'
os.makedirs(output_base, exist_ok=True)

# Map tasks to files
file_map = {
    'task_0_vision': 'prd/architecture_vision.md',
    'task_1_business': 'features/business_logic.feature',
    'task_2_info_systems': 'contracts/models.py',
    'task_3_technology': 'tech/stack_recommendation.md',
    'task_4_implement': 'src/poc_engine.py',
    'task_5_review': 'reports/quality_review.md'
}

for task_id, content in tasks.items():
    if not content: continue
    
    # Also handle the PII sub-tasks by giving them a generic name
    if task_id in file_map:
        rel_path = file_map[task_id]
    else:
        rel_path = f"pii_research/{task_id.replace('.', '_')}.md"
        
    full_path = os.path.join(output_base, rel_path)
    os.makedirs(os.path.dirname(full_path), exist_ok=True)
    
    with open(full_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"Recovered: {rel_path}")
