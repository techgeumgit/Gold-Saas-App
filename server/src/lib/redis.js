import Redis from 'ioredis';

let redis = null;

/**
 * Returns a lazy-connected Redis client.
 * If REDIS_URL is not set, returns null so the app can still boot
 * without Redis (rate-limiter falls back to in-memory store).
 */
export function getRedisClient() {
  if (!process.env.REDIS_URL) {
    return null;
  }

  if (!redis) {
    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
    });

    redis.on('error', (err) => {
      console.error('[Redis] Connection error:', err.message);
    });

    redis.on('connect', () => {
      console.log('[Redis] Connected successfully');
    });
  }

  return redis;
}

export { redis };
