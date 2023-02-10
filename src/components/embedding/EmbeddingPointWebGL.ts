import { config } from '../../config/config';
import { timeit, rgbToHex } from '../../utils/utils';
import d3 from '../../utils/d3-import';
import type { Embedding } from './Embedding';
import type { PromptPoint } from '../../types/embedding-types';
import fragmentShader from './shaders/point.frag?raw';
import vertexShader from './shaders/point.vert?raw';

const SCATTER_DOT_RADIUS = 2;
const DEBUG = config.debug;

let pointMouseleaveTimer: number | null = null;
let pointMouseenterTimer: number | null = null;

/**
 * Initialize the data => stage, stage => [-1, 1] transformation matrices
 * @param this Embedding object
 */
export function initWebGLMatrices(this: Embedding) {
  // Convert the x and y scales to a matrix (applying scale is cheaper in GPU)
  const xDomainMid = (this.xScale.domain()[0] + this.xScale.domain()[1]) / 2;
  const yDomainMid = (this.yScale.domain()[0] + this.yScale.domain()[1]) / 2;

  const xRangeMid = (this.xScale.range()[0] + this.xScale.range()[1]) / 2;
  const yRangeMid = (this.yScale.range()[0] + this.yScale.range()[1]) / 2;

  const xMultiplier =
    (this.xScale.range()[1] - this.xScale.range()[0]) /
    (this.xScale.domain()[1] - this.xScale.domain()[0]);

  const yMultiplier =
    (this.yScale.range()[1] - this.yScale.range()[0]) /
    (this.yScale.domain()[1] - this.yScale.domain()[0]);

  // WebGL is column-major!
  // Transform from data space to stage space (same as applying this.xScale(),
  // and this.yScale())
  const dataScaleMatrix = [
    [xMultiplier, 0, -xMultiplier * xDomainMid + xRangeMid],
    [0, yMultiplier, -yMultiplier * yDomainMid + yRangeMid],
    [0, 0, 1]
  ];
  const dataScaleMatrix1D = dataScaleMatrix.flat();

  // Transforming the stage space to the normalized coordinate
  // Note we need to flip the y coordinate
  const normalizeMatrix = [
    [2 / this.svgSize.width, 0, -1],
    [0, -2 / this.svgSize.height, 1],
    [0, 0, 1]
  ];
  const normalizeMatrix1D = normalizeMatrix.flat();

  this.webGLMatrices = {
    dataScaleMatrix: dataScaleMatrix1D,
    normalizeMatrix: normalizeMatrix1D
  };
}

/**
 * Draw a scatter plot for the UMAP.
 */
export function drawScatterPlot(this: Embedding) {
  if (!this.webGLMatrices || !this.showPoint) {
    throw Error('webGLMatrices or showPoint not initialized');
  }

  // Get the current zoom
  const zoomMatrix = getZoomMatrix(this.curZoomTransform);

  // Get the position and color of each point
  const positions: number[][] = [];
  const colors: number[][] = [];

  for (const point of this.promptPoints) {
    const color = [0, 0, 0];

    positions.push([point.x, point.y]);
    colors.push(color);
  }

  const drawPoints = this.pointRegl({
    frag: fragmentShader,
    vert: vertexShader,

    attributes: {
      position: positions,
      color: colors
    },

    uniforms: {
      // Placeholder for function parameters
      pointWidth: SCATTER_DOT_RADIUS,
      dataScaleMatrix: this.webGLMatrices.dataScaleMatrix,
      zoomMatrix: zoomMatrix,
      normalizeMatrix: this.webGLMatrices.normalizeMatrix,
      isBackPoint: false
    },

    count: positions.length,
    primitive: 'points'
  });

  drawPoints();
}

/**
 * Draw a second scatter plot underneath the visible plot for color picking.
 */
export function drawScatterBackPlot(this: Embedding) {
  if (!this.webGLMatrices || !this.showPoint) {
    throw Error('webGLMatrices or showPoint not initialized');
  }

  // Get the current zoom
  const zoomMatrix = getZoomMatrix(this.curZoomTransform);

  // Trick: here we draw a slightly larger circle when user zooms out the
  // viewpoint, so that the pixel coverage is higher (smoother/better
  // mouseover picking)

  // Get the position and color of each point
  const positions: number[][] = [];
  const colors: number[][] = [];

  this.colorPointMap.clear();
  this.pointBackRegl.clear({
    color: [0, 0, 0, 0],
    depth: 1,
    stencil: 0
  });

  for (const point of this.promptPoints) {
    const color = this.getNextUniqueColor();
    this.colorPointMap.set(color.toString(), point);

    positions.push([point.x, point.y]);
    colors.push(color.map(d => d / 255));
  }

  const drawPoints = this.pointBackRegl({
    frag: fragmentShader,
    vert: vertexShader,

    attributes: {
      position: positions,
      color: colors
    },

    uniforms: {
      // Placeholder for function parameters
      pointWidth: SCATTER_DOT_RADIUS,
      dataScaleMatrix: this.webGLMatrices.dataScaleMatrix,
      zoomMatrix: zoomMatrix,
      normalizeMatrix: this.webGLMatrices.normalizeMatrix,
      isBackPoint: true
    },

    count: positions.length,
    primitive: 'points'
  });

  drawPoints();
}

