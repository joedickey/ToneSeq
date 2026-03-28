'use strict';

const ROOM_TTL = 60 * 60 * 24; // 24 hours

class Room {
  constructor(redisClient, roomCode) {
    this.redis = redisClient;
    this.code = roomCode;
    this.TTL = ROOM_TTL;
  }

  // Hash-tagged keys for cluster safety
  _tabSetKey() { return `{room:${this.code}}:tabs`; }
  _tabDataKey(id) { return `{room:${this.code}}:tab:${id}`; }
  _transportKey() { return `{room:${this.code}}:transport`; }

  async addTab(tabId, state) {
    const multi = this.redis.multi();
    multi.sAdd(this._tabSetKey(), tabId);
    multi.json.set(this._tabDataKey(tabId), '$', state);
    multi.expire(this._tabSetKey(), this.TTL);
    multi.expire(this._tabDataKey(tabId), this.TTL);
    await multi.exec();
  }

  async removeTab(tabId) {
    const multi = this.redis.multi();
    multi.sRem(this._tabSetKey(), tabId);
    multi.del(this._tabDataKey(tabId));
    await multi.exec();
  }

  async updateTabState(tabId, newState) {
    try {
      const result = await this.redis.json.set(this._tabDataKey(tabId), '$.state', newState);
      if (result === null) return false;
      await this.redis.expire(this._tabDataKey(tabId), this.TTL);
      return true;
    } catch {
      return false;
    }
  }

  async updateTabLastEdit(tabId, editMsg) {
    try {
      const result = await this.redis.json.set(this._tabDataKey(tabId), '$.lastEdit', editMsg);
      if (result === null) return false;
      await this.redis.expire(this._tabDataKey(tabId), this.TTL);
      return true;
    } catch {
      return false;
    }
  }

  async getTab(tabId) {
    try {
      return await this.redis.json.get(this._tabDataKey(tabId));
    } catch {
      return null;
    }
  }

  async getAllTabs() {
    const tabIds = await this.redis.sMembers(this._tabSetKey());
    if (tabIds.length === 0) return {};

    // Pipeline all tab fetches in a single round trip
    const pipeline = this.redis.multi();
    for (const id of tabIds) {
      pipeline.json.get(this._tabDataKey(id));
    }
    const results = await pipeline.exec();

    const tabs = {};
    for (let i = 0; i < tabIds.length; i++) {
      if (results[i] != null) tabs[tabIds[i]] = results[i];
    }
    return tabs;
  }

  async setTransport(transportState) {
    await this.redis.json.set(this._transportKey(), '$', transportState);
    await this.redis.expire(this._transportKey(), this.TTL);
  }

  async updateTransportStep(step) {
    try {
      await this.redis.json.set(this._transportKey(), '$.step', step);
    } catch {
      // transport key doesn't exist yet — ignore
    }
  }

  // Partial updates for transport fields — no read-before-write needed
  async updateTransportField(path, value) {
    const key = this._transportKey();
    try {
      const result = await this.redis.json.set(key, path, value);
      if (result === null) {
        // Key doesn't exist yet — create with defaults
        await this.setTransport({ playing: false, bpm: 120, step: 0, [path.replace('$.', '')]: value });
      }
      return true;
    } catch {
      // Key doesn't exist — create it
      await this.setTransport({ playing: false, bpm: 120, step: 0, [path.replace('$.', '')]: value });
      return true;
    }
  }

  async getTransport() {
    try {
      return await this.redis.json.get(this._transportKey());
    } catch {
      return null;
    }
  }
}

module.exports = { Room, ROOM_TTL };
