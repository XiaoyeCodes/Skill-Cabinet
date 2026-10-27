---
name: "threejs-skills"
display_name: "Three.js · 3D 开发技能集"
description: "Three.js 三维场景开发技能集，覆盖场景、几何、材质、灯光、纹理、动画、模型加载、着色器、后期处理、交互、性能、React Three Fiber 与资产管线；按任务选择包内 13 份完整参考技能。"
version: "1.0.0"
author: "CloudAI-X"
tags: ["Three.js","3D","WebGL","WebGPU","React Three Fiber"]
category: "开发与工具"
---

# Three.js · 3D 开发技能集

来源：[CloudAI-X/threejs-skills](https://github.com/CloudAI-X/threejs-skills/tree/0e181866f095b5f06d005133876e926515390d95)。这是一个集合入口，按当前任务阅读下列参考文件；上游的 13 份技能保持原文。

## 选择参考技能

| 任务 | 参考文件 |
| --- | --- |
| 场景、相机、渲染器、变换与动画循环 | `library/threejs-fundamentals/SKILL.md` |
| 几何体、实例化、点与线 | `library/threejs-geometry/SKILL.md` |
| 材质、PBR、混合与节点材质 | `library/threejs-materials/SKILL.md` |
| 灯光、阴影与环境光 | `library/threejs-lighting/SKILL.md` |
| 纹理、色彩空间、UV 与显存 | `library/threejs-textures/SKILL.md` |
| 关键帧、骨骼、变形与动画混合 | `library/threejs-animation/SKILL.md` |
| glTF、Draco、meshopt、KTX2 与加载清理 | `library/threejs-loaders/SKILL.md` |
| ShaderMaterial、TSL 与 WebGPU | `library/threejs-shaders/SKILL.md` |
| EffectComposer 与 RenderPipeline | `library/threejs-postprocessing/SKILL.md` |
| 拾取、相机控制、拖拽与框选 | `library/threejs-interaction/SKILL.md` |
| 帧耗时、绘制调用、内存与编译瓶颈 | `library/threejs-performance/SKILL.md` |
| React Three Fiber 与 drei | `library/threejs-react-three-fiber/SKILL.md` |
| gltf-transform 压缩与资产处理 | `library/threejs-asset-pipeline/SKILL.md` |

## 使用流程

1. 确认项目中安装的 Three.js、R3F、drei 版本与渲染后端。
2. 阅读与任务有关的参考技能，包括其 Common Mistakes 和 See Also。
3. 结合现有项目修改代码，并在实际浏览器验证渲染、交互与资源释放。

本快照上游声明面向 Three.js r186、React Three Fiber 9.8、drei 10.7 和 gltf-transform 4.5；项目版本不同时应核对相应 API。具体依赖由目标项目安装。

## 包内资料

- `catalog.json`：13 份技能的名称、描述、路径与摘要。
- `upstream/README.md`、`LICENSE`：上游说明与 MIT 许可证。
- `CABINET_SOURCE.json`：固定提交、路径映射与逐文件校验值。
- `使用说明.md`：收藏、导出与按需安装方法。
