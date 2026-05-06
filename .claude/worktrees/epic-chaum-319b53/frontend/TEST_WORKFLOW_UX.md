# Workflow Studio UX - Testing Guide

## Quick Start

### 1. Start the Development Server (if not running)

```powershell
# Terminal 1 - Backend
cd C:\Users\nsdha\OneDrive\code\benny
python -m uvicorn benny.api.server:app --reload --port 8000

# Terminal 2 - Frontend
cd C:\Users\nsdha\OneDrive\code\benny\frontend
npm run dev
```

### 2. Open Browser

Navigate to: http://localhost:5173

---

## Visual Verification Checklist

### ✅ Navigation Bar (Top of Sidebar)

- [ ] See "Benny" logo with "B" icon
- [ ] Three buttons visible:
  - [ ] "Studio" (with Layers icon)
  - [ ] "Notebook" (with BookOpen icon)
  - [ ] "LLMs" (with Cpu icon)
- [ ] "Studio" button is highlighted by default

### ✅ Studio Sidebar (Left Panel)

- [ ] "New Workflow" button at top (gradient style)
- [ ] Workflow list below showing:
  - [ ] "basic_chat" (with "Example" badge)
  - [ ] Any saved user workflows
- [ ] Horizontal separator line
- [ ] **Node Palette visible** (scrollable):
  - [ ] "TRIGGERS" section
  - [ ] "AI / LLM" section
  - [ ] "LOGIC" section
  - [ ] "DATA" section

### ✅ Main Canvas Area

- [ ] Title: "🔷 Workflow Studio"
- [ ] Three buttons in top bar:
  - [ ] "Execute" (gradient)
  - [ ] "Clear" (outline)
  - [ ] "Save" (outline)
- [ ] Dark canvas with dot grid background
- [ ] Controls (zoom/pan) in bottom right
- [ ] Mini-map in bottom right

---

## Functional Testing

### Test 1: Create New Workflow ✅

**Steps**:

1. Click "New Workflow" button
2. Verify canvas clears (all nodes removed)
3. Open browser console (F12)
4. Should see: `Created new workflow`

**Expected**: ✅ Canvas is empty and ready for nodes

---

### Test 2: Drag Nodes from Palette ✅

**Steps**:

1. Scroll in Node Palette to "TRIGGERS" section
2. Click and drag "Chat Input" node
3. Drop onto canvas
4. Node should appear

**Expected**:

- ✅ Node appears on canvas
- ✅ Node has icon and label "Chat Input"
- ✅ Node has colored left border (green for trigger)

---

### Test 3: Connect Nodes ✅

**Steps**:

1. Add "Chat Input" node
2. Add "Chat Model" node from "AI / LLM" section
3. Hover over right edge of "Chat Input" → see circular handle
4. Drag from handle to "Chat Model" input handle (left side)
5. Release

**Expected**:

- ✅ Animated purple edge connects the nodes
- ✅ Edge follows curved path

---

### Test 4: Save Workflow ✅

**Steps**:

1. Create workflow with 2+ connected nodes
2. Click "Save" button
3. Enter name: "Test Workflow"
4. Click OK

**Expected**:

- ✅ See "Workflow saved successfully!" alert
- ✅ Button shows "Saving..." briefly with spinner
- ✅ Refresh page → "Test Workflow" appears in sidebar list

---

### Test 5: Load Saved Workflow ✅

**Steps**:

1. Click on "basic_chat" in workflow list
2. Wait briefly

**Expected**:

- ✅ Nodes appear on canvas
- ✅ Edges connect nodes
- ✅ Console shows: `Loaded workflow: basic_chat`
- ✅ Highlight appears around selected workflow in list

---

### Test 6: Execute Workflow ✅

**Steps**:

1. Load or create a workflow
2. Click "Execute" button
3. Watch button change

**Expected**:

- ✅ Button changes to "Executing..." with spinner
- ✅ After completion: success or error alert
- ✅ Console shows execution result

---

### Test 7: Switch to Notebook View ✅

**Steps**:

1. Click "Notebook" button in navigation
2. Observe layout change

**Expected**:

- ✅ Left sidebar shows "Sources" panel:
  - Upload zone with "Drop files or click to upload"
  - File list (if any files uploaded)
  - "Index files" button at bottom
- ✅ Center area shows:
  - Empty state: Book icon + "Chat with your documents"
  - Or chat interface if messages exist
- ✅ Canvas and workflow tools are hidden

---

### Test 8: Notebook Upload & Chat ✅

**Steps**:

1. In Notebook view
2. Click upload zone → select a .txt or .pdf file
3. Wait for upload
4. Click "Index X files" button
5. Wait for "Files indexed successfully!" alert
6. Type question in input box at bottom
7. Press Enter

**Expected**:

- ✅ File appears in sources list
- ✅ User message appears on right (gradient background)
- ✅ AI response appears on left (dark panel)
- ✅ Sources cited if available

---

### Test 9: Navigation State Persistence ✅

**Steps**:

1. In Studio: Create workflow
2. Switch to Notebook
3. Switch to LLMs
4. Switch back to Studio

**Expected**:

- ✅ Workflow still visible on canvas
- ✅ State did not reset
- ✅ All views maintain their data

---

### Test 10: Workspace Management (New!) ✅

**Steps**:

1. Look at top of sidebar in Studio or Notebook
2. Click the specific Workspace dropdown (defaults to "default")
3. Click "New Workspace"
4. Type "proj-alpha" and press Enter (or click +)
5. Dropdown should close and show "proj-alpha" as selected

**Expected**:

- ✅ Workspace switches to "proj-alpha"
- ✅ File list clears (empty workspace)
- ✅ Upload a file → switch back to "default" → file should disappear
- ✅ Switch back to "proj-alpha" → file should reappear

### Test 11: File Download (New!) ✅

**Steps**:

1. In Notebook source panel
2. Upload a text file
3. Hover over the file card
4. Click the newly added **Download** (arrow down) icon

**Expected**:

- ✅ Browser prompts to save the file
- ✅ File downloads successfully

---

## Common Issues & Solutions

### Issue: Node Palette Not Visible

**Solution**: Make sure you're in "Studio" view, not "Notebook" or "LLMs"

### Issue: "New Workflow" Does Nothing

**Check**:

- Open console (F12)
- Should see "Created new workflow"
- If not, check for JavaScript errors

### Issue: Save Button Disabled

**Reason**: Canvas is empty
**Solution**: Add at least one node before saving

### Issue: Cannot Connect Nodes

**Solution**:

- Drag from output handle (right side of node)
- To input handle (left side of target node)
- Handles appear as small circles on hover

### Issue: Notebook Chat Not Working

**Check**:

1. Files are uploaded
2. "Index files" button was clicked
3. Backend is running (http://localhost:8000)
4. Check console for API errors

---

## API Endpoint Testing (Optional)

Test backend directly:

```powershell
# List workflows
curl http://localhost:8000/api/workflows

# Save workflow (test data)
curl -X POST http://localhost:8000/api/workflows `
  -H "Content-Type: application/json" `
  -d '{\"id\":\"test123\",\"name\":\"Test\",\"nodes\":[],\"edges\":[]}'

# Query documents
curl -X POST http://localhost:8000/api/rag/query `
  -H "Content-Type: application/json" `
  -d '{\"query\":\"test\",\"workspace\":\"default\"}'
```

---

## Success Criteria

All tests pass = UX fixes are working correctly! ✅

The workflow studio is now fully functional for:

- Creating new workflows
- Loading saved workflows
- Editing workflows on canvas
- Saving workflows
- Executing workflows
- Chatting with documents (NotebookLM)
