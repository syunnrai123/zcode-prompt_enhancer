/**
 * Minimal token-based DI container (singleton lifetime).
 *
 * A deliberately small implementation: the plugin has zero runtime
 * dependencies, and a full IoC framework would outweigh the value. The
 * container gives us constructor injection at the composition root
 * (`index.ts`) and easy swapping of strategies/transports in tests.
 */
export function createToken(name) {
    return { key: Symbol(name) };
}
export class Container {
    factories = new Map();
    instances = new Map();
    register(token, factory) {
        if (this.factories.has(token.key)) {
            throw new Error(`Duplicate registration for token: ${String(token.key.description)}`);
        }
        this.factories.set(token.key, factory);
        return this;
    }
    resolve(token) {
        if (this.instances.has(token.key)) {
            return this.instances.get(token.key);
        }
        const factory = this.factories.get(token.key);
        if (!factory) {
            throw new Error(`No registration for token: ${String(token.key.description)}`);
        }
        const instance = factory(this);
        this.instances.set(token.key, instance);
        return instance;
    }
    has(token) {
        return this.factories.has(token.key);
    }
}
