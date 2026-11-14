/**
 * ULDatabase - Per-user isolated client-side database.
 * Uses IndexedDB ("ULManagerDB") with an automatic localStorage fallback
 * so each user's profile, daily items, and saved item catalog are stored separately.
 */
class ULDatabase {
  constructor() {
    this.dbName = "ULManagerDB";
    this.dbVersion = 1;
    this.db = null;
    this.useFallback = false;
    this.fallbackPrefix = "ulmanager_v1_";
  }

  async init() {
    if (!("indexedDB" in window)) {
      this.useFallback = true;
      return;
    }

    try {
      this.db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(this.dbName, this.dbVersion);
        req.onupgradeneeded = (event) => {
          const db = event.target.result;
          if (!db.objectStoreNames.contains("users")) {
            db.createObjectStore("users", { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains("userData")) {
            db.createObjectStore("userData", { keyPath: "userId" });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch {
      this.useFallback = true;
    }
  }

  _defaultSavedItems() {
    return [];
  }

  _readFallback(key, defaultVal) {
    try {
      const raw = localStorage.getItem(this.fallbackPrefix + key);
      return raw ? JSON.parse(raw) : defaultVal;
    } catch {
      return defaultVal;
    }
  }

  _writeFallback(key, value) {
    localStorage.setItem(this.fallbackPrefix + key, JSON.stringify(value));
  }

  _tx(storeName, mode, operation) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const req = operation(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async getAllUsers() {
    if (this.useFallback) {
      return this._readFallback("users", []);
    }
    const users = await this._tx("users", "readonly", (store) => store.getAll());
    return users.sort((a, b) => a.createdAt - b.createdAt);
  }

  async getUser(userId) {
    if (this.useFallback) {
      const users = this._readFallback("users", []);
      return users.find((u) => u.id === userId) || null;
    }
    return this._tx("users", "readonly", (store) => store.get(userId));
  }

  async getUserData(userId) {
    let data;
    if (this.useFallback) {
      data = this._readFallback(`userData_${userId}`, {
        userId,
        itemsByDate: {},
        savedItems: this._defaultSavedItems(),
      });
    } else {
      data = (await this._tx("userData", "readonly", (store) => store.get(userId))) || {
        userId,
        itemsByDate: {},
        savedItems: this._defaultSavedItems(),
      };
    }

    // Remove any legacy pre-seeded suggested items so only manually added items remain
    const cleanedSaved = (data.savedItems || []).filter((s) => !String(s.id).startsWith("preset_"));
    if (cleanedSaved.length !== (data.savedItems || []).length) {
      data.savedItems = cleanedSaved;
      await this.saveUserData(data);
    }

    return data;
  }

  async createUser({ username, email, limit, resetDate, resetFrequency = "monthly", resetDays = 30 }) {
    const id = "usr_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
    const user = {
      id,
      username: username.trim(),
      email: email.trim(),
      limit: Number(limit),
      resetDate,
      resetFrequency,
      resetDays: Number(resetDays) || 30,
      createdAt: Date.now(),
    };
    const initialData = {
      userId: id,
      itemsByDate: {},
      savedItems: this._defaultSavedItems(),
    };

    if (this.useFallback) {
      const users = this._readFallback("users", []);
      users.push(user);
      this._writeFallback("users", users);
      this._writeFallback(`userData_${id}`, initialData);
      return user;
    }

    await this._tx("users", "readwrite", (store) => store.put(user));
    await this._tx("userData", "readwrite", (store) => store.put(initialData));
    return user;
  }

  async updateUser(userId, patch) {
    const user = await this.getUser(userId);
    if (!user) return null;
    const updated = { ...user, ...patch };

    if (this.useFallback) {
      const users = this._readFallback("users", []);
      const idx = users.findIndex((u) => u.id === userId);
      if (idx !== -1) users[idx] = updated;
      this._writeFallback("users", users);
      return updated;
    }

    await this._tx("users", "readwrite", (store) => store.put(updated));
    return updated;
  }

  async saveUserData(userData) {
    if (this.useFallback) {
      this._writeFallback(`userData_${userData.userId}`, userData);
      return userData;
    }
    await this._tx("userData", "readwrite", (store) => store.put(userData));
    return userData;
  }

  async addExpenseItem(userId, dateKey, { name, price, saveToCatalog = false, savedItemId = null }) {
    const data = await this.getUserData(userId);
    const item = {
      id: "itm_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
      name: name.trim(),
      price: Number(price),
      createdAt: Date.now(),
    };

    if (!data.itemsByDate[dateKey]) {
      data.itemsByDate[dateKey] = [];
    }
    // Latest added item is at the top
    data.itemsByDate[dateKey].unshift(item);

    if (savedItemId) {
      const idx = data.savedItems.findIndex((s) => s.id === savedItemId);
      if (idx > 0) {
        const [picked] = data.savedItems.splice(idx, 1);
        data.savedItems.unshift(picked);
      }
    } else if (saveToCatalog) {
      const existingIdx = data.savedItems.findIndex(
        (s) => s.name.toLowerCase() === item.name.toLowerCase() && Number(s.price) === item.price
      );
      if (existingIdx > 0) {
        const [existing] = data.savedItems.splice(existingIdx, 1);
        data.savedItems.unshift(existing);
      } else if (existingIdx === -1) {
        data.savedItems.unshift({
          id: "cat_" + Date.now() + "_" + Math.random().toString(36).slice(2, 5),
          name: item.name,
          price: item.price,
        });
      }
    }

    await this.saveUserData(data);
    return data;
  }

  async deleteExpenseItem(userId, dateKey, itemId) {
    const data = await this.getUserData(userId);
    if (!data.itemsByDate[dateKey]) return data;
    data.itemsByDate[dateKey] = data.itemsByDate[dateKey].filter((i) => i.id !== itemId);
    if (data.itemsByDate[dateKey].length === 0) {
      delete data.itemsByDate[dateKey];
    }
    await this.saveUserData(data);
    return data;
  }

  async deleteSavedItem(userId, savedItemId) {
    const data = await this.getUserData(userId);
    data.savedItems = (data.savedItems || []).filter((s) => s.id !== savedItemId);
    await this.saveUserData(data);
    return data;
  }

  async resetAccount(userId, newResetDate) {
    await this.updateUser(userId, { resetDate: newResetDate });
    const data = await this.getUserData(userId);
    // Clear cycle items while preserving user's saved quick-pick catalog
    data.itemsByDate = {};
    await this.saveUserData(data);
    return data;
  }

  async exportAll() {
    const users = await this.getAllUsers();
    const accounts = [];
    for (const u of users) {
      const data = await this.getUserData(u.id);
      accounts.push({ user: u, data });
    }
    return { exportedAt: new Date().toISOString(), accounts };
  }
}

window.ULDatabase = ULDatabase;
