/*
 Copyright (c) 2020 Xiamen Yaji Software Co., Ltd.

 https://www.cocos.com/

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated engine source code (the "Software"), a limited,
 worldwide, royalty-free, non-assignable, revocable and non-exclusive license
 to use Cocos Creator solely to develop games on your target platforms. You shall
 not use Cocos Creator software for developing other software or tools that's
 used for developing games. You are not granted to publish, distribute,
 sublicense, and/or sell copies of Cocos Creator.

 The software or tools in this License Agreement are licensed, not sold.
 Xiamen Yaji Software Co., Ltd. reserves all rights not expressly granted to you.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 THE SOFTWARE.
 */

import { PIPELINE_FLOW_SHADOW, supportsR32FloatTexture, UBOCamera, UBOCSM, UBOGlobal, UBOShadow } from '../define';
import { IRenderFlowInfo, RenderFlow } from '../render-flow';
import { ForwardFlowPriority } from '../enum';
import { ReflectionProbeStage } from './reflectionProbe-stage';
import { RenderPass, LoadOp, StoreOp,
    Format, Texture, TextureType, TextureUsageBit, ColorAttachment,
    DepthStencilAttachment, RenderPassInfo, TextureInfo, FramebufferInfo, Swapchain,
    Framebuffer, DescriptorSet, API } from '../../gfx';
import { RenderFlowTag } from '../pipeline-serialization';
import { ForwardPipeline } from '../forward/forward-pipeline';
import { RenderPipeline } from '..';
import { Light } from '../../renderer/scene/light';
import { Camera } from '../../renderer/scene';
import { ccclass } from '../../data/decorators';

/**
 * @en ReflectionProbe render flow
 * @zh 反射探针RenderTexture绘制流程
 */
@ccclass('ReflectionProbeFlow')
export class ReflectionProbeFlow extends RenderFlow {
    /**
     * @en A common initialization info for shadow map render flow
     * @zh 一个通用的 ShadowFlow 的初始化信息对象
     */
    public static initInfo: IRenderFlowInfo = {
        name: PIPELINE_FLOW_SHADOW,
        priority: ForwardFlowPriority.SHADOW,
        tag: RenderFlowTag.SCENE,
        stages: [],
    };

    private _shadowRenderPass: RenderPass|null = null;

    public initialize (info: IRenderFlowInfo): boolean {
        super.initialize(info);
        if (this._stages.length === 0) {
            // add shadowMap-stages
            const shadowMapStage = new ReflectionProbeStage();
            shadowMapStage.initialize(ReflectionProbeStage.initInfo);
            this._stages.push(shadowMapStage);
        }
        return true;
    }

    public activate (pipeline: RenderPipeline) {
        super.activate(pipeline);
        pipeline.onGlobalPipelineStateChanged();
    }

    public render (camera: Camera) {
        const pipeline = this._pipeline as ForwardPipeline;
        const shadowFrameBufferMap = pipeline.pipelineSceneData.shadowFrameBufferMap;

        const { mainLight } = camera.scene!;
        if (mainLight && mainLight.shadowEnabled) {
            const globalDS = pipeline.descriptorSet;
            if (!shadowFrameBufferMap.has(mainLight)) {
                this._initShadowFrameBuffer(pipeline, mainLight, camera.window.swapchain);
            }

            const shadowFrameBuffer = shadowFrameBufferMap.get(mainLight);
            if (mainLight.shadowFixedArea) {
                this._renderStage(camera, mainLight, shadowFrameBuffer!, globalDS);
            } else {
                for (let i = 0; i < 6; i++) {
                    this._renderStage(camera, mainLight, shadowFrameBuffer!, globalDS, i);
                }
            }
        }
    }

    public destroy () {
        super.destroy();
        if (this._pipeline) {
            const shadowFrameBufferMap = this._pipeline.pipelineSceneData.shadowFrameBufferMap;
            const shadowFrameBuffers = Array.from(shadowFrameBufferMap.values());
            for (let i = 0; i < shadowFrameBuffers.length; i++) {
                const frameBuffer = shadowFrameBuffers[i];

                if (!frameBuffer) { continue; }
                const renderTargets = frameBuffer.colorTextures;
                for (let j = 0; j < renderTargets.length; j++) {
                    const renderTarget = renderTargets[j];
                    if (renderTarget) { renderTarget.destroy(); }
                }
                renderTargets.length = 0;

                const depth = frameBuffer.depthStencilTexture;
                if (depth) { depth.destroy(); }

                frameBuffer.destroy();
            }

            shadowFrameBufferMap.clear();
        }

        if (this._shadowRenderPass) { this._shadowRenderPass.destroy(); }
    }

    /**
     * @deprecated since v3.5.0, this is an engine private interface that will be removed in the future.
     */
    public _initShadowFrameBuffer  (pipeline: RenderPipeline, light: Light, swapchain: Swapchain) {
        const { device } = pipeline;
        const shadows = pipeline.pipelineSceneData.shadows;
        const shadowMapSize = shadows.size;
        const shadowFrameBufferMap = pipeline.pipelineSceneData.shadowFrameBufferMap;
        const format = supportsR32FloatTexture(device) ? Format.R32F : Format.RGBA8;

        if (!this._shadowRenderPass) {
            const colorAttachment = new ColorAttachment();
            colorAttachment.format = format;
            colorAttachment.loadOp = LoadOp.CLEAR; // should clear color attachment
            colorAttachment.storeOp = StoreOp.STORE;
            colorAttachment.sampleCount = 1;

            const depthStencilAttachment = new DepthStencilAttachment();
            depthStencilAttachment.format = Format.DEPTH_STENCIL;
            depthStencilAttachment.depthLoadOp = LoadOp.CLEAR;
            depthStencilAttachment.depthStoreOp = StoreOp.DISCARD;
            depthStencilAttachment.stencilLoadOp = LoadOp.CLEAR;
            depthStencilAttachment.stencilStoreOp = StoreOp.DISCARD;
            depthStencilAttachment.sampleCount = 1;

            const renderPassInfo = new RenderPassInfo([colorAttachment], depthStencilAttachment);
            this._shadowRenderPass = device.createRenderPass(renderPassInfo);
        }

        const shadowRenderTargets: Texture[] = [];
        shadowRenderTargets.push(device.createTexture(new TextureInfo(
            TextureType.TEX2D,
            TextureUsageBit.COLOR_ATTACHMENT | TextureUsageBit.SAMPLED,
            format,
            shadowMapSize.x,
            shadowMapSize.y,
        )));

        const depth = device.createTexture(new TextureInfo(
            TextureType.TEX2D,
            TextureUsageBit.DEPTH_STENCIL_ATTACHMENT,
            Format.DEPTH_STENCIL,
            shadowMapSize.x,
            shadowMapSize.y,
        ));

        const shadowFrameBuffer = device.createFramebuffer(new FramebufferInfo(
            this._shadowRenderPass,
            shadowRenderTargets,
            depth,
        ));

        // Cache frameBuffer
        shadowFrameBufferMap.set(light, shadowFrameBuffer);
    }

    private _renderStage (camera: Camera, light: Light, shadowFrameBuffer: Framebuffer, globalDS: DescriptorSet, level = 0) {
        for (let i = 0; i < this._stages.length; i++) {
            const shadowStage = this._stages[i] as ReflectionProbeStage;
            shadowStage.setUsage(globalDS, light, shadowFrameBuffer, level);
            shadowStage.render(camera);
        }
    }

    private clearShadowMap (validLights: Light[], camera: Camera) {
        const pipeline = this._pipeline;
        const scene = pipeline.pipelineSceneData;

        const { mainLight } = camera.scene!;
        if (mainLight) {
            const globalDS = this._pipeline.descriptorSet;
            if (!scene.shadowFrameBufferMap.has(mainLight)) {
                this._initShadowFrameBuffer(this._pipeline, mainLight, camera.window.swapchain);
            }

            const shadowFrameBuffer = scene.shadowFrameBufferMap.get(mainLight);
            for (let i = 0; i < this._stages.length; i++) {
                const shadowStage = this._stages[i] as ReflectionProbeStage;
                shadowStage.setUsage(globalDS, mainLight, shadowFrameBuffer!);
                shadowStage.clearFramebuffer(camera);
            }
        }

        for (let l = 0; l < validLights.length; l++) {
            const light = validLights[l];
            const ds = pipeline.globalDSManager.getOrCreateDescriptorSet(light)!;
            if (!scene.shadowFrameBufferMap.has(light)) {
                this._initShadowFrameBuffer(this._pipeline, light, camera.window.swapchain);
            }

            const shadowFrameBuffer = scene.shadowFrameBufferMap.get(light);
            for (let i = 0; i < this._stages.length; i++) {
                const shadowStage = this._stages[i] as ReflectionProbeStage;
                shadowStage.setUsage(ds, light, shadowFrameBuffer!);
                shadowStage.clearFramebuffer(camera);
            }
        }
    }

    private resizeShadowMap () {
        const shadows = this._pipeline.pipelineSceneData.shadows;
        const shadowMapSize = shadows.size;
        const pipeline = this._pipeline;
        const device = pipeline.device;
        const shadowFrameBufferMap = pipeline.pipelineSceneData.shadowFrameBufferMap;
        const format = supportsR32FloatTexture(device) ? Format.R32F : Format.RGBA8;

        const it = shadowFrameBufferMap.values();
        let res = it.next();
        while (!res.done) {
            const frameBuffer = res.value;
            if (!frameBuffer) {
                res = it.next();
                continue;
            }

            const renderTargets: Texture[] = [];
            renderTargets.push(pipeline.device.createTexture(new TextureInfo(
                TextureType.TEX2D,
                TextureUsageBit.COLOR_ATTACHMENT | TextureUsageBit.SAMPLED,
                format,
                shadowMapSize.x,
                shadowMapSize.y,
            )));

            const depth = frameBuffer.depthStencilTexture;
            if (depth) { depth.resize(shadowMapSize.x, shadowMapSize.y); }

            const shadowRenderPass = frameBuffer.renderPass;
            frameBuffer.destroy();
            frameBuffer.initialize(new FramebufferInfo(
                shadowRenderPass,
                renderTargets,
                depth,
            ));

            res = it.next();
        }

        shadows.shadowMapDirty = false;
    }
}