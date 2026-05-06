#!/usr/bin/env python3
"""
Benny Audit Debug CLI - Command-line tool for investigating execution failures
"""

import sys
import json
import argparse
from pathlib import Path
from typing import Optional

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from benny.governance.execution_audit import (
    retrieve_execution_audit,
    get_failed_nodes,
    generate_execution_report
)

def print_header(title: str, width: int = 80):
    """Print a formatted header."""
    print(f"\n{'=' * width}")
    print(f"{title.center(width)}")
    print(f"{'=' * width}\n")

def cmd_audit_summary(execution_id: str, workspace: str):
    """Show audit summary for an execution."""
    print_header(f"Execution Audit Summary: {execution_id}")
    
    audit = retrieve_execution_audit(execution_id, workspace, include_nodes=True, include_checkpoints=True)
    
    print(f"Status:         {audit.get('status', 'unknown').upper()}")
    print(f"Workspace:      {workspace}")
    print(f"Total Events:   {audit['summary'].get('total_events', 0)}")
    print(f"Failures:       {audit['summary'].get('failure_count', 0)}")
    print(f"Nodes Failed:   {len([n for n in audit.get('node_states', []) if n.get('data', {}).get('status') == 'failed'])}")
    print(f"Nodes Executed: {audit['summary'].get('node_count', 0)}")
    
    phases = audit['summary'].get('execution_phases', [])
    if phases:
        print(f"Execution Phases: {', '.join(phases)}")
    
    if audit.get('first_error'):
        print(f"\nFirst Error:")
        print(f"  Phase:   {audit['first_error'].get('phase', 'unknown')}")
        print(f"  Message: {audit['first_error'].get('message', 'unknown')}")

def cmd_failures(execution_id: str, workspace: str):
    """Show all failures for an execution."""
    print_header(f"Execution Failures: {execution_id}")
    
    audit = retrieve_execution_audit(execution_id, workspace, include_nodes=False)
    failures = audit.get('failures', [])
    
    if not failures:
        print("No failures recorded.")
        return
    
    for i, failure in enumerate(failures, 1):
        error_data = failure.get("data", {})
        print(f"Failure #{i}")
        print(f"  Timestamp:   {error_data.get('timestamp', 'unknown')}")
        print(f"  Phase:       {error_data.get('phase', 'unknown')}")
        print(f"  Node:        {error_data.get('node_id', 'N/A')}")
        print(f"  Error Type:  {error_data.get('error', {}).get('type', 'unknown')}")
        print(f"  Message:     {error_data.get('error', {}).get('message', 'unknown')}")
        
        stack_trace = error_data.get('error', {}).get('stack_trace', '')
        if stack_trace:
            print(f"  Stack Trace:")
            for line in stack_trace.split('\n')[:10]:  # Show first 10 lines
                print(f"    {line}")
            if len(stack_trace.split('\n')) > 10:
                print(f"    ... ({len(stack_trace.split(chr(10))) - 10} more lines)")
        
        print()

def cmd_nodes(execution_id: str, workspace: str):
    """Show node execution details."""
    print_header(f"Node Execution Details: {execution_id}")
    
    audit = retrieve_execution_audit(execution_id, workspace, include_nodes=True, include_checkpoints=False)
    node_states = audit.get('node_states', [])
    
    if not node_states:
        print("No node execution records found.")
        return
    
    # Group by status
    by_status = {"completed": [], "failed": [], "other": []}
    for node_event in node_states:
        node_data = node_event.get("data", {})
        status = node_data.get("status")
        if status == "completed":
            by_status["completed"].append(node_data)
        elif status == "failed":
            by_status["failed"].append(node_data)
        else:
            by_status["other"].append(node_data)
    
    # Print completed nodes
    if by_status["completed"]:
        print("COMPLETED NODES:")
        for node in by_status["completed"]:
            print(f"  • {node.get('node_id', 'unknown')}")
            print(f"    Duration: {node.get('duration_ms', 0)}ms")
            if node.get('outputs'):
                print(f"    Output: {str(node['outputs'])[:100]}...")
        print()
    
    # Print failed nodes
    if by_status["failed"]:
        print("FAILED NODES:")
        for node in by_status["failed"]:
            print(f"  • {node.get('node_id', 'unknown')}")
            print(f"    Error: {node.get('error', 'unknown')}")
            if node.get('inputs'):
                print(f"    Inputs: {str(node['inputs'])[:100]}...")
        print()

def cmd_report(execution_id: str, workspace: str, output_file: Optional[str] = None):
    """Generate and display/save full execution report."""
    report = generate_execution_report(execution_id, workspace)
    
    if output_file:
        Path(output_file).write_text(report, encoding='utf-8')
        print(f"Report saved to: {output_file}")
    else:
        print(report)

def cmd_json(execution_id: str, workspace: str, output_file: Optional[str] = None):
    """Export full audit as JSON."""
    audit = retrieve_execution_audit(execution_id, workspace, include_nodes=True, include_checkpoints=True)
    
    json_output = json.dumps(audit, indent=2, default=str)
    
    if output_file:
        Path(output_file).write_text(json_output, encoding='utf-8')
        print(f"JSON audit saved to: {output_file}")
    else:
        print(json_output)

def main():
    parser = argparse.ArgumentParser(
        description="Benny Audit Debug CLI - Investigate execution failures",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s summary run-61fa6ccb -w test4
  %(prog)s failures run-61fa6ccb -w test4
  %(prog)s nodes run-61fa6ccb -w test4
  %(prog)s report run-61fa6ccb -w test4 -o report.txt
  %(prog)s json run-61fa6ccb -w test4 -o audit.json
        """
    )
    
    subparsers = parser.add_subparsers(dest="command", help="Command to run")
    
    # Summary command
    summary_parser = subparsers.add_parser("summary", help="Show audit summary")
    summary_parser.add_argument("execution_id", help="Execution ID to analyze")
    summary_parser.add_argument("-w", "--workspace", default="default", help="Workspace (default: default)")
    summary_parser.set_defaults(func=lambda args: cmd_audit_summary(args.execution_id, args.workspace))
    
    # Failures command
    failures_parser = subparsers.add_parser("failures", help="Show all failures")
    failures_parser.add_argument("execution_id", help="Execution ID to analyze")
    failures_parser.add_argument("-w", "--workspace", default="default", help="Workspace (default: default)")
    failures_parser.set_defaults(func=lambda args: cmd_failures(args.execution_id, args.workspace))
    
    # Nodes command
    nodes_parser = subparsers.add_parser("nodes", help="Show node execution details")
    nodes_parser.add_argument("execution_id", help="Execution ID to analyze")
    nodes_parser.add_argument("-w", "--workspace", default="default", help="Workspace (default: default)")
    nodes_parser.set_defaults(func=lambda args: cmd_nodes(args.execution_id, args.workspace))
    
    # Report command
    report_parser = subparsers.add_parser("report", help="Generate full report")
    report_parser.add_argument("execution_id", help="Execution ID to analyze")
    report_parser.add_argument("-w", "--workspace", default="default", help="Workspace (default: default)")
    report_parser.add_argument("-o", "--output", help="Save report to file")
    report_parser.set_defaults(func=lambda args: cmd_report(args.execution_id, args.workspace, args.output))
    
    # JSON command
    json_parser = subparsers.add_parser("json", help="Export full audit as JSON")
    json_parser.add_argument("execution_id", help="Execution ID to analyze")
    json_parser.add_argument("-w", "--workspace", default="default", help="Workspace (default: default)")
    json_parser.add_argument("-o", "--output", help="Save JSON to file")
    json_parser.set_defaults(func=lambda args: cmd_json(args.execution_id, args.workspace, args.output))
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        return 1
    
    try:
        args.func(args)
        return 0
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

if __name__ == "__main__":
    sys.exit(main())
