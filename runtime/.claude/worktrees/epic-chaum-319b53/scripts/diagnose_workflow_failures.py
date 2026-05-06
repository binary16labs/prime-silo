#!/usr/bin/env python3
"""
Benny Workflow Execution Diagnostics Script
Helps verify the failure tracking and reporting system is working correctly
"""

import json
import requests
from pathlib import Path
from datetime import datetime
import sys

# Configuration
BASE_URL = "http://localhost:8005"
WORKSPACE = "test4"
AUDIT_LOG_PATH = Path("workspace/test4/runs/audit.log")
TASK_REGISTRY_PATH = Path("workspace/test4/runs/task_registry.json")

def check_audit_log():
    """Check audit log for failure events"""
    print("\n=== CHECKING AUDIT LOG ===")
    if not AUDIT_LOG_PATH.exists():
        print("❌ Audit log not found")
        return []
    
    failure_events = []
    with open(AUDIT_LOG_PATH, 'r') as f:
        for line_num, line in enumerate(f, 1):
            try:
                event = json.loads(line.strip())
                if event.get("event_type") in ["EXECUTION_FAILURE", "TASK_METADATA_UPDATE"]:
                    failure_events.append(event)
                    if event.get("event_type") == "EXECUTION_FAILURE":
                        print(f"✓ Found EXECUTION_FAILURE at line {line_num}")
                        print(f"  Error: {event.get('data', {}).get('error', {}).get('message', 'N/A')}")
            except json.JSONDecodeError:
                continue
    
    if not failure_events:
        print("⚠️  No failure events found in audit log")
    return failure_events

def check_task_registry():
    """Check task registry for failed tasks"""
    print("\n=== CHECKING TASK REGISTRY ===")
    if not TASK_REGISTRY_PATH.exists():
        print("❌ Task registry not found")
        return []
    
    with open(TASK_REGISTRY_PATH, 'r') as f:
        registry = json.load(f)
    
    failed_tasks = []
    for task_id, task_data in registry.items():
        if task_data.get("type") == "studio_workflow" and task_data.get("status") == "failed":
            failed_tasks.append((task_id, task_data))
            print(f"✓ Found failed task: {task_id}")
            print(f"  Status: {task_data.get('status')}")
            print(f"  Message: {task_data.get('message') or '(empty)'}")
            print(f"  Created: {task_data.get('created_at')}")
    
    if not failed_tasks:
        print("⚠️  No failed studio workflows found in task registry")
    return failed_tasks

def test_report_endpoint(run_id):
    """Test the execution report endpoint"""
    print(f"\n=== TESTING REPORT ENDPOINT FOR {run_id} ===")
    try:
        url = f"{BASE_URL}/api/governance/execution/{run_id}/report?workspace={WORKSPACE}"
        print(f"GET {url}")
        response = requests.get(url, timeout=5)
        
        if response.status_code == 200:
            data = response.json()
            report = data.get("report", "")
            if report:
                print("✓ Report endpoint returned data!")
                print(f"\nReport Preview (first 500 chars):\n{report[:500]}")
                return True
            else:
                print("⚠️  Report endpoint returned empty report")
                return False
        else:
            print(f"❌ Report endpoint returned status {response.status_code}")
            print(f"Response: {response.text}")
            return False
    except requests.exceptions.ConnectionError:
        print("❌ Could not connect to Benny API")
        return False
    except Exception as e:
        print(f"❌ Error testing endpoint: {str(e)}")
        return False

def test_failures_endpoint(run_id):
    """Test the failures endpoint"""
    print(f"\n=== TESTING FAILURES ENDPOINT FOR {run_id} ===")
    try:
        url = f"{BASE_URL}/api/governance/execution/{run_id}/failures?workspace={WORKSPACE}"
        print(f"GET {url}")
        response = requests.get(url, timeout=5)
        
        if response.status_code == 200:
            data = response.json()
            failure_count = data.get("failure_count", 0)
            if failure_count > 0:
                print(f"✓ Found {failure_count} failure(s)!")
                print(f"Status: {data.get('status')}")
                print(f"First error: {data.get('first_error')}")
                return True
            else:
                print("⚠️  No failures recorded in system")
                return False
        else:
            print(f"❌ Failures endpoint returned status {response.status_code}")
            return False
    except Exception as e:
        print(f"❌ Error testing endpoint: {str(e)}")
        return False

def main():
    print("=" * 70)
    print("Benny Workflow Execution Diagnostics")
    print(f"Timestamp: {datetime.now().isoformat()}")
    print(f"Workspace: {WORKSPACE}")
    print(f"Base URL: {BASE_URL}")
    print("=" * 70)
    
    # Check audit log
    failure_events = check_audit_log()
    
    # Check task registry
    failed_tasks = check_task_registry()
    
    # If we have failed tasks, test the report endpoints
    if failed_tasks:
        latest_failed = max(failed_tasks, key=lambda x: x[1].get('created_at', ''))
        run_id = latest_failed[0]
        print(f"\nTesting latest failed workflow: {run_id}")
        
        test_report_endpoint(run_id)
        test_failures_endpoint(run_id)
    
    # Summary
    print("\n" + "=" * 70)
    print("SUMMARY")
    print("=" * 70)
    print(f"Failure events in audit log: {sum(1 for e in failure_events if e.get('event_type') == 'EXECUTION_FAILURE')}")
    print(f"Failed studio workflows: {len(failed_tasks)}")
    
    if not failed_tasks:
        print("\n✓ No failed workflows to diagnose")
    elif sum(1 for e in failure_events if e.get('event_type') == 'EXECUTION_FAILURE') == 0:
        print("\n⚠️  BUG STILL EXISTS: Failed tasks found but no EXECUTION_FAILURE events!")
        print("    → The fix may not be properly deployed")
        return 1
    else:
        print("\n✓ Failure tracking appears to be working correctly!")
        return 0
    
    return 0

if __name__ == "__main__":
    sys.exit(main())
