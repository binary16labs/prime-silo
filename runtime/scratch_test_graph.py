import asyncio
import logging
from typing import TypedDict, Annotated, List, Dict, Any
import operator
from langgraph.graph import StateGraph, START, END
from langgraph.checkpoint.memory import MemorySaver

logging.basicConfig(level=logging.INFO)

class State(TypedDict):
    messages: Annotated[List[str], operator.add]
    status: str

def node1(state: State):
    print("DEBUG: Node 1")
    return {"messages": ["node1"], "status": "running"}

async def main():
    graph = StateGraph(State)
    graph.add_node("node1", node1)
    graph.add_edge(START, "node1")
    graph.add_edge("node1", END)
    
    app = graph.compile(checkpointer=MemorySaver())
    
    config = {"configurable": {"thread_id": "test"}}
    state = {"messages": [], "status": "pending"}
    
    print("Starting ainvoke...")
    result = await app.ainvoke(state, config)
    print(f"Finished: {result}")

if __name__ == "__main__":
    asyncio.run(main())
