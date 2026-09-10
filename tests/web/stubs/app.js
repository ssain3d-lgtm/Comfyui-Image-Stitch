// Stand-in for ComfyUI's scripts/app.js: records the registered extension and
// collects toasts so tests can assert on user-facing feedback.
export const app = {
    extension: null,
    registerExtension(extension) {
        this.extension = extension;
    },
    extensionManager: {
        toast: {
            log: [],
            add(message) {
                this.log.push(message);
            },
        },
    },
};