/**
 * Get a unique color in hex.
 */
export function getNextUniqueColor(this: Embedding) {
  if (this.colorPointMap.size >= 256 * 256 * 256) {
    console.error('Unique color overflow.');
    return [255, 255, 255];
  }

  const rng = d3.randomInt(0, 256);
  let randomRGB = [rng(), rng(), rng()];
  let randomRGBStr = randomRGB.toString();
  while (
    this.colorPointMap.has(randomRGBStr) ||
    randomRGB.reduce((a, b) => a + b) === 0
  ) {
    randomRGB = [rng(), rng(), rng()];
    randomRGBStr = randomRGB.toString();
  }
  return randomRGB;
}

/**
 * Highlight the point where the user hovers over
 * @param point The point that user hovers over
 */
export function highlightPoint(
  this: Embedding,
  point: PromptPoint | undefined
) {
  if (this.hoverMode !== 'point') return;
  if (!this.showPoint) return;
  if (point === this.hoverPoint) return;

  // Draw the point on the top svg
  const group = this.topSvg.select('g.top-content g.highlights');
  const oldHighlightPoint = group.select('circle.highlight-point');

  // Hovering empty space
  if (point === undefined) {
    if (!oldHighlightPoint.empty()) {
      if (pointMouseleaveTimer !== null) {
        clearTimeout(pointMouseleaveTimer);
        pointMouseleaveTimer = null;
      }

      // Clear the highlight and tooltip in a short delay
      pointMouseleaveTimer = setTimeout(() => {
        this.hoverPoint = null;
        oldHighlightPoint.remove();
        this.tooltipStoreValue.show = false;
        this.tooltipStore.set(this.tooltipStoreValue);
        pointMouseleaveTimer = null;
      }, 50);
    }
    return;
  }

  // Hovering over a point
  this.hoverPoint = point;
  if (pointMouseleaveTimer !== null) {
    clearTimeout(pointMouseleaveTimer);
    pointMouseleaveTimer = null;
  }

  // There is no point highlighted yet
  const highlightRadius = Math.max(
    SCATTER_DOT_RADIUS * 1.5,
    7 / this.curZoomTransform.k
  );
  const highlightStroke = 1.2 / this.curZoomTransform.k;

  if (oldHighlightPoint.empty()) {
    const highlightPoint = group
      .append('circle')
      .attr('class', 'highlight-point')
      .attr('cx', this.xScale(point.x))
      .attr('cy', this.yScale(point.y))
      .attr('r', highlightRadius)
      .style('stroke-width', highlightStroke);

    // Get the point position
    const position = highlightPoint.node()!.getBoundingClientRect();
    const curWidth = position.width;
    const tooltipCenterX = position.x + curWidth / 2;
    const tooltipCenterY = position.y;
    this.tooltipStoreValue.html = `
          <div class='tooltip-content' style='display: flex; flex-direction:
            column; justify-content: center;'>
            ${point.prompt}
          </div>
        `;

    this.tooltipStoreValue.x = tooltipCenterX;
    this.tooltipStoreValue.y = tooltipCenterY;
    this.tooltipStoreValue.show = true;

    if (pointMouseenterTimer !== null) {
      clearTimeout(pointMouseenterTimer);
      pointMouseenterTimer = null;
    }

    // Show the tooltip after a delay
    pointMouseenterTimer = setTimeout(() => {
      this.tooltipStore.set(this.tooltipStoreValue);
      pointMouseenterTimer = null;
    }, 300);
  } else {
    // There has been a highlighted point already
    oldHighlightPoint
      .attr('cx', this.xScale(point.x))
      .attr('cy', this.yScale(point.y))
      .attr('r', highlightRadius)
      .style('stroke-width', highlightStroke);

    // Get the point position
    const position = (
      oldHighlightPoint.node()! as HTMLElement
    ).getBoundingClientRect();
    const curWidth = position.width;
    const tooltipCenterX = position.x + curWidth / 2;
    const tooltipCenterY = position.y;
    this.tooltipStoreValue.html = `
          <div class='tooltip-content' style='display: flex; flex-direction:
            column; justify-content: center;'>
            ${point.prompt}
          </div>
        `;
    this.tooltipStoreValue.x = tooltipCenterX;
    this.tooltipStoreValue.y = tooltipCenterY;
    this.tooltipStoreValue.show = true;

    if (pointMouseenterTimer !== null) {
      clearTimeout(pointMouseenterTimer);
      pointMouseenterTimer = setTimeout(() => {
        this.tooltipStore.set(this.tooltipStoreValue);
        pointMouseenterTimer = null;
      }, 300);
    } else {
      this.tooltipStore.set(this.tooltipStoreValue);
    }
  }
}

/**
 * Convert the current zoom transform into a matrix
 * @param zoomTransform D3 zoom transform
 * @returns 1D matrix
 */
const getZoomMatrix = (zoomTransform: d3.ZoomTransform) => {
  // Transforming the stage space based on the current zoom transform
  const zoomMatrix = [
    [zoomTransform.k, 0, zoomTransform.x],
    [0, zoomTransform.k, zoomTransform.y],
    [0, 0, 1]
  ];
  const zoomMatrix1D = zoomMatrix.flat();
  return zoomMatrix1D;
};
