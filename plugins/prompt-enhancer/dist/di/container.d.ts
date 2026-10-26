/**
 * Minimal token-based DI container (singleton lifetime).
 *
 * A deliberately small implementation: the plugin has zero runtime
 * dependencies, and a full IoC framework would outweigh the value. The
 * container gives us constructor injection at the composition root
 * (`index.ts`) and easy swapping of strategies/transports in tests.
 */
export interface Token<T> {
    readonly key: symbol;
    /** Phantom type carrier — never read at runtime. */
    readonly __type?: T;
}
export declare function createToken<T>(name: string): Token<T>;
export declare class Container {
    private readonly factories;
    private readonly instances;
    register<T>(token: Token<T>, factory: (c: Container) => T): this;
    resolve<T>(token: Token<T>): T;
    has(token: Token<unknown>): boolean;
}
