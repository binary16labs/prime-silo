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
    this.searchQuery = "";
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

        <div class="lineage-minimap-bar">
          <div class="lineage-minimap-track" id="minimap-track">
            <div class="lineage-minimap-density" id="minimap-density"></div>
            <div class="lineage-minimap-window" id="minimap-window">
              <div class="lineage-minimap-handle left" id="handle-left"></div>
              <div class="lineage-minimap-handle right" id="handle-right"></div>
            </div>
          </div>
        </div>

        <div class="lineage-workspace">
          <div class="lineage-workspace-main">
            <div class="lineage-lane-header">
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
      </div>
    `;
  }

  setupEventListeners() {
    const searchInput = this.querySelector("#lineage-search");
    if (searchInput) {
      searchInput.addEventListener("input", (e) => {
        this.searchQuery = e.target.value.toLowerCase();
        this.updateLayout();
      });
    }

    const resetBtn = this.querySelector("#btn-reset-view");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        const viewportEl = this.querySelector("#timeline-viewport");
        if (viewportEl) viewportEl.scrollTo({ top: 0, behavior: "smooth" });
        this.viewport = { startPct: 0, endPct: 100 };
        this.updateLayout();
      });
    }

    const traceBtn = this.querySelector("#btn-lineage-trace");
    if (traceBtn) {
      traceBtn.addEventListener("click", () => {
        this.highlightLineageOnly = !this.highlightLineageOnly;
        traceBtn.classList.toggle("active", this.highlightLineageOnly);
        this.updateLayout();
      });
    }

    const closeDrawerBtn = this.querySelector("#btn-close-drawer");
    if (closeDrawerBtn) {
      closeDrawerBtn.addEventListener("click", () => this.closeDrawer());
    }

    // Playback events
    const playToggle = this.querySelector("#btn-play-toggle");
    const playNext = this.querySelector("#btn-play-next");
    const playPrev = this.querySelector("#btn-play-prev");

    if (playToggle)
      playToggle.addEventListener("click", () =>
        this.isPlaying ? this.stopPlayback() : this.startPlayback()
      );
    if (playNext)
      playNext.addEventListener("click", () => {
        this.stopPlayback();
        this.stepPlayback(1);
      });
    if (playPrev)
      playPrev.addEventListener("click", () => {
        this.stopPlayback();
        this.stepPlayback(-1);
      });

    // Native Viewport Scroll Event -> Sync Minimap & Culling
    const viewportEl = this.querySelector("#timeline-viewport");
    if (viewportEl) {
      viewportEl.addEventListener("scroll", () => {
        if (this.isProgrammaticScroll) return;
        this.syncMinimapFromViewportScroll();
        this.updateCulling();
      });
    }

    // Minimap dragging & resizing
    const minimapTrack = this.querySelector("#minimap-track");
    const minimapWindow = this.querySelector("#minimap-window");
    const handleLeft = this.querySelector("#handle-left");
    const handleRight = this.querySelector("#handle-right");

    if (minimapWindow && minimapTrack) {
      minimapWindow.addEventListener("mousedown", (e) => {
        if (e.target === handleLeft || e.target === handleRight) return;
        this.isDraggingWindow = true;
        this.dragStartX = e.clientX;
        this.initialViewportPct = { ...this.viewport };
        e.preventDefault();
      });

      if (handleLeft) {
        handleLeft.addEventListener("mousedown", (e) => {
          this.isResizingLeft = true;
          this.dragStartX = e.clientX;
          this.initialViewportPct = { ...this.viewport };
          e.stopPropagation();
          e.preventDefault();
        });
      }

      if (handleRight) {
        handleRight.addEventListener("mousedown", (e) => {
          this.isResizingRight = true;
          this.dragStartX = e.clientX;
          this.initialViewportPct = { ...this.viewport };
          e.stopPropagation();
          e.preventDefault();
        });
      }

      window.addEventListener("mousemove", (e) => {
        if (!this.isDraggingWindow && !this.isResizingLeft && !this.isResizingRight) return;
        const rect = minimapTrack.getBoundingClientRect();
        if (!rect.width) return;
        const deltaPct = ((e.clientX - this.dragStartX) / rect.width) * 100;

        if (this.isDraggingWindow) {
          const windowWidthPct = this.initialViewportPct.endPct - this.initialViewportPct.startPct;
          let newStartPct = this.initialViewportPct.startPct + deltaPct;
          let newEndPct = newStartPct + windowWidthPct;

          if (newStartPct < 0) {
            newStartPct = 0;
            newEndPct = windowWidthPct;
          }
          if (newEndPct > 100) {
            newEndPct = 100;
            newStartPct = 100 - windowWidthPct;
          }

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

        this.scrollViewportFromMinimap();
      });

      window.addEventListener("mouseup", () => {
        this.isDraggingWindow = false;
        this.isResizingLeft = false;
        this.isResizingRight = false;
      });

      window.addEventListener("resize", () => {
        if (this.data) this.updateLayout();
      });
    }
  }

  syncMinimapFromViewportScroll() {
    const viewportEl = this.querySelector("#timeline-viewport");
    if (!viewportEl) return;

    const scrollHeight = viewportEl.scrollHeight;
    const clientHeight = viewportEl.clientHeight;
    const scrollTop = viewportEl.scrollTop;

    if (scrollHeight <= clientHeight) {
      this.viewport = { startPct: 0, endPct: 100 };
    } else {
      const maxScroll = scrollHeight - clientHeight;
      const startPct = (scrollTop / maxScroll) * 100;
      const windowSizePct = (clientHeight / scrollHeight) * 100;
      this.viewport.startPct = Math.max(0, Math.min(100 - windowSizePct, startPct));
      this.viewport.endPct = Math.min(100, this.viewport.startPct + windowSizePct);
    }

    const minimapWindow = this.querySelector("#minimap-window");
    if (minimapWindow) {
      minimapWindow.style.left = `${this.viewport.startPct}%`;
      minimapWindow.style.width = `${Math.max(4, this.viewport.endPct - this.viewport.startPct)}%`;
    }
  }

  scrollViewportFromMinimap() {
    const viewportEl = this.querySelector("#timeline-viewport");
    if (!viewportEl) return;

    const maxScroll = viewportEl.scrollHeight - viewportEl.clientHeight;
    const targetScrollTop = (this.viewport.startPct / 100) * maxScroll;

    this.isProgrammaticScroll = true;
    viewportEl.scrollTop = targetScrollTop;
    this.isProgrammaticScroll = false;

    this.updateCulling();
  }

  // Playback Engine
  startPlayback() {
    if (!this.data || this.sortedNodes.length === 0) return;
    this.isPlaying = true;
    const playToggle = this.querySelector("#btn-play-toggle");
    if (playToggle) playToggle.textContent = "⏸️";

    this.playInterval = setInterval(() => {
      this.stepPlayback(1);
    }, 1500);
  }

  stopPlayback() {
    this.isPlaying = false;
    const playToggle = this.querySelector("#btn-play-toggle");
    if (playToggle) playToggle.textContent = "▶️";
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
    const nodeCache = this.nodeElements.get(activeNode.id);

    const viewportEl = this.querySelector("#timeline-viewport");
    if (viewportEl && nodeCache && typeof nodeCache.absoluteY === "number") {
      const targetScroll = Math.max(0, nodeCache.absoluteY - viewportEl.clientHeight / 2);
      viewportEl.scrollTo({ top: targetScroll, behavior: "smooth" });
    }

    this.selectNode(activeNode.id);
  }

  getLineageSet(nodeId) {
    if (!this.data || !this.data.edges) return new Set();
    const connected = new Set([nodeId]);
    const edges = this.data.edges;
    let added = true;

    while (added) {
      added = false;
      edges.forEach((e) => {
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
   * Phase 1: Pre-calculate Absolute Canvas Geometry & Metadata
   * (Does NOT instantiate full DOM nodes or SVG paths yet for virtual performance)
   */
  buildGraphElements() {
    if (!this.data) return;

    const badge = this.querySelector("#lane-count-badge");
    if (badge) badge.textContent = `${this.data.nodes.length} Items`;

    this.tracks = {
      sessions: this.querySelector('.lineage-lane-track[data-lane="sessions"]'),
      chats: this.querySelector('.lineage-lane-track[data-lane="chats"]'),
      inputs: this.querySelector('.lineage-lane-track[data-lane="inputs"]'),
      tools: this.querySelector('.lineage-lane-track[data-lane="tools"]'),
      outputs: this.querySelector('.lineage-lane-track[data-lane="outputs"]'),
      logs: this.querySelector('.lineage-lane-track[data-lane="logs"]')
    };

    // Clear tracks & SVG overlay
    Object.values(this.tracks).forEach((t) => t && (t.innerHTML = ""));
    const svgOverlay = this.querySelector("#svg-edges");
    if (svgOverlay) svgOverlay.innerHTML = "";

    this.nodeElements.clear();
    this.edgeElements = [];

    // Group nodes by swimlane
    const lanesNodes = { sessions: [], chats: [], inputs: [], tools: [], outputs: [], logs: [] };
    this.data.nodes.forEach((node) => {
      const lane = node.swimlaneId || "tools";
      if (lanesNodes[lane]) lanesNodes[lane].push(node);
    });

    // Assign topological ranks for equal distribution spacing.
    let currentRank = 0;
    this.sortedNodes.forEach((node, i) => {
      if (i > 0 && node.timestamp > this.sortedNodes[i - 1].timestamp) {
        currentRank++;
      }
      node.rank = currentRank;
    });
    this.maxRank = currentRank || 1;

    // Calculate Absolute Y Position for every node per lane (Guaranteed anti-collision)
    const MIN_STEP_PX = 54;
    let maxAbsoluteY = 0;

    Object.keys(lanesNodes).forEach((lane) => {
      const nodesInLane = lanesNodes[lane].sort((a, b) => a.rank - b.rank);
      let lastY = 20;

      nodesInLane.forEach((node) => {
        let absY = node.rank * MIN_STEP_PX + 20;
        if (absY < lastY + MIN_STEP_PX) {
          absY = lastY + MIN_STEP_PX;
        }
        lastY = absY;
        node.absoluteY = absY;
        if (absY > maxAbsoluteY) maxAbsoluteY = absY;
      });
    });

    this.totalCanvasHeight = Math.max(600, maxAbsoluteY + 120);

    // Populate node cache metadata WITHOUT mounting DOM elements yet
    this.data.nodes.forEach((node) => {
      this.nodeElements.set(node.id, {
        element: null,
        nodeData: node,
        absoluteY: node.absoluteY
      });
    });

    // Pre-calculate Edge geometries
    const laneOffsets = {
      sessions: 110,
      chats: 330,
      inputs: 550,
      tools: 770,
      outputs: 990,
      logs: 1210
    };

    if (this.data.edges) {
      this.data.edges.forEach((edge) => {
        const sourceCache = this.nodeElements.get(edge.from);
        const targetCache = this.nodeElements.get(edge.to);
        if (!sourceCache || !targetCache) return;

        const sourceY = sourceCache.absoluteY + 16;
        const targetY = targetCache.absoluteY + 16;
        const sourceX = laneOffsets[sourceCache.nodeData.swimlaneId] || 770;
        const targetX = laneOffsets[targetCache.nodeData.swimlaneId] || 770;

        const dy = Math.max(20, Math.abs(targetY - sourceY) * 0.3);
        const pathD = `M ${sourceX} ${sourceY} C ${sourceX} ${sourceY + dy}, ${targetX} ${targetY - dy}, ${targetX} ${targetY}`;

        this.edgeElements.push({
          fromId: edge.from,
          toId: edge.to,
          sourceY,
          targetY,
          pathD,
          pathEl: null
        });
      });
    }

    // Create Time Ruler Ticks along absolute canvas height
    const ruler = this.querySelector("#time-ruler");
    if (ruler) {
      ruler.innerHTML = "";
      this.timeTicks = [];
      const numTicks = Math.max(6, Math.floor(this.totalCanvasHeight / 150));
      for (let i = 0; i <= numTicks; i++) {
        const tickY = (i / numTicks) * this.totalCanvasHeight;
        const tickEl = document.createElement("div");
        tickEl.className = "lineage-time-tick";
        tickEl.style.top = `${tickY}px`;

        let closestNode = this.sortedNodes[0];
        let minDiff = Infinity;
        for (const n of this.sortedNodes) {
          const diff = Math.abs(n.absoluteY - tickY);
          if (diff < minDiff) {
            minDiff = diff;
            closestNode = n;
          }
        }
        const timeVal = new Date(closestNode ? closestNode.timestamp : Date.now());
        tickEl.textContent = timeVal.toTimeString().split(" ")[0];

        ruler.appendChild(tickEl);
        this.timeTicks.push(tickEl);
      }
    }

    this.applyCanvasHeights();
    this.updateLayout();
  }

  createNodeElement(nodeData) {
    const nodeEl = document.createElement("div");
    nodeEl.className = "lineage-node";
    nodeEl.dataset.lane = String(nodeData.swimlaneId);
    nodeEl.dataset.nodeId = String(nodeData.id);
    nodeEl.style.top = `${nodeData.absoluteY}px`;

    let icon = "📄";
    if (nodeData.swimlaneId === "sessions") icon = "🟣";
    else if (nodeData.swimlaneId === "chats") icon = "💬";
    else if (nodeData.swimlaneId === "inputs") icon = "🟢";
    else if (nodeData.swimlaneId === "tools") icon = "⚡";
    else if (nodeData.swimlaneId === "outputs") icon = "📦";
    else if (nodeData.swimlaneId === "logs") icon = "🖥️";

    nodeEl.innerHTML = "<span>" + icon + "</span> <span>" + nodeData.label + "</span>";

    nodeEl.addEventListener("click", (e) => {
      e.stopPropagation();
      this.selectNode(nodeData.id);
    });

    return nodeEl;
  }

  applyCanvasHeights() {
    const trackContainer = this.querySelector("#track-container");
    const svgOverlay = this.querySelector("#svg-edges");
    const ruler = this.querySelector("#time-ruler");

    if (trackContainer) trackContainer.style.height = `${this.totalCanvasHeight}px`;
    if (svgOverlay) svgOverlay.style.height = `${this.totalCanvasHeight}px`;
    if (ruler) ruler.style.height = `${this.totalCanvasHeight}px`;
  }

  /**
   * Phase 2: Lightweight Virtual Window Layout Update
   */
  updateLayout() {
    if (!this.data) return;
    this.applyCanvasHeights();
    this.updateCulling();
    this.syncMinimapFromViewportScroll();
  }

  /**
   * Virtualized DOM Pagination Engine:
   * Only mounts nodes and edges that fall within the current visible viewport window (+ 400px buffer).
   * Unmounts offscreen elements to keep DOM light and rendering blazingly fast.
   */
  updateCulling() {
    const viewportEl = this.querySelector("#timeline-viewport");
    if (!viewportEl) return;

    const scrollTop = viewportEl.scrollTop;
    const viewBottom = scrollTop + viewportEl.clientHeight;
    const buffer = 400; // 400px buffer zone

    let lineageSet = null;
    if (this.highlightLineageOnly && this.selectedNodeId) {
      lineageSet = this.getLineageSet(this.selectedNodeId);
    }

    // 1. Virtual Node Mounting / Unmounting
    this.nodeElements.forEach((nodeCache, nodeId) => {
      const { nodeData, absoluteY } = nodeCache;

      // Filter check
      if (
        this.searchQuery &&
        !nodeData.label.toLowerCase().includes(this.searchQuery) &&
        !(nodeData.type && nodeData.type.toLowerCase().includes(this.searchQuery))
      ) {
        if (nodeCache.element) {
          nodeCache.element.remove();
          nodeCache.element = null;
        }
        return;
      }

      const isVisible = absoluteY >= scrollTop - buffer && absoluteY <= viewBottom + buffer;

      if (isVisible) {
        // Mount DOM element lazily if not present
        if (!nodeCache.element) {
          const laneTrack = this.tracks ? this.tracks[nodeData.swimlaneId] : null;
          if (laneTrack) {
            nodeCache.element = this.createNodeElement(nodeData);
            laneTrack.appendChild(nodeCache.element);
          }
        }

        if (nodeCache.element) {
          nodeCache.element.style.display = "flex";
          nodeCache.element.classList.toggle("selected", nodeId === this.selectedNodeId);
          nodeCache.element.classList.toggle(
            "playback-active",
            this.playbackIndex >= 0 && this.sortedNodes[this.playbackIndex].id === nodeId
          );
          nodeCache.element.style.opacity = lineageSet && !lineageSet.has(nodeId) ? "0.15" : "1";
        }
      } else {
        // Unmount DOM element if out of buffer
        if (nodeCache.element) {
          nodeCache.element.remove();
          nodeCache.element = null;
        }
      }
    });

    // 2. Virtual Edge Mounting / Unmounting
    const svgOverlay = this.querySelector("#svg-edges");
    this.edgeElements.forEach((edge) => {
      const isVisible =
        (edge.sourceY >= scrollTop - buffer && edge.sourceY <= viewBottom + buffer) ||
        (edge.targetY >= scrollTop - buffer && edge.targetY <= viewBottom + buffer);

      if (isVisible && svgOverlay) {
        if (!edge.pathEl) {
          const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          path.setAttribute("class", "lineage-edge-path");
          path.setAttribute("d", edge.pathD);
          svgOverlay.appendChild(path);
          edge.pathEl = path;
        }

        const isConnectedToSelected =
          this.selectedNodeId &&
          (edge.fromId === this.selectedNodeId || edge.toId === this.selectedNodeId);
        const inLineage = lineageSet && lineageSet.has(edge.fromId) && lineageSet.has(edge.toId);

        edge.pathEl.classList.toggle("highlighted", Boolean(isConnectedToSelected || inLineage));
        edge.pathEl.classList.toggle(
          "dimmed",
          Boolean(this.selectedNodeId && !isConnectedToSelected && !inLineage)
        );
      } else {
        if (edge.pathEl) {
          edge.pathEl.remove();
          edge.pathEl = null;
        }
      }
    });

    // 3. Update Playback Time Scrubber
    const scrubber = this.querySelector("#time-scrubber");
    if (scrubber) {
      if (this.playbackIndex >= 0 && this.sortedNodes.length > 0) {
        const activeNode = this.sortedNodes[this.playbackIndex];
        const activeCache = this.nodeElements.get(activeNode.id);
        if (activeCache && typeof activeCache.absoluteY === "number") {
          scrubber.style.top = `${activeCache.absoluteY + 16}px`;
          scrubber.classList.add("active");
        } else {
          scrubber.classList.remove("active");
        }
      } else {
        scrubber.classList.remove("active");
      }
    }
  }

  selectNode(nodeId) {
    this.selectedNodeId = nodeId;
    const node = this.data && this.data.nodes ? this.data.nodes.find((n) => n.id === nodeId) : null;

    const idx = this.sortedNodes.findIndex((n) => n.id === nodeId);
    if (idx >= 0) this.playbackIndex = idx;

    if (node) this.openDrawer(node);

    this.updateLayout();

    this.dispatchEvent(
      new CustomEvent("node-selected", {
        bubbles: true,
        composed: true,
        detail: {
          nodeId,
          node,
          stepIndex: idx >= 0 ? idx : 0,
          stepTotal: this.sortedNodes.length
        }
      })
    );
  }

  openDrawer(node) {
    const drawer = this.querySelector("#inspector-drawer");
    const title = this.querySelector("#drawer-node-title");
    const body = this.querySelector("#drawer-node-body");

    if (!drawer || !body) return;

    if (title) title.textContent = node.label;

    let timeStr = new Date(node.timestamp).toLocaleString();
    let metadataRows = "";

    if (node.metadata) {
      Object.entries(node.metadata).forEach(([key, val]) => {
        metadataRows += `
          <div class="lineage-detail-row">
            <span class="lineage-detail-label">${key}</span>
            <div class="lineage-detail-value">${typeof val === "object" ? JSON.stringify(val, null, 2) : val}</div>
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

    drawer.classList.add("open");
  }

  closeDrawer() {
    const drawer = this.querySelector("#inspector-drawer");
    if (drawer) drawer.classList.remove("open");
    this.selectedNodeId = null;
    this.updateLayout();
  }
}

if (!customElements.get("lineage-timeline")) {
  customElements.define("lineage-timeline", LineageTimeline);
}
