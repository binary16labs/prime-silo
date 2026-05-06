import xml.etree.ElementTree as ET
from typing import List, Dict, Any
import uuid

def json_to_bpmn(nodes: List[Dict], edges: List[Dict], process_name: str = "BennyProcess") -> str:
    """
    Converts Studio ReactFlow JSON metadata to valid BPMN 2.0 XML.
    
    Mapping Strategy:
    - trigger -> bpmn:startEvent
    - llm     -> bpmn:serviceTask (Agentic Task)
    - logic   -> bpmn:exclusiveGateway
    - data    -> bpmn:manualTask (or DataStoreReference)
    - default -> bpmn:task
    """
    # Namespaces
    BPMN = "http://www.omg.org/spec/BPMN/20100524/MODEL"
    BPMNDI = "http://www.omg.org/spec/BPMN/20100524/DI"
    DC = "http://www.omg.org/spec/DD/20100524/DC"
    DI = "http://www.omg.org/spec/DD/20100524/DI"
    
    ET.register_namespace('bpmn', BPMN)
    ET.register_namespace('bpmndi', BPMNDI)
    ET.register_namespace('dc', DC)
    ET.register_namespace('di', DI)
    
    root = ET.Element(f"{{{BPMN}}}definitions", {
        "xmlns:bpmn": BPMN,
        "xmlns:bpmndi": BPMNDI,
        "xmlns:dc": DC,
        "xmlns:di": DI,
        "targetNamespace": "http://bpmn.io/schema/bpmn",
        "exporter": "Benny Cognitive Mesh",
        "exporterVersion": "1.0.0"
    })
    
    process_id = f"Process_{str(uuid.uuid4())[:8]}"
    process = ET.SubElement(root, f"{{{BPMN}}}process", {
        "id": process_id,
        "name": process_name,
        "isExecutable": "true"
    })
    
    # 1. Map Nodes to BPMN Elements
    node_to_bpmn_id = {}
    
    for node in nodes:
        node_id = str(node.get("id"))
        node_type = node.get("type", "task")
        name = (node.get("data") or {}).get("label", node_id)
        
        # Ensure ID is XML compatible (no hyphens for some tools, use underscores)
        bpmn_id = f"{node_type}_{node_id.replace('-', '_')}"
        node_to_bpmn_id[node_id] = bpmn_id
        
        if node_type == "trigger":
            element = ET.SubElement(process, f"{{{BPMN}}}startEvent", {"id": bpmn_id, "name": name})
        elif node_type == "llm":
            # LLM Agents are mapped to ServiceTasks in BPMN 2.0
            element = ET.SubElement(process, f"{{{BPMN}}}serviceTask", {"id": bpmn_id, "name": name})
        elif node_type == "logic":
            element = ET.SubElement(process, f"{{{BPMN}}}exclusiveGateway", {"id": bpmn_id, "name": name})
        elif node_type == "data":
            element = ET.SubElement(process, f"{{{BPMN}}}manualTask", {"id": bpmn_id, "name": name})
        else:
            element = ET.SubElement(process, f"{{{BPMN}}}task", {"id": bpmn_id, "name": name})

    # 2. Map Edges to Sequence Flows
    for i, edge in enumerate(edges):
        source_id = node_to_bpmn_id.get(str(edge.get("source")))
        target_id = node_to_bpmn_id.get(str(edge.get("target")))
        
        if source_id and target_id:
            flow_id = f"Flow_{i}_{str(uuid.uuid4())[:4]}"
            flow = ET.SubElement(process, f"{{{BPMN}}}sequenceFlow", {
                "id": flow_id,
                "sourceRef": source_id,
                "targetRef": target_id
            })
            
            # Link flow to nodes (optional but good for some exporters)
            # Find the source element to add the outgoing flow reference
            for el in process:
                if el.get("id") == source_id:
                    outgoing = ET.SubElement(el, f"{{{BPMN}}}outgoing")
                    outgoing.text = flow_id
                if el.get("id") == target_id:
                    incoming = ET.SubElement(el, f"{{{BPMN}}}incoming")
                    incoming.text = flow_id

    # 3. Add simplistic BPMNDI (Diagram Interchange) - Required for some viewers
    # Note: We don't have absolute layout coords for all tools, so we emit a stub
    collaboration = ET.SubElement(root, f"{{{BPMNDI}}}BPMNDiagram", {"id": "BPMNDiagram_1"})
    plane = ET.SubElement(collaboration, f"{{{BPMNDI}}}BPMNPlane", {"id": "BPMNPlane_1", "bpmnElement": process_id})

    # Return as pretty-ish string
    xml_str = ET.tostring(root, encoding='utf-8', xml_declaration=True).decode('utf-8')
    return xml_str
