// src/di-container.ts
import { logger, Logger } from "./logging.js";
import { Cache } from "./cache.js";
import { ToolsCacheEntry } from "./types.js"; // Import the new cache entry type
// import { Logger } from "./logging.js"; // Remove duplicate import

/**
 * A simple singleton Dependency Injection (DI) container for managing shared services.
 * Ensures that core services like logging and caching are instantiated only once.
 */
export class DIContainer {
  private static instance: DIContainer;
  private services: Map<string, any> = new Map();

  private constructor() {
    // Private constructor to enforce singleton pattern
  }

  /**
   * Gets the singleton instance of the DIContainer.
   * @returns The DIContainer instance.
   */
  static getInstance(): DIContainer {
    if (!DIContainer.instance) {
      DIContainer.instance = new DIContainer();
      // Automatically register core services on first instantiation
      DIContainer.instance.registerCoreServices();
    }
    return DIContainer.instance;
  }

  /**
   * Registers core singleton services like logger and caches.
   * Called automatically when the instance is first created.
   */
  private registerCoreServices(): void {
    // Register Logger instance
    this.register<Logger>('logger', logger); // Use the already instantiated singleton logger

    // Register Tool Names Cache using ToolsCacheEntry and 1-hour TTL
    const TOOLS_CACHE_TTL_MS = 3600000; // 1 hour
    this.register<Cache<ToolsCacheEntry>>('toolsCache', new Cache<ToolsCacheEntry>(TOOLS_CACHE_TTL_MS));

    // Register other caches or services as needed
    // e.g., this.register('resourceCache', new Cache<ResourceInfo[]>(10 * 60 * 1000));
  }

  /**
   * Registers a service instance with the container.
   * @param name - The unique name (key) for the service.
   * @param service - The service instance to register.
   */
  register<T>(name: string, service: T): void {
    if (this.services.has(name)) {
      // Optional: Log a warning or throw an error if overwriting a service
      console.warn(`[DIContainer] Service with name "${name}" is already registered. Overwriting.`);
    }
    this.services.set(name, service);
  }

  /**
   * Retrieves a registered service instance from the container.
   * @param name - The unique name (key) of the service to retrieve.
   * @returns The registered service instance.
   * @throws Error if the service is not registered.
   */
  get<T>(name: string): T {
    if (!this.services.has(name)) {
      throw new Error(`[DIContainer] Service "${name}" not registered.`);
    }
    return this.services.get(name) as T;
  }

  /**
   * Checks if a service is registered in the container.
   * @param name - The name of the service.
   * @returns True if the service is registered, false otherwise.
   */
  has(name: string): boolean {
    return this.services.has(name);
  }
}

// Export a pre-initialized instance for convenience
export const container = DIContainer.getInstance();
