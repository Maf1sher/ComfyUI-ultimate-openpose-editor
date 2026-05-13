// Use new ComfyUI API directly to avoid deprecation issues
const app = window.comfyAPI?.app?.app;
const ComfyDialog = window.comfyAPI?.ui?.ComfyDialog;
const $el = window.comfyAPI?.ui?.$el;
const ComfyApp = window.comfyAPI?.app?.ComfyApp;

// Fallback for older versions
if (!app || !ComfyDialog || !$el || !ComfyApp) {
    console.error('[OpenposeEditor] ComfyUI API not available, extension disabled');
}


function addMenuHandler(nodeType, cb) {
    const getOpts = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function () {
        const r = getOpts.apply(this, arguments);
        cb.apply(this, arguments);
        return r;
    };
}

class OpenposeEditorDialog extends ComfyDialog {
    static timeout = 5000;
    static instance = null;

    static getInstance() {
        if (!OpenposeEditorDialog.instance) {
            OpenposeEditorDialog.instance = new OpenposeEditorDialog();
        }

        return OpenposeEditorDialog.instance;
    }

    constructor() {
        super();
        this.element = $el("div.comfy-modal", {
            parent: document.body,
            style: {
                width: "80vw",
                height: "80vh",
            },
        }, [
            $el("div.comfy-modal-content", {
                style: {
                    width: "100%",
                    height: "100%",
                },
            }, this.createButtons()),
        ]);
        this.is_layout_created = false;

        window.addEventListener("message", (event) => {
            if (event.source !== this.iframeElement.contentWindow) {
                return;
            }

            const message = event.data;
            if (message.modalId === 0) {
                const targetNode = ComfyApp.clipspace_return_node;
                const poseJsonWidget = targetNode.widgets.find(w => w.name === "POSE_JSON");
                if (poseJsonWidget) {
                    const value = JSON.stringify(event.data.poses);
                    poseJsonWidget.value = value;
                    if (poseJsonWidget.element) {
                        poseJsonWidget.element.value = value;
                    }
                    if (poseJsonWidget.callback) {
                        poseJsonWidget.callback(value);
                    }
                    app.graph.setDirtyCanvas(true, true);
                }
                ComfyApp.onClipspaceEditorClosed();
                this.close();
            }
        });
    }

    createButtons() {
        const closeBtn = $el("button", {
            type: "button",
            textContent: "Close",
            onclick: () => this.close(),
        });
        return [
            closeBtn,
        ];
    }

    close() {
        super.close();
    }

    async show() {
        if (!this.is_layout_created) {
            this.createLayout();
            this.is_layout_created = true;
            await this.waitIframeReady();
        }

        const targetNode = ComfyApp.clipspace_return_node;
        const poseJsonWidget = targetNode.widgets.find(w => w.name === "POSE_JSON");
        const resolutionXWidget = targetNode.widgets.find(w => w.name === "resolution_x");

        if (!poseJsonWidget) {
            console.error("[OpenposeEditor] POSE_JSON widget not found");
            return;
        }

        const textAreaElement = poseJsonWidget.element;
        this.element.style.display = "flex";

        // Handle background image
        let imageURL = null;
        if (targetNode.inputs) {
            const bgInputIndex = targetNode.inputs.findIndex(i => i.name === "background_image");
            if (bgInputIndex !== -1 && targetNode.inputs[bgInputIndex].link) {
                // If there's an image connected, we try to get its data
                // In ComfyUI, we can sometimes get the image from the node's internal state if it was already processed
                // or we might need to wait for it.
                // For simplicity, let's see if we can access the image data from the output of the linked node
                const linkId = targetNode.inputs[bgInputIndex].link;
                const originNodeId = app.graph.links[linkId].origin_id;
                const originNode = app.graph.getNodeById(originNodeId);
                
                if (originNode && originNode.imgs) {
                    const img = originNode.imgs[0];
                    if (img instanceof HTMLImageElement || img instanceof HTMLCanvasElement) {
                        imageURL = img.src || img.toDataURL();
                    }
                }
            }
        }

        if (textAreaElement.value === "" || textAreaElement.value === "[]" || textAreaElement.value === "null") {
            let resolution_x = resolutionXWidget ? resolutionXWidget.value : 512;
            let resolution_y = Math.floor(768 * (resolution_x * 1.0 / 512));
            if (resolution_x < 64) {
                resolution_x = 512;
                resolution_y = 768;
            }

            const body = Array(54).fill(0);
            const face = Array(210).fill(0);
            const hand = Array(63).fill(0);
            let pose = `[{"people": [{"pose_keypoints_2d": ${JSON.stringify(body)}, "face_keypoints_2d": ${JSON.stringify(face)}, "hand_left_keypoints_2d": ${JSON.stringify(hand)}, "hand_right_keypoints_2d": ${JSON.stringify(hand)}}], "canvas_height": ${resolution_y}, "canvas_width": ${resolution_x}}]`;
            this.setCanvasJSONString(pose, imageURL);
        } else {
            this.setCanvasJSONString(textAreaElement.value.replace(/'/g, '"'), imageURL);
        }
    }

    createLayout() {
        this.iframeElement = $el("iframe", {
            // Change to for local dev
            src: "extensions/ComfyUI-ultimate-openpose-editor/ui/OpenposeEditor.html",
            style: {
                width: "100%",
                height: "100%",
                border: "none",
            },
        });
        const modalContent = this.element.querySelector(".comfy-modal-content");
        while (modalContent.firstChild) {
            modalContent.removeChild(modalContent.firstChild);
        }
        modalContent.appendChild(this.iframeElement);
    }

    waitIframeReady() {
        return new Promise((resolve, reject) => {
            const receiveMessage =  (event) => {
                if (event.source !== this.iframeElement.contentWindow) {
                    return;
                }
                if (event.data.ready) {
                    window.removeEventListener("message", receiveMessage);
                    clearTimeout(timeoutHandle);
                    resolve();
                }
            };
            const timeoutHandle = setTimeout(() => {
                reject(new Error("Timeout"));
            }, OpenposeEditorDialog.timeout);

            window.addEventListener("message", receiveMessage);
        });
    }

    setCanvasJSONString(jsonString, imageURL = null) {
        this.iframeElement.contentWindow.postMessage({
            modalId: 0,
            poses: JSON.parse(jsonString),
            imageURL: imageURL
        }, "*");
    }
}

// Only register if API is available
if (app && ComfyDialog && $el && ComfyApp) {
    app.registerExtension({
        name: "OpenposeEditor",

        async beforeRegisterNodeDef(nodeType, nodeData) {
            if (nodeData.name === "OpenposeEditorNode") {
                addMenuHandler(nodeType, function (_, options) {
                    options.unshift({
                        content: "Open in Openpose Editor",
                        callback: () => {
                            // `this` is the node instance
                            ComfyApp.copyToClipspace(this);
                            ComfyApp.clipspace_return_node = this;

                            const dlg = OpenposeEditorDialog.getInstance();
                            dlg.show();
                        },
                    });
                });
            }
        }
    });
}
