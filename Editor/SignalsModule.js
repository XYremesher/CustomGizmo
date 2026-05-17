/**
 * Core event bus for decoupled communication between modules.
 */
class Signals {
    constructor() {
        this.listeners = new Map();
    }

    /**
     * Subscribe to a signal.
     * @param {string} signal - Event name.
     * @param {Function} callback - Function to execute.
     */
    on(signal, callback) {
        if (!this.listeners.has(signal)) {
            this.listeners.set(signal, []);
        }
        this.listeners.get(signal).push(callback);
    }

    /**
     * Unsubscribe from a signal.
     * @param {string} signal - Event name.
     * @param {Function} callback - Function to remove.
     */
    off(signal, callback) {
        if (!this.listeners.has(signal)) return;
        const callbacks = this.listeners.get(signal);
        const index = callbacks.indexOf(callback);
        if (index !== -1) {
            callbacks.splice(index, 1);
        }
    }

    /**
     * Trigger a signal.
     * @param {string} signal - Event name.
     * @param {any} data - Data to pass to listeners.
     */
    emit(signal, data) {
        if (!this.listeners.has(signal)) return;
        this.listeners.get(signal).forEach(callback => {
            try {
                callback(data);
            } catch (error) {
                console.error(`Error in signal [${signal}]:`, error);
            }
        });
    }
}

export const signals = new Signals();