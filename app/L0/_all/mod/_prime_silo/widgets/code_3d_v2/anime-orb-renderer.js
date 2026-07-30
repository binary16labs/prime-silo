const anime = window.anime;

const BOUNDARY_PAT = /(api|routes|cli|ui|frontend|pages|components|widgets|view)/i;
const CONTROL_PAT = /(manager|controller|service|orchestrator|bridge|proxy|handler)/i;
const ENTITY_PAT = /(model|schema|struct|core|type|interface)/i;

const NODE_TYPE_COLORS = {
  Folder: "#FFD700",
  File: "#00FFFF",
  Module: "#94a3b8",
  Class: "#007ACC",
  Function: "#FF5F1F",
  Concept: "#a78bfa",
  default: "#64748b"
};

const EDGE_TYPE_COLORS = {
  DEFINES: "#ffffff",
  INHERITS: "#39FF14",
  CALLS: "#FF5F1F",
  DEPENDS_ON: "#00FFFF",
  CORRELATES_WITH: "#ec4899",
  REL: "#94a3b8",
  default: "rgba(148, 163, 184, 0.6)"
};

function classifyRobustness(node) {
  if (node.type === "Concept") return { category: "Concept", layer: 1, z: 300 };

  const name = node.name || "";
  const pathStr = node.id || ""; // fallback since path isn't directly passed

  if (BOUNDARY_PAT.test(name) || BOUNDARY_PAT.test(pathStr)) {
    return { category: "Boundary", layer: 2, z: 100 };
  } else if (CONTROL_PAT.test(name) || CONTROL_PAT.test(pathStr)) {
    return { category: "Control", layer: 3, z: -100 };
  } else if (ENTITY_PAT.test(name) || ENTITY_PAT.test(pathStr)) {
    return { category: "Entity", layer: 4, z: -300 };
  }

  return { category: "Unclassified", layer: 5, z: -500 };
}

