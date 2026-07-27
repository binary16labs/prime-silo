/**
 * Lineage & Execution Timeline Custom Element
 * 
 * Reusable execution & data_out lineage visualization widget with swimlanes,
 * dual-handle sliding viewport window, OpenLineage DAG traversal,
 * adaptive clustering, playback step-through, and detail inspection drawer.
 * 
 * Optimized with DOM reuse for buttery smooth scaling/panning,
 * and vertical collision avoidance for nodes in the same swimlane.
 */

export class LineageTimeline extends HTMLElement {
  constructor() {
    super();
    this.data = null;
    this.viewport = { startPct: 0, endPct: 100 };
    this.selectedNodeId = null;
    this.searchQuery = '';
    this.highlightLineageOnly = false;
    
    // Playback State
    this.playbackIndex = -1;
    this.isPlaying = false;
    this.playInterval = null;
    this.sortedNodes = [];

    // Drag/Resize State
    this.isDraggingWindow = false;
    this.isResizingLeft = false;
    this.isResizingRight = false;
    this.dragStartX = 0;
    this.initialViewportPct = { startPct: 0, endPct: 100 };

    // DOM Caches for optimized rendering
    this.nodeElements = new Map(); // id -> HTMLElement
    this.edgeElements = []; // { from, to, pathEl }
    this.timeTicks = [];
  }

  connectedCallback() {
    this.renderShell();
    this.setupEventListeners();
  }

  setData(payload) {
    if (!payload || !payload.nodes) return;
    this.data = payload;
    this.viewport = { startPct: 0, endPct: 100 };
    this.selectedNodeId = null;
    
    this.sortedNodes = [...this.data.nodes].sort((a, b) => a.timestamp - b.timestamp);
    this.playbackIndex = -1;
    this.stopPlayback();

    this.buildGraphElements();
    this.updateLayout();
  }

