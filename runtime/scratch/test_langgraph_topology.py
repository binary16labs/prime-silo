from langgraph.graph import StateGraph, START, END
from typing import TypedDict, Annotated, List
import operator

class State(TypedDict):
    messages: Annotated[List[str], operator.add]

def node_a(state: State):
    return {"messages": ["a"]}

def node_b(state: State):
    return {"messages": ["b"]}

builder = StateGraph(State)
builder.add_node("a", node_a)
builder.add_node("b", node_b)
builder.add_edge(START, "a")
builder.add_edge("a", "b")
builder.add_edge("b", END)

# Extract topology
print("Nodes:", list(builder.nodes.keys()))

compiled_graph = builder.compile()
print("Edges:")
for edge in compiled_graph.get_graph().edges:
    print(f"  {edge.source} -> {edge.target}")

