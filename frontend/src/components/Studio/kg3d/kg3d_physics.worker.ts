import * as d3 from 'd3-force-3d';

/**
 * KG3D Physics Worker (KG3D-F5)
 * Offloads graph layout computation to avoid UI jank on large ontologies.
 */

self.onmessage = (event: MessageEvent) => {
  const { nodes, links, iterations = 1 } = event.data;

  // Initialize simulation
  const simulation = d3.forceSimulation(nodes, 3)
    .force('link', d3.forceLink(links).id((d: any) => d.id).distance(50))
    .force('charge', d3.forceManyBody().strength(-100))
    .force('center', d3.forceCenter(0, 0, 0))
    .stop();

  // Run iterations
  for (let i = 0; i < iterations; i++) {
    simulation.tick();
  }

  // Send back updated positions
  self.postMessage({
    nodes: nodes.map((n: any) => ({
      id: n.id,
      x: n.x,
      y: n.y,
      z: n.z
    }))
  });
};
