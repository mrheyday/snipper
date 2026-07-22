/**
 * Simple rate limiter for external API calls
 * Prevents hitting rate limits on services like Bitquery
 */

export interface RateLimiterConfig {
  maxRequests: number; // Max requests
  windowMs: number; // Time window in milliseconds
  retryDelayMs?: number; // Delay before retry on rate limit
  maxRetries?: number; // Max retries on rate limit
}

export class RateLimiter {
  private maxRequests: number;
  private windowMs: number;
  private retryDelayMs: number;
  private maxRetries: number;
  private requestTimestamps: number[] = [];

  constructor(config: RateLimiterConfig) {
    this.maxRequests = config.maxRequests;
    this.windowMs = config.windowMs;
    this.retryDelayMs = config.retryDelayMs || 1000;
    this.maxRetries = config.maxRetries || 3;
  }

  /**
   * Wait if necessary to stay within rate limit
   */
  async acquire(): Promise<void> {
    const now = Date.now();

    // Remove old timestamps outside the window
    this.requestTimestamps = this.requestTimestamps.filter((ts) => now - ts < this.windowMs);

    // If we haven't hit the limit, proceed immediately
    if (this.requestTimestamps.length < this.maxRequests) {
      this.requestTimestamps.push(now);
      return;
    }

    // Wait until oldest request is outside the window
    const oldestTs = this.requestTimestamps[0];
    const waitTime = this.windowMs - (now - oldestTs) + 100; // +100ms buffer

    if (waitTime > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      this.requestTimestamps.push(Date.now());
    }
  }

  /**
   * Execute function with rate limiting and retry logic
   */
  async execute<T>(fn: () => Promise<T>, retryPredicate?: (error: unknown) => boolean): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        await this.acquire();
        return await fn();
      } catch (error) {
        lastError = error;

        // Check if we should retry
        if (attempt < this.maxRetries && retryPredicate && retryPredicate(error)) {
          await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * attempt)); // Exponential backoff
          continue;
        }

        throw error;
      }
    }

    throw lastError;
  }

  /**
   * Reset rate limiter (useful after sleep or failure recovery)
   */
  reset(): void {
    this.requestTimestamps = [];
  }

  /**
   * Get current queue length
   */
  getQueueLength(): number {
    return this.requestTimestamps.length;
  }
}

export default RateLimiter;
