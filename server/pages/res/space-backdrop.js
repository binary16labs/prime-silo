(function attachPrimeSiloDotMatrixBackdrop(windowObject) {
  if (windowObject.__primeSiloDotMatrixLoaded) return;
  windowObject.__primeSiloDotMatrixLoaded = true;

  class DotMatrixEngine {
    constructor() {
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d');
      this.canvas.className = 'prime-silo-dot-canvas';
      this.canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:0;';
      
      document.body.appendChild(this.canvas);

      this.dots = [];
      this.gridSpacing = 28; // 28px grid spacing
      this.mouseX = -1000;
      this.mouseY = -1000;
      this.targetMouseX = -1000;
      this.targetMouseY = -1000;
      this.time = 0;
      this.reducedMotion = windowObject.matchMedia('(prefers-reduced-motion: reduce)').matches;

      this.init();
    }

    init() {
      this.resize();
      windowObject.addEventListener('resize', () => this.resize());
      windowObject.addEventListener('mousemove', (e) => {
        this.targetMouseX = e.clientX;
        this.targetMouseY = e.clientY;
      });

      if (!this.reducedMotion) {
        requestAnimationFrame(() => this.loop());
      } else {
        this.drawStatic();
      }
    }

    resize() {
      this.width = windowObject.innerWidth;
      this.height = windowObject.innerHeight;
      const dpr = windowObject.devicePixelRatio || 1;
      this.canvas.width = this.width * dpr;
      this.canvas.height = this.height * dpr;
      this.ctx.scale(dpr, dpr);

      this.cols = Math.ceil(this.width / this.gridSpacing) + 1;
      this.rows = Math.ceil(this.height / this.gridSpacing) + 1;

      this.dots = [];
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          this.dots.push({
            x: c * this.gridSpacing,
            y: r * this.gridSpacing,
            baseRadius: 1.5,
            radius: 1.5,
            phase: Math.sin(c * 0.4 + r * 0.3)
          });
        }
      }
    }

    loop() {
      this.time += 0.018;

      // Smooth mouse lerp
      this.mouseX += (this.targetMouseX - this.mouseX) * 0.1;
      this.mouseY += (this.targetMouseY - this.mouseY) * 0.1;

      this.ctx.clearRect(0, 0, this.width, this.height);

      const maxDist = 150;

      for (let i = 0; i < this.dots.length; i++) {
        const dot = this.dots[i];

        const dx = dot.x - this.mouseX;
        const dy = dot.y - this.mouseY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        let targetRadius = dot.baseRadius;
        let alpha = 0.22;
        let color = `rgba(156, 175, 136, ${alpha})`; // Sage

        if (dist < maxDist) {
          const factor = (1 - dist / maxDist);
          targetRadius = dot.baseRadius + (factor * 3.5); // Spring expansion
          alpha = 0.22 + (factor * 0.65);
          
          if (factor > 0.6) {
            color = `rgba(236, 230, 216, ${alpha})`; // Bone highlight
          } else {
            color = `rgba(196, 168, 130, ${alpha})`; // Taupe transition
          }
        } else {
          // Ambient sinewave breathing
          const pulse = Math.sin(this.time * 1.5 + dot.phase * 3) * 0.3 + 0.3;
          targetRadius = dot.baseRadius + (pulse * 0.4);
          alpha = 0.18 + (pulse * 0.1);
          color = `rgba(156, 175, 136, ${alpha})`;
        }

        dot.radius += (targetRadius - dot.radius) * 0.15;

        this.ctx.beginPath();
        this.ctx.arc(dot.x, dot.y, dot.radius, 0, Math.PI * 2);
        this.ctx.fillStyle = color;
        this.ctx.fill();
      }

      requestAnimationFrame(() => this.loop());
    }

    drawStatic() {
      this.ctx.clearRect(0, 0, this.width, this.height);
      this.ctx.fillStyle = 'rgba(156, 175, 136, 0.25)';
      for (let i = 0; i < this.dots.length; i++) {
        const dot = this.dots[i];
        this.ctx.beginPath();
        this.ctx.arc(dot.x, dot.y, 1.5, 0, Math.PI * 2);
        this.ctx.fill();
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => new DotMatrixEngine());
  } else {
    new DotMatrixEngine();
  }
})(typeof window !== 'undefined' ? window : this);
