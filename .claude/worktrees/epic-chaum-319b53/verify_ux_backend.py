#!/usr/bin/env python3
"""
Quick verification script to test Workflow Studio UX fixes
"""
import requests
import json

BASE_URL = "http://localhost:8005"

def test_api_endpoints():
    """Test that all required API endpoints are working"""
    
    print("🧪 Testing Workflow Studio APIs...\n")
    
    # Test 1: List workflows
    print("1️⃣ Testing GET /api/workflows")
    try:
        response = requests.get(f"{BASE_URL}/api/workflows")
        if response.status_code == 200:
            workflows = response.json()
            print(f"   ✅ Found {len(workflows)} workflows")
            for wf in workflows:
                print(f"      - {wf['name']} ({wf['type']})")
        else:
            print(f"   ❌ Failed: {response.status_code}")
    except Exception as e:
        print(f"   ❌ Error: {e}")
    
    print()
    
    # Test 2: Get specific workflow
    print("2️⃣ Testing GET /api/workflows/basic_chat")
    try:
        response = requests.get(f"{BASE_URL}/api/workflows/basic_chat")
        if response.status_code == 200:
            workflow = response.json()
            print(f"   ✅ Loaded '{workflow['name']}'")
            print(f"      Nodes: {len(workflow.get('nodes', []))}")
            print(f"      Edges: {len(workflow.get('edges', []))}")
        else:
            print(f"   ❌ Failed: {response.status_code}")
    except Exception as e:
        print(f"   ❌ Error: {e}")
    
    print()
    
    # Test 3: Save workflow
    print("3️⃣ Testing POST /api/workflows")
    test_workflow = {
        "id": "test_ux_verification",
        "name": "UX Test Workflow",
        "description": "Created by verification script",
        "nodes": [
            {
                "id": "node-1",
                "type": "trigger",
                "position": {"x": 100, "y": 100},
                "data": {"label": "Test Node", "config": {}}
            }
        ],
        "edges": []
    }
    
    try:
        response = requests.post(
            f"{BASE_URL}/api/workflows",
            json=test_workflow,
            headers={"Content-Type": "application/json"}
        )
        if response.status_code == 200:
            result = response.json()
            print(f"   ✅ Workflow saved: {result.get('id')}")
        else:
            print(f"   ❌ Failed: {response.status_code}")
            print(f"      Response: {response.text}")
    except Exception as e:
        print(f"   ❌ Error: {e}")
    
    print()
    
    # Test 4: Delete test workflow
    print("4️⃣ Testing DELETE /api/workflows/test_ux_verification")
    try:
        response = requests.delete(f"{BASE_URL}/api/workflows/test_ux_verification")
        if response.status_code == 200:
            print(f"   ✅ Test workflow deleted")
        else:
            print(f"   ⚠️  Status: {response.status_code}")
    except Exception as e:
        print(f"   ❌ Error: {e}")
    
    print()
    
    # Test 5: Check RAG endpoint
    print("5️⃣ Testing POST /api/rag/query")
    try:
        response = requests.post(
            f"{BASE_URL}/api/rag/query",
            json={"query": "test", "workspace": "default"},
            headers={"Content-Type": "application/json"}
        )
        if response.status_code == 200:
            print(f"   ✅ RAG endpoint responding")
        else:
            print(f"   ⚠️  Status: {response.status_code} (may need indexed files)")
    except Exception as e:
        print(f"   ❌ Error: {e}")
    
    print()

    # Test 6: Workspace Management
    print("6️⃣ Testing Workspace APIs")
    try:
        # Create workspace
        ws_name = "test_verification_ws"
        print(f"   Creating workspace '{ws_name}'...")
        response = requests.post(f"{BASE_URL}/api/workspaces/{ws_name}")
        if response.status_code == 200:
            print(f"   ✅ Workspace created")
            
            # List workspaces
            response = requests.get(f"{BASE_URL}/api/workspaces")
            workspaces = response.json()
            # Handle list vs dict response structure if needed
            ws_list = workspaces if isinstance(workspaces, list) else workspaces.get('workspaces', [])
            
            if ws_name in ws_list:
                print(f"   ✅ Workspace found in list: {ws_list}")
            else:
                print(f"   ❌ Workspace not found in list: {ws_list}")
                
            # Verify file isolation (should be empty)
            response = requests.get(f"{BASE_URL}/api/files?workspace={ws_name}")
            files = response.json()
            if len(files.get('data_in', [])) == 0:
                print(f"   ✅ Workspace file list is empty (isolated)")
            else:
                print(f"   ⚠️  Workspace has files: {len(files.get('data_in', []))}")
                
        else:
            print(f"   ❌ Failed to create workspace: {response.status_code}")
    except Exception as e:
        print(f"   ❌ Error: {e}")

    print()
    print("=" * 60)
    print("✅ Backend API verification complete!")
    print()
    print("👉 Next: Open http://localhost:5173 in your browser")
    print("   and follow the updated testing guide in TEST_WORKFLOW_UX.md")

if __name__ == "__main__":
    test_api_endpoints()