  renderShell() {
    this.innerHTML = `
      <div class="lineage-timeline-container">
        <div class="lineage-toolbar">
          <div class="lineage-title-group">
            <span>Execution & Lineage Timeline</span>
            <span class="lineage-badge" id="lane-count-badge">0 Nodes</span>
          </div>
          <div class="lineage-controls">
            <div class="lineage-playback-group">
              <button class="lineage-playback-btn" id="btn-play-prev" title="Previous Step">⏮️</button>
              <button class="lineage-playback-btn" id="btn-play-toggle" title="Play / Pause">▶️</button>
              <button class="lineage-playback-btn" id="btn-play-next" title="Next Step">⏭️</button>
            </div>
            <input type="text" class="lineage-input-search" id="lineage-search" placeholder="Search nodes or tools..." />
            <button class="lineage-btn" id="btn-lineage-trace"><span>⚡ Trace Lineage</span></button>
            <button class="lineage-btn" id="btn-reset-view">Fit View</button>
          </div>
        </div>

        <div class="lineage-workspace">
          <div class="lineage-lane-sidebar">
            <div class="lineage-time-ruler-corner">SWIMLANES</div>
            <div class="lineage-lane-label" data-lane="sessions"><span>🟣 Sessions & Runs</span></div>
            <div class="lineage-lane-label" data-lane="chats"><span>💬 Chats & Prompts</span></div>
            <div class="lineage-lane-label" data-lane="inputs"><span>🟢 Data & Context</span></div>
            <div class="lineage-lane-label" data-lane="tools"><span>🔵 Tools & Jobs</span></div>
            <div class="lineage-lane-label" data-lane="outputs"><span>🟡 Data Out & Artifacts</span></div>
            <div class="lineage-lane-label" data-lane="logs"><span>🖥️ Logs & Terminal</span></div>
          </div>

          <div class="lineage-timeline-viewport" id="timeline-viewport">
            <div class="lineage-time-ruler" id="time-ruler"></div>
            <svg class="lineage-svg-overlay" id="svg-edges"></svg>
            <div class="lineage-time-scrubber" id="time-scrubber"></div>

            <div class="lineage-track-container" id="track-container">
              <div class="lineage-lane-track" data-lane="sessions"></div>
              <div class="lineage-lane-track" data-lane="chats"></div>
              <div class="lineage-lane-track" data-lane="inputs"></div>
              <div class="lineage-lane-track" data-lane="tools"></div>
              <div class="lineage-lane-track" data-lane="outputs"></div>
              <div class="lineage-lane-track" data-lane="logs"></div>
            </div>
          </div>

          <div class="lineage-inspector-drawer" id="inspector-drawer">
            <div class="lineage-drawer-header">
              <span class="lineage-drawer-title" id="drawer-node-title">Node Inspection</span>
              <button class="lineage-close-btn" id="btn-close-drawer">&times;</button>
            </div>
            <div class="lineage-drawer-body" id="drawer-node-body">
              <div class="lineage-detail-row">
                <span class="lineage-detail-label">Select a node to view lineage details</span>
              </div>
            </div>
          </div>
        </div>

        <div class="lineage-minimap-bar">
          <div class="lineage-minimap-track" id="minimap-track">
            <div class="lineage-minimap-density" id="minimap-density"></div>
            <div class="lineage-minimap-window" id="minimap-window">
              <div class="lineage-minimap-handle left" id="handle-left"></div>
              <div class="lineage-minimap-handle right" id="handle-right"></div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  setupEventListeners() {
    const searchInput = this.querySelector('#lineage-search');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.searchQuery = e.target.value.toLowerCase();
        this.updateLayout();
      });
    }

    const resetBtn = this.querySelector('#btn-reset-view');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        this.viewport = { startPct: 0, endPct: 100 };
        this.updateLayout();
      });
    }

    const traceBtn = this.querySelector('#btn-lineage-trace');
    if (traceBtn) {
      traceBtn.addEventListener('click', () => {
        this.highlightLineageOnly = !this.highlightLineageOnly;
        traceBtn.classList.toggle('active', this.highlightLineageOnly);
        this.updateLayout();
      });
    }

    const closeDrawerBtn = this.querySelector('#btn-close-drawer');
    if (closeDrawerBtn) {
      closeDrawerBtn.addEventListener('click', () => this.closeDrawer());
    }

    // Playback events
    const playToggle = this.querySelector('#btn-play-toggle');
    const playNext = this.querySelector('#btn-play-next');
    const playPrev = this.querySelector('#btn-play-prev');
    
    if (playToggle) playToggle.addEventListener('click', () => this.isPlaying ? this.stopPlayback() : this.startPlayback());
    if (playNext) playNext.addEventListener('click', () => { this.stopPlayback(); this.stepPlayback(1); });
    if (playPrev) playPrev.addEventListener('click', () => { this.stopPlayback(); this.stepPlayback(-1); });

    // Minimap dragging & resizing
    const minimapTrack = this.querySelector('#minimap-track');
    const minimapWindow = this.querySelector('#minimap-window');
    const handleLeft = this.querySelector('#handle-left');
    const handleRight = this.querySelector('#handle-right');

    if (minimapWindow && minimapTrack) {
      minimapWindow.addEventListener('mousedown', (e) => {
        if (e.target === handleLeft || e.target === handleRight) return;
        this.isDraggingWindow = true;
        this.dragStartX = e.clientX;
        this.initialViewportPct = { ...this.viewport };
        e.preventDefault();
      });

      handleLeft.addEventListener('mousedown', (e) => {
        this.isResizingLeft = true;
        this.dragStartX = e.clientX;
        this.initialViewportPct = { ...this.viewport };
        e.stopPropagation(); e.preventDefault();
      });

      handleRight.addEventListener('mousedown', (e) => {
        this.isResizingRight = true;
        this.dragStartX = e.clientX;
        this.initialViewportPct = { ...this.viewport };
        e.stopPropagation(); e.preventDefault();
      });

      window.addEventListener('mousemove', (e) => {
        if (!this.isDraggingWindow && !this.isResizingLeft && !this.isResizingRight) return;
        const rect = minimapTrack.getBoundingClientRect();
        const deltaPct = ((e.clientX - this.dragStartX) / rect.width) * 100;

        if (this.isDraggingWindow) {
          const windowWidthPct = this.initialViewportPct.endPct - this.initialViewportPct.startPct;
          let newStartPct = this.initialViewportPct.startPct + deltaPct;
          let newEndPct = newStartPct + windowWidthPct;

          if (newStartPct < 0) { newStartPct = 0; newEndPct = windowWidthPct; }
          if (newEndPct > 100) { newEndPct = 100; newStartPct = 100 - windowWidthPct; }

          this.viewport.startPct = newStartPct;
          this.viewport.endPct = newEndPct;
        } else if (this.isResizingLeft) {
          let newStartPct = this.initialViewportPct.startPct + deltaPct;
          if (newStartPct < 0) newStartPct = 0;
          if (newStartPct > this.viewport.endPct - 2) newStartPct = this.viewport.endPct - 2;
          this.viewport.startPct = newStartPct;
        } else if (this.isResizingRight) {
          let newEndPct = this.initialViewportPct.endPct + deltaPct;
          if (newEndPct > 100) newEndPct = 100;
          if (newEndPct < this.viewport.startPct + 2) newEndPct = this.viewport.startPct + 2;
          this.viewport.endPct = newEndPct;
        }

        // Fast update
        this.updateLayout();
      });

      window.addEventListener('mouseup', () => {
        this.isDraggingWindow = false;
        this.isResizingLeft = false;
        this.isResizingRight = false;
      });
      
      // Handle window resize to recalculate edge positions correctly
      window.addEventListener('resize', () => {
        if (this.data) this.updateLayout();
      });
    }
  }

  // Playback Engine
  startPlayback() {
    if (!this.data || this.sortedNodes.length === 0) return;
    this.isPlaying = true;
    const playToggle = this.querySelector('#btn-play-toggle');
    if (playToggle) playToggle.textContent = '⏸️';

    this.playInterval = setInterval(() => {
      this.stepPlayback(1);
    }, 1500);
  }

  stopPlayback() {
    this.isPlaying = false;
    const playToggle = this.querySelector('#btn-play-toggle');
    if (playToggle) playToggle.textContent = '▶️';
    if (this.playInterval) clearInterval(this.playInterval);
  }

  stepPlayback(direction) {
    if (!this.data || this.sortedNodes.length === 0) return;
    
    let nextIdx = this.playbackIndex + direction;
    if (nextIdx >= this.sortedNodes.length) {
      this.stopPlayback();
      return;
    }
    if (nextIdx < 0) nextIdx = 0;

    this.playbackIndex = nextIdx;
    const activeNode = this.sortedNodes[this.playbackIndex];
    
    // Auto-pan viewport if node is out of bounds
    const totalDuration = this.data.timeRange.end - this.data.timeRange.start || 1;
    const nodePct = ((activeNode.timestamp - this.data.timeRange.start) / totalDuration) * 100;
    
    if (nodePct < this.viewport.startPct + 5 || nodePct > this.viewport.endPct - 5) {
      const windowWidth = this.viewport.endPct - this.viewport.startPct;
      let newStart = nodePct - (windowWidth / 2);
      if (newStart < 0) newStart = 0;
      if (newStart + windowWidth > 100) newStart = 100 - windowWidth;
      this.viewport.startPct = newStart;
      this.viewport.endPct = newStart + windowWidth;
    }

    this.selectNode(activeNode.id);
  }

  getLineageSet(nodeId) {
    if (!this.data || !this.data.edges) return new Set();
    const connected = new Set([nodeId]);
    const edges = this.data.edges;
    let added = true;
    
    while(added) {
      added = false;
      edges.forEach(e => {
        if (connected.has(e.from) && !connected.has(e.to)) {
          connected.add(e.to);
          added = true;
        }
        if (connected.has(e.to) && !connected.has(e.from)) {
          connected.add(e.from);
          added = true;
        }
      });
    }
    return connected;
  }

  /**
   * Phase 1: Build DOM elements once
   */
  buildGraphElements() {
    if (!this.data) return;

    const badge = this.querySelector('#lane-count-badge');
    if (badge) badge.textContent = `${this.data.nodes.length} Items`;

    const tracks = {
      sessions: this.querySelector('.lineage-lane-track[data-lane="sessions"]'),
      chats: this.querySelector('.lineage-lane-track[data-lane="chats"]'),
      inputs: this.querySelector('.lineage-lane-track[data-lane="inputs"]'),
      tools: this.querySelector('.lineage-lane-track[data-lane="tools"]'),
      outputs: this.querySelector('.lineage-lane-track[data-lane="outputs"]'),
      logs: this.querySelector('.lineage-lane-track[data-lane="logs"]')
    };

    // Clear tracks
    Object.values(tracks).forEach(t => t && (t.innerHTML = ''));
    this.nodeElements.clear();

    // Group nodes by swimlane for collision logic
    const lanesNodes = { sessions: [], chats: [], inputs: [], tools: [], outputs: [], logs: [] };

    this.data.nodes.forEach(node => {
      const lane = node.swimlaneId || 'tools';
      if (lanesNodes[lane]) lanesNodes[lane].push(node);
    });

    // Determine vertical offsets for collision avoidance
    // We sort nodes in each lane by time, and assign them to visual sub-rows.
    const nodeRowOffsets = new Map();
    const PX_TIME_GUESS = (this.data.timeRange.end - this.data.timeRange.start) * 0.08; // assume node width is ~8% of total time for packing

    Object.keys(lanesNodes).forEach(lane => {
      const nodesInLane = lanesNodes[lane].sort((a, b) => a.timestamp - b.timestamp);
      const rowEnds = []; // tracks the end time of the last node in each row

      nodesInLane.forEach(node => {
        let assignedRow = -1;
        for (let i = 0; i < rowEnds.length; i++) {
          if (node.timestamp > rowEnds[i]) {
            assignedRow = i;
            break;
          }
        }
        
        if (assignedRow === -1) {
          assignedRow = rowEnds.length;
          rowEnds.push(0);
        }
        
        rowEnds[assignedRow] = node.timestamp + PX_TIME_GUESS;
        // Limit to 3 rows max to avoid overflowing the swimlane height
        const finalRow = Math.min(assignedRow, 2);
        nodeRowOffsets.set(node.id, (finalRow * 26) - 26); // Center is 0, top row is -26, bottom row is +26
      });
    });

    // Create Nodes
    this.data.nodes.forEach(node => {
      const laneTrack = tracks[node.swimlaneId] || tracks.tools;
      if (!laneTrack) return;

      const nodeEl = document.createElement('div');
      nodeEl.className = 'lineage-node';
      nodeEl.dataset.lane = String(node.swimlaneId);
      nodeEl.dataset.nodeId = String(node.id);
      
      var vOffset = nodeRowOffsets.get(node.id) || 0;
      nodeEl.style.marginTop = vOffset + 'px';

      let icon = '📄';
      if (node.swimlaneId === 'sessions') icon = '🟣';
      else if (node.swimlaneId === 'chats') icon = '💬';
      else if (node.swimlaneId === 'inputs') icon = '🟢';
      else if (node.swimlaneId === 'tools') icon = '⚡';
      else if (node.swimlaneId === 'outputs') icon = '📦';
      else if (node.swimlaneId === 'logs') icon = '🖥️';

      nodeEl.innerHTML = '<span>' + icon + '</span> <span>' + node.label + '</span>';

      nodeEl.addEventListener('click', (e) => {
        e.stopPropagation();
        this.selectNode(node.id);
      });

      laneTrack.appendChild(nodeEl);
      this.nodeElements.set(node.id, { 
        element: nodeEl, 
        nodeData: node, 
        vOffset: vOffset 
      });
    });

    // Create Edges
    const svgOverlay = this.querySelector('#svg-edges');
    if (svgOverlay) svgOverlay.innerHTML = '';
    this.edgeElements = [];

    if (this.data.edges && svgOverlay) {
      this.data.edges.forEach(edge => {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('class', 'lineage-edge-path');
        svgOverlay.appendChild(path);
        
        this.edgeElements.push({
          fromId: edge.from,
          toId: edge.to,
          pathEl: path
        });
      });
    }

    // Create Time Ruler Ticks
    const ruler = this.querySelector('#time-ruler');
    if (ruler) {
      ruler.innerHTML = '';
      this.timeTicks = [];
      for (let i = 0; i <= 6; i++) {
        const tickEl = document.createElement('div');
        tickEl.className = 'lineage-time-tick';
        ruler.appendChild(tickEl);
        this.timeTicks.push(tickEl);
      }
    }
  }

  /**
   * Phase 2: Update positions (runs on every drag/pan/zoom)
   */
  updateLayout() {
    if (!this.data) return;

    // 1. Update Minimap Window
    const minimapWindow = this.querySelector('#minimap-window');
    if (minimapWindow) {
      minimapWindow.style.left = `${this.viewport.startPct}%`;
      minimapWindow.style.width = `${this.viewport.endPct - this.viewport.startPct}%`;
    }

    // 2. Determine Viewport Time Bounds
    const startTime = this.data.timeRange.start;
    const totalDuration = this.data.timeRange.end - this.data.timeRange.start || 1;
    const viewStartTime = startTime + (totalDuration * (this.viewport.startPct / 100));
    const viewEndTime = startTime + (totalDuration * (this.viewport.endPct / 100));
    const viewDuration = viewEndTime - viewStartTime || 1;

    // 3. Update Time Ruler
    this.timeTicks.forEach((tick, i) => {
      const pct = (i / 6) * 100;
      const timeVal = new Date(viewStartTime + (viewDuration * (i / 6)));
      tick.style.left = `${pct}%`;
      tick.textContent = timeVal.toTimeString().split(' ')[0];
    });

    // 4. Calculate active Lineage Set
    let lineageSet = null;
    if (this.highlightLineageOnly && this.selectedNodeId) {
      lineageSet = this.getLineageSet(this.selectedNodeId);
    }

    // 5. Update Nodes (Filtering, Selection State, Position)
    this.nodeElements.forEach((nodeCache, nodeId) => {
      const { element, nodeData } = nodeCache;
      
      // Visibility (culling)
      if (nodeData.timestamp < viewStartTime || nodeData.timestamp > viewEndTime) {
        element.style.display = 'none';
        return;
      }
      
      // Search Filtering
      if (this.searchQuery && !nodeData.label.toLowerCase().includes(this.searchQuery) && !(nodeData.type && nodeData.type.toLowerCase().includes(this.searchQuery))) {
        element.style.display = 'none';
        return;
      }

      element.style.display = 'flex'; // make visible
      
      // Position
      const offsetPct = ((nodeData.timestamp - viewStartTime) / viewDuration) * 100;
      element.style.left = `${offsetPct}%`;

      // Active / Selection States
      element.classList.toggle('selected', nodeId === this.selectedNodeId);
      element.classList.toggle('playback-active', this.playbackIndex >= 0 && this.sortedNodes[this.playbackIndex].id === nodeId);

      // Lineage Dimming
      if (lineageSet && !lineageSet.has(nodeId)) {
        element.style.opacity = '0.15';
      } else {
        element.style.opacity = '1';
      }
    });

    // 6. Update Edges
    const svgOverlay = this.querySelector('#svg-edges');
    const viewportWidth = svgOverlay ? svgOverlay.clientWidth : 800;
    const laneOffsets = { sessions: 40, chats: 120, inputs: 200, tools: 280, outputs: 360, logs: 440 };

    this.edgeElements.forEach(edge => {
      const sourceCache = this.nodeElements.get(edge.fromId);
      const targetCache = this.nodeElements.get(edge.toId);
      
      if (!sourceCache || !targetCache || sourceCache.element.style.display === 'none' || targetCache.element.style.display === 'none') {
        edge.pathEl.style.display = 'none';
        return;
      }

      edge.pathEl.style.display = 'block';

      // Compute X based on time
      const sourceX = ((sourceCache.nodeData.timestamp - viewStartTime) / viewDuration) * viewportWidth;
      const targetX = ((targetCache.nodeData.timestamp - viewStartTime) / viewDuration) * viewportWidth;

      // Compute Y based on swimlane + packing offset
      const sourceY = laneOffsets[sourceCache.nodeData.swimlaneId] + sourceCache.vOffset;
      const targetY = laneOffsets[targetCache.nodeData.swimlaneId] + targetCache.vOffset;

      const dy = Math.abs(targetY - sourceY) * 0.5;
      const dx = Math.abs(targetX - sourceX) * 0.2;
      const pathD = `M ${sourceX} ${sourceY} C ${sourceX + dx} ${sourceY + dy}, ${targetX - dx} ${targetY - dy}, ${targetX} ${targetY}`;
      
      edge.pathEl.setAttribute('d', pathD);

      const isConnectedToSelected = this.selectedNodeId && (edge.fromId === this.selectedNodeId || edge.toId === this.selectedNodeId);
      const inLineage = lineageSet && lineageSet.has(edge.fromId) && lineageSet.has(edge.toId);

      edge.pathEl.classList.toggle('highlighted', Boolean(isConnectedToSelected || inLineage));
      edge.pathEl.classList.toggle('dimmed', Boolean(this.selectedNodeId && !isConnectedToSelected && !inLineage));
    });

    // 7. Update Scrubber
    const scrubber = this.querySelector('#time-scrubber');
    if (scrubber) {
      if (this.playbackIndex >= 0 && this.sortedNodes.length > 0) {
        const activeNode = this.sortedNodes[this.playbackIndex];
        if (activeNode.timestamp >= viewStartTime && activeNode.timestamp <= viewStartTime + viewDuration) {
          const offsetPct = ((activeNode.timestamp - viewStartTime) / viewDuration) * 100;
          scrubber.style.left = `${offsetPct}%`;
          scrubber.classList.add('active');
        } else {
          scrubber.classList.remove('active');
        }
      } else {
        scrubber.classList.remove('active');
      }
    }
  }

  selectNode(nodeId) {
    this.selectedNodeId = nodeId;
    const node = this.data.nodes.find(n => n.id === nodeId);
    
    const idx = this.sortedNodes.findIndex(n => n.id === nodeId);
    if (idx >= 0) this.playbackIndex = idx;

    if (node) this.openDrawer(node);
    
    this.updateLayout();
  }

  openDrawer(node) {
    const drawer = this.querySelector('#inspector-drawer');
    const title = this.querySelector('#drawer-node-title');
    const body = this.querySelector('#drawer-node-body');

    if (!drawer || !body) return;

    if (title) title.textContent = node.label;

    let timeStr = new Date(node.timestamp).toLocaleString();
    let metadataRows = '';

    if (node.metadata) {
      Object.entries(node.metadata).forEach(([key, val]) => {
        metadataRows += `
          <div class="lineage-detail-row">
            <span class="lineage-detail-label">${key}</span>
            <div class="lineage-detail-value">${typeof val === 'object' ? JSON.stringify(val, null, 2) : val}</div>
          </div>
        `;
      });
    }

    body.innerHTML = `
      <div class="lineage-detail-row">
        <span class="lineage-detail-label">Node ID</span>
        <div class="lineage-detail-value">${node.id}</div>
      </div>
      <div class="lineage-detail-row">
        <span class="lineage-detail-label">Swimlane</span>
        <div class="lineage-detail-value">${node.swimlaneId}</div>
      </div>
      <div class="lineage-detail-row">
        <span class="lineage-detail-label">Timestamp</span>
        <div class="lineage-detail-value">${timeStr}</div>
      </div>
      ${metadataRows}
    `;

    drawer.classList.add('open');
  }

  closeDrawer() {
    const drawer = this.querySelector('#inspector-drawer');
    if (drawer) drawer.classList.remove('open');
    this.selectedNodeId = null;
    this.updateLayout();
  }
}

if (!customElements.get('lineage-timeline')) {
  customElements.define('lineage-timeline', LineageTimeline);
}
