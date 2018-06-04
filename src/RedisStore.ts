import IORedis from 'ioredis';
import debug from 'debug';
import { Redis, RedisOptions } from 'ioredis';
import { Store } from 'express-session';
import { debuglog } from 'util';

const debugLog = debug('connect:ioredis-ts');
const NOOP = () => {};
const ONE_DAY = 86400;

export type TTLGetter = (
  store: { ttl?: TTL },
  session: Express.Session,
  sid: string,
) => number;

export type TTL = string | number | TTLGetter;

export interface Options extends RedisOptions {
  client?: Redis;
  /**
   * Redis Session TTL. Defaults to session.cookie.maxAge
   */
  ttl?: TTL;

  disableTTL?: boolean;

  /**
   * Key prefix. Default to sess
   */
  prefix?: string;

  /**
   * Key prefix. Default to sess;
   */
  keyPrefix?: string;

  /**
   * An object containing stringify and parse methods compatible with Javascript's JSON to override the serializer used
   */
  serializer?: JSON;

  /**
   *Value used for count parameter in Redis SCAN command (used in ids() and all() methods, defaults to 100
   */
  scanCount?: number;

  /**
   * logErrors Whether or not to log client errors. (default: false)
   *   * If true, a default logging function (console.error) is provided.
   *   * If a function, it is called anytime an error occurs (useful for custom logging)
   *   * If false, no logging occurs.
   */
  logErrors?: boolean | ((err: any) => any);
}

function getTTL(store: { ttl?: TTL }, sess: Express.Session, sid: string) {
  if (typeof store.ttl === 'number' || typeof store.ttl === 'string') {
    return Number(store.ttl);
  }

  if (typeof store.ttl === 'function') {
    return Number(store.ttl(store, sess, sid));
  }

  const maxAge = sess.cookie.maxAge;
  return typeof maxAge === 'number' ? Math.floor(maxAge / 1000) : ONE_DAY;
}

function getPrefix(options: Options) {
  if (options.prefix) {
    return options.prefix;
  }

  if (options.keyPrefix) {
    return options.keyPrefix;
  }

  return 'sess:';
}

function defaultErrorLogger(err: any) {
  console.error('Warning: connect-redis reported a client error: ' + err);
}

export class IORedisStore extends Store {
  client: Redis;
  ttl: TTL | null | undefined;
  disableTTL: boolean | null | undefined;
  prefix: string;
  serializer: JSON;
  scanCount: number;

  constructor(options: Options) {
    super();
    this.prefix = getPrefix(options);
    this.ttl = options.ttl;
    this.disableTTL = options.disableTTL;
    this.serializer = options.serializer || JSON;
    this.scanCount = options.scanCount || 100;

    if (options.client) {
      this.client = options.client;
    } else {
      const redisOptions = {
        ...options,
        keyPrefix: this.prefix,
      };
      this.client = new IORedis(redisOptions);
    }

    if (options.password) {
      this.client.auth(options.password, err => {
        if (err) {
          throw err;
        }
      });
    }

    if (options.db) {
      this.client.select(options.db);
      this.client.on('connect', () => {
        this.client.select(options.db);
      });
    }

    this.client.on('error', err => {
      this.emit('disconnect', err);
    });

    this.client.on('connect', () => {
      this.emit('connect');
    });
  }

  get = (
    sid: string,
    callback: (err: any, session?: Express.SessionData | null) => void = NOOP,
  ) => {
    const psid = this.prefix + sid;
    this.client.get(psid, (err, data) => {
      if (err) {
        callback(err);
        return;
      }

      if (!data) {
        callback(null);
      }

      const strData = data.toString();
      debugLog('GOT %s', strData);
      try {
        callback(null, this.serializer.parse(strData));
      } catch (err) {
        callback(err);
      }
    });
  };

  set = (
    sid: string,
    session: Express.Session,
    callback: (err?: any) => void = NOOP,
  ) => {
    const ttl = getTTL(this, session, sid);
    const key = this.prefix + sid;
    const setCallback = (err, data) => {
      if (err) {
        callback(err);
        return;
      }

      callback(null);
    };

    try {
      const jsess = this.serializer.stringify(session);
      if (!this.disableTTL) {
        this.client.set(key, jsess, 'EX', ttl, setCallback);
      } else {
        this.client.set(key, jsess, setCallback);
      }
    } catch (err) {
      callback(err);
    }
  };

  destroy = (sid: string, callback: (err?: any) => void = NOOP) => {
    debugLog('DEL "%s"', sid);
    const key = this.prefix + sid;
    this.client
      .pipeline()
      .del(sid)
      .exec(callback);
  };

  touch = (
    sid: string,
    session: Express.Session,
    callback: (err?: any) => void = NOOP,
  ) => {
    const key = this.prefix + sid;
    const ttl = getTTL(this, session, sid);

    debugLog('EXPIRE "%s" ttl:%s', sid, ttl);
    this.client.expire(key, ttl, err => {
      if (err) {
        callback(err);
        return;
      }

      callback();
    });
  };

  allKeys = (callback: (err: any, obj?: null | string[]) => void = NOOP) => {
    const match = this.prefix + '*';
    const scanCount = this.scanCount;
    const stream = this.client.scanStream({
      match,
      count: scanCount,
    });

    const keys = [];

    stream.on('data', (results: string[]) => {
      results.forEach(r => keys.push(r));
    });

    stream.on('error', err => callback(err));

    stream.on('end', () => {
      callback(null, keys);
    });
  };

  all = (
    callback: (
      err: any,
      obj?: { [sid: string]: Express.SessionData } | null,
    ) => void = NOOP,
  ) => {
    const prefixLength = this.prefix.length;
    this.allKeys((err, keys) => {
      if (err) {
        callback(err);
        return;
      }

      if (!keys || keys.length === 0) {
        callback(null, {});
        return;
      }

      const mget = this.client.mget(...keys) as Promise<any>;
      mget.then(
        (results: any[]) => {
          try {
            const obj = results
              .map((r, index) => {
                const data = r.toString();
                const jData = this.serializer.parse(data);
                jData.id = (keys[index] || '').substring(prefixLength);
                return jData;
              })
              .reduce((acc, jData) => {
                acc[jData.id] = jData;
                return acc;
              }, {});

            callback(null, obj);
          } catch (err) {
            callback(err);
          }
        },
        err => {
          callback(err);
        },
      );
    });
  };
}