export function makeAnimeOrbRenderer(options = {}) {
  const container = document.createElement("div");
  container.className = "code-3d-v2-container";

  const scene = document.createElement("div");
  scene.className = "code-3d-v2-scene";

  const svgNS = "http://www.w3.org/2000/svg";
  const edgesSvg = document.createElementNS(svgNS, "svg");
  edgesSvg.setAttribute("class", "code-3d-v2-edges");

  container.appendChild(scene);
  container.appendChild(edgesSvg);

  // Load stylesheet
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/mod/_prime_silo/widgets/code_3d_v2/code-3d-v2.css";
  document.head.appendChild(link);

  let currentNodes = [];
  let currentEdges = [];
  let nodeEls = new Map();
  let edgeEls = new Map();

  let panX = 0,
    panY = 0;
  let rotateX = 60,
    rotateZ = 0;
  let isDragging = false;
  let lastMouseX = 0,
    lastMouseY = 0;

  function updateSceneTransform() {
    scene.style.transform = `translate3d(${panX}px, ${panY}px, 0) rotateX(${rotateX}deg) rotateZ(${rotateZ}deg)`;
    edgesSvg.style.transform = `translate3d(${panX}px, ${panY}px, 0) rotateX(${rotateX}deg) rotateZ(${rotateZ}deg)`;
  }

  container.addEventListener("mousedown", (e) => {
    isDragging = true;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  });

  window.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const dx = e.clientX - lastMouseX;
    const dy = e.clientY - lastMouseY;

    if (e.shiftKey) {
      panX += dx;
      panY += dy;
    } else {
      rotateZ += dx * 0.5;
      rotateX -= dy * 0.5;
    }

    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    updateSceneTransform();
  });

  window.addEventListener("mouseup", () => {
    isDragging = false;
  });

  // Calculate layout
  function computeRadialLayout(nodes) {
    const layers = { 1: [], 2: [], 3: [], 4: [], 5: [] };

    nodes.forEach((n) => {
      const classification = classifyRobustness(n);
      n.classification = classification;
      layers[classification.layer].push(n);
    });

    Object.keys(layers).forEach((layerIdx) => {
      const layerNodes = layers[layerIdx];
      const count = layerNodes.length;
      if (count === 0) return;

      const radius = 200 + parseInt(layerIdx) * 150; // Wider radius gap for clarity

      layerNodes.forEach((n, i) => {
        const angle = (i / count) * Math.PI * 2;
        n.layoutX = Math.cos(angle) * radius;
        n.layoutY = Math.sin(angle) * radius;
        n.layoutZ = 0; // Flatten Z to align with SVG edges
      });
    });
  }

  function updateEdges() {
    edgesSvg.innerHTML = "";

    currentEdges.forEach((edge) => {
      const source = nodeEls.get(edge.source);
      const target = nodeEls.get(edge.target);

      if (!source || !target) return;

      const sNode = currentNodes.find((n) => n.id === edge.source);
      const tNode = currentNodes.find((n) => n.id === edge.target);

      if (!sNode || !tNode) return;

      const path = document.createElementNS(svgNS, "path");
      path.setAttribute("class", "edge-path");

      // Control points for a nice 3D curve look
      const mx = (sNode.layoutX + tNode.layoutX) / 2;
      const my = (sNode.layoutY + tNode.layoutY) / 2;

      path.setAttribute(
        "d",
        `M ${sNode.layoutX} ${sNode.layoutY} Q ${mx} ${my} ${tNode.layoutX} ${tNode.layoutY}`
      );

      const color = EDGE_TYPE_COLORS[edge.type] || EDGE_TYPE_COLORS.default;
      path.style.stroke = color;

      edgesSvg.appendChild(path);
      edgeEls.set(`${edge.source}-${edge.target}`, path);
    });
  }

  updateSceneTransform();

  const renderer = {
    mount: (hostEl, layout, props) => {
      hostEl.appendChild(container);

      // Setup UI controls
      const controls = document.createElement("div");
      controls.className = "code-3d-v2-controls";

      const resetBtn = document.createElement("button");
      resetBtn.className = "code-3d-btn";
      resetBtn.textContent = "Reset View";
      resetBtn.onclick = () => {
        panX = 0;
        panY = 0;
        rotateX = 60;
        rotateZ = 0;
        updateSceneTransform();
      };
      controls.appendChild(resetBtn);

      container.appendChild(controls);

      if (layout) renderer.update(layout, props);

      return renderer;
    },

    update: ({ positions }, props) => {
      // We will parse positions or nodes directly.
      // The canvas index.js passes `layout, props` to mount and update.
      // layout = { positions, edges, width, height }

      // We need nodes, which are buried in positions[id].node
      let nodes = [];
      let edges = props?.data?.edges || []; // fallback or fetch them

      if (positions) {
        nodes = Object.values(positions)
          .map((p) => p.node)
          .filter(Boolean);
      } else if (arguments[0].nodes) {
        // If called directly with {nodes, edges}
        nodes = arguments[0].nodes;
        edges = arguments[0].edges || [];
      }
      currentNodes = nodes;
      currentEdges = edges;
      const selectedNodeId = props?.selectedNodeId;

      computeRadialLayout(nodes);

      // Clear scene
      scene.innerHTML = "";
      nodeEls.clear();
      edgeEls.clear();

      nodes.forEach((n) => {
        const el = document.createElement("div");
        el.className = "orb-node";

        if (n.id === selectedNodeId) {
          el.classList.add("selected");
        }

        const size = n.type === "Concept" ? 40 : 24;
        el.style.width = `${size}px`;
        el.style.height = `${size}px`;

        const color = NODE_TYPE_COLORS[n.type] || NODE_TYPE_COLORS.default;
        el.style.borderColor = color;

        // Reticle
        const reticle = document.createElement("div");
        reticle.className = "orb-reticle";
        el.appendChild(reticle);

        // Label
        const label = document.createElement("div");
        label.className = "orb-label";
        label.textContent = n.name || "Unknown";
        el.appendChild(label);

        // Badge
        const badge = document.createElement("div");
        badge.className = "orb-layer-badge";
        badge.textContent = n.classification.category;
        el.appendChild(badge);

        // Initial position (center) for animation
        el.style.transform = `translate3d(-50%, -50%, 0)`;

        el.addEventListener("click", () => {
          if (options.onSelect) options.onSelect(n.id);
        });

        scene.appendChild(el);
        nodeEls.set(n.id, el);

        // Animate to position
        anime({
          targets: el,
          translateX: n.layoutX,
          translateY: n.layoutY,
          translateZ: n.layoutZ,
          duration: 1500 + Math.random() * 1000,
          easing: "easeOutElastic(1, .8)"
        });
      });

      // Delay edges until nodes are mostly in place
      setTimeout(updateEdges, 1000);
    },

    dispose: () => {
      if (link.parentNode) link.parentNode.removeChild(link);
      container.remove();
    }
  };
  return renderer;
}
