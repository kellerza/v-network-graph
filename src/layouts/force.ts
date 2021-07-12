import { toRef } from "@vue/reactivity"
import { watch } from "@vue/runtime-core"
import { Edge, Edges, NodePositions, OnClickHandler, OnDragHandler } from "@/common/types"
import * as d3 from "d3-force"
import { LayoutActivateParameters, LayoutHandler } from "./handler"

export interface ForceNodeDatum extends d3.SimulationNodeDatum {
  id: string
}

export interface ForceEdgeDatum extends Edge {
  index: number
}

export type ForceEdges = d3.ForceLink<d3.SimulationNodeDatum, ForceEdgeDatum>

export type CreateSimulationFunction = (
  nodeLayouts: ForceNodeDatum[],
  edges: ForceEdges
) => d3.Simulation<ForceNodeDatum, ForceEdgeDatum>

export type ForceLayoutParameters = {
  positionFixedByDrag?: boolean
  positionFixedByClickWithAltKey?: boolean
  createSimulation?: CreateSimulationFunction
}

export class ForceLayout implements LayoutHandler {
  private onDeactivate?: () => void

  constructor(private options: ForceLayoutParameters = {}) {}

  activate(parameters: LayoutActivateParameters): void {
    const { layouts, nodes, edges, emitter, svgPanZoom } = parameters
    let { nodeLayouts, nodeLayoutMap } = this.buildNodeLayouts(layouts)

    const simulation = this.createSimulation(
      nodeLayouts,
      d3.forceLink(this.forceLayoutEdges(edges)).id((d: any) => d.id)
    )
    simulation.on("tick", () => {
      for (const node of nodeLayouts) {
        const layout = layouts?.[node.id]
        if (layout) {
          layout.x = node.x ?? 0
          layout.y = node.y ?? 0
        }
      }
    })

    const restartSimulation = () => {
      simulation.alpha(0.1).restart()
    }

    const onDrag: OnDragHandler = positions => {
      for (const [id, pos] of Object.entries(positions)) {
        const nodePos = nodeLayoutMap[id]
        nodePos.fx = pos.x
        nodePos.fy = pos.y
      }
      restartSimulation()
    }

    const onDragEnd: OnDragHandler = positions => {
      for (const [id, pos] of Object.entries(positions)) {
        const layout = this.getNodeLayout(layouts, id)
        const nodePos: d3.SimulationNodeDatum = nodeLayoutMap?.[id] ?? { x: 0, y: 0 }
        if (layout.value.fixed || this.options.positionFixedByDrag) {
          nodePos.fx = pos.x
          nodePos.fy = pos.y
          layout.value.fixed = true
        } else {
          nodePos.x = pos.x
          nodePos.y = pos.y
          delete nodePos.fx
          delete nodePos.fy
        }
      }
      restartSimulation()
    }

    const onClick: OnClickHandler = ({ node, event }) => {
      if (this.options.positionFixedByClickWithAltKey && event.altKey) {
        const layout = this.getNodeLayout(layouts, node)
        let nodePos: ForceNodeDatum | undefined = nodeLayoutMap?.[node]
        if (!nodePos) {
          nodePos = { id: node, x: 0, y: 0 }
          nodeLayoutMap[node] = nodePos
        }

        if (layout.value.fixed) {
          // unfix
          delete layout.value.fixed
          nodePos.x = nodePos.fx || nodePos.x
          nodePos.y = nodePos.fy || nodePos.y
          delete nodePos.fx
          delete nodePos.fy
        } else {
          // fix
          layout.value.fixed = true
          nodePos.fx = nodePos.x
          nodePos.fy = nodePos.y
        }
        restartSimulation()
      }
    }

    const stopNodeWatch = watch(
      () => Object.keys(nodes),
      (nodeIds) => {
        // set new node's position to center of the view
        const newNodes = nodeIds.filter(n => !(n in layouts))
        const area = svgPanZoom.getViewArea()
        for (const nodeId of newNodes) {
          layouts[nodeId] = { ...area.center }
        }

        ({ nodeLayouts, nodeLayoutMap } = this.buildNodeLayouts(layouts))
        simulation.nodes(nodeLayouts)
        // ノードを入れ替えるとリンク情報も途切れてしまうため再投入する
        const forceEdges = simulation.force("edge") as any
        forceEdges.edges(this.forceLayoutEdges(edges))
        restartSimulation()
      }
    )
    const stopEdgeWatch = watch(
      () => edges,
      () => {
        const forceEdges = simulation.force("edge") as any
        forceEdges.edges(this.forceLayoutEdges(edges))
        restartSimulation()
      },
      { deep: true }
    )

    emitter.on("node:dragstart", onDrag)
    emitter.on("node:mousemove", onDrag)
    emitter.on("node:dragend", onDragEnd)
    emitter.on("node:click", onClick)

    this.onDeactivate = () => {
      simulation.stop()
      stopNodeWatch()
      stopEdgeWatch()
      emitter.off("node:dragstart", onDrag)
      emitter.off("node:mousemove", onDrag)
      emitter.off("node:dragend", onDragEnd)
      emitter.off("node:click", onClick)
    }
  }

  deactivate(): void {
    if (this.onDeactivate) {
      this.onDeactivate()
    }
  }

  private createSimulation(
    nodeLayouts: ForceNodeDatum[],
    edges: ForceEdges
  ): d3.Simulation<ForceNodeDatum, ForceEdgeDatum> {
    if (this.options.createSimulation) {
      return this.options.createSimulation(nodeLayouts, edges)
    } else {
      return d3.forceSimulation(nodeLayouts)
        .force("edge", edges.distance(100))
        .force("charge", d3.forceManyBody())
        .force("collide", d3.forceCollide(50).strength(0.2))
        .force("center", d3.forceCenter().strength(0.05))
        .alphaMin(0.01)
    }
  }

  private buildNodeLayouts(layouts: NodePositions) {
    const nodeLayouts = this.forceNodeLayouts(layouts)
    const nodeLayoutMap = Object.fromEntries(nodeLayouts.map(n => [n.id, n]))
    return { nodeLayouts, nodeLayoutMap }
  }

  private forceNodeLayouts(layouts: NodePositions): ForceNodeDatum[] {
    return Object.entries(layouts).map(([id, v]) => ({ id, ...v }))
  }

  private forceLayoutEdges(edges: Edges): ForceEdgeDatum[] {
    // d3-forceによってedge内のsource/targetがNodeDatumオブジェクトに
    // 置き換えられてしまうため、独自のリンクオブジェクトを構築する.
    return Object.values(edges).map((v, index) => ({
      index,
      source: v.source,
      target: v.target,
    }))
  }

  private getNodeLayout(layouts: NodePositions, node: string) {
    const layout = toRef(layouts, node)
    if (!layout.value) {
      layout.value = { x: 0, y: 0 }
    }
    return layout
  }
}