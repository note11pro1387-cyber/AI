export class StorageManager {
  constructor() {
    this._db = null;
    this._dbReady = false;
    this._dbError = null;
    this._memoryFallback = new Map();
    this._usingFallback = false;
    this._quotaPercent = 0;
    this._initPromise = null;
    this._writeQueue = [];
    this._processingQueue = false;
  }

  async init() {
    if (this._initPromise) {
      return this._initPromise;
    }
    this._initPromise = this._doInit();
    return this._initPromise;
  }

  async _doInit() {
    if (!window.indexedDB) {
      this._usingFallback = true;
      this._dbReady = false;
      this._dbError = new Error('IndexedDB not supported in this browser');
      return { success: true, usingFallback: true, error: 'IndexedDB not supported' };
    }

    return new Promise((resolve) => {
      var request = indexedDB.open('synapse_db', 1);

      request.onupgradeneeded = (event) => {
        var db = event.target.result;
        if (event.oldVersion < 1) {
          if (!db.objectStoreNames.contains('conversations')) {
            var convStore = db.createObjectStore('conversations', { keyPath: 'id' });
            convStore.createIndex('updatedAt', 'updatedAt', { unique: false });
            convStore.createIndex('createdAt', 'createdAt', { unique: false });
            convStore.createIndex('pinned', 'pinned', { unique: false });
          }
          if (!db.objectStoreNames.contains('vector_index')) {
            var vecStore = db.createObjectStore('vector_index', { keyPath: 'libraryId' });
            vecStore.createIndex('category', 'category', { unique: false });
          }
          if (!db.objectStoreNames.contains('ai_cache')) {
            db.createObjectStore('ai_cache', { keyPath: 'key' });
          }
          if (!db.objectStoreNames.contains('import_history')) {
            var impStore = db.createObjectStore('import_history', { keyPath: 'id' });
            impStore.createIndex('importedAt', 'importedAt', { unique: false });
          }
        }
      };

      request.onsuccess = (event) => {
        this._db = event.target.result;
        this._dbReady = true;
        this._dbError = null;
        this._usingFallback = false;
        this._db.onclose = () => {
          this._dbReady = false;
        };
        this._checkQuota();
        resolve({ success: true, usingFallback: false });
      };

      request.onerror = (event) => {
        var message = event.target.error ? event.target.error.message : 'unknown IndexedDB error';
        this._dbError = new Error(message);
        this._dbReady = false;
        this._usingFallback = true;
        resolve({ success: true, usingFallback: true, error: message });
      };

      request.onblocked = () => {
        this._dbError = new Error('Database blocked by another connection');
        this._dbReady = false;
        this._usingFallback = true;
        resolve({ success: true, usingFallback: true, error: 'Database blocked' });
      };
    });
  }

  async _ensureReady() {
    if (!this._initPromise) {
      await this.init();
    }
    await this._initPromise;
    if (!this._dbReady && !this._usingFallback) {
      this._usingFallback = true;
    }
  }

  async _processQueue() {
    if (this._processingQueue) return;
    this._processingQueue = true;
    while (this._writeQueue.length > 0) {
      var task = this._writeQueue.shift();
      try {
        await task();
      } catch (e) {
        console.warn('[StorageManager] Queued write failed: ' + e.message);
      }
    }
    this._processingQueue = false;
  }

  async _enqueueWrite(task) {
    this._writeQueue.push(task);
    await this._processQueue();
  }

  async saveConversation(conversation) {
    await this._ensureReady();
    if (this._usingFallback) {
      var conversations = this._memoryFallback.get('conversations');
      if (!conversations) {
        conversations = [];
        this._memoryFallback.set('conversations', conversations);
      }
      var idx = -1;
      for (var i = 0; i < conversations.length; i++) {
        if (conversations[i].id === conversation.id) {
          idx = i;
          break;
        }
      }
      if (idx >= 0) {
        conversations[idx] = conversation;
      } else {
        conversations.unshift(conversation);
      }
      return;
    }
    var self = this;
    return this._enqueueWrite(function() {
      return self._runTransaction('conversations', 'readwrite', function(store) {
        return store.put(conversation);
      });
    });
  }

  async getConversation(id) {
    await this._ensureReady();
    if (this._usingFallback) {
      var conversations = this._memoryFallback.get('conversations') || [];
      for (var i = 0; i < conversations.length; i++) {
        if (conversations[i].id === id) {
          return conversations[i];
        }
      }
      return null;
    }
    return this._runTransaction('conversations', 'readonly', function(store) {
      return store.get(id);
    });
  }

  async getAllConversations(options) {
    await this._ensureReady();
    var limit = (options && options.limit) ? options.limit : 100;
    var offset = (options && options.offset) ? options.offset : 0;

    if (this._usingFallback) {
      var conversations = this._memoryFallback.get('conversations') || [];
      var sorted = conversations.slice().sort(function(a, b) {
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      });
      return sorted.slice(offset, offset + limit);
    }

    return this._runTransaction('conversations', 'readonly', function(store) {
      return new Promise(function(resolve) {
        var index = store.index('updatedAt');
        var results = [];
        var count = 0;
        var skipped = 0;
        var cursorReq = index.openCursor(null, 'prev');
        cursorReq.onsuccess = function(e) {
          var cursor = e.target.result;
          if (!cursor) {
            resolve(results);
            return;
          }
          if (skipped < offset) {
            skipped++;
            cursor.continue();
            return;
          }
          if (count >= limit) {
            resolve(results);
            return;
          }
          results.push(cursor.value);
          count++;
          cursor.continue();
        };
        cursorReq.onerror = function() {
          resolve(results);
        };
      });
    });
  }

  async deleteConversation(id) {
    await this._ensureReady();
    if (this._usingFallback) {
      var conversations = this._memoryFallback.get('conversations') || [];
      var filtered = [];
      for (var i = 0; i < conversations.length; i++) {
        if (conversations[i].id !== id) {
          filtered.push(conversations[i]);
        }
      }
      this._memoryFallback.set('conversations', filtered);
      return;
    }
    var self = this;
    return this._enqueueWrite(function() {
      return self._runTransaction('conversations', 'readwrite', function(store) {
        return store.delete(id);
      });
    });
  }

  async getConversationCount() {
    await this._ensureReady();
    if (this._usingFallback) {
      var conversations = this._memoryFallback.get('conversations') || [];
      return conversations.length;
    }
    return this._runTransaction('conversations', 'readonly', function(store) {
      return new Promise(function(resolve) {
        var req = store.count();
        req.onsuccess = function() { resolve(req.result); };
        req.onerror = function() { resolve(0); };
      });
    });
  }

  async trimConversations() {
    var all = await this.getAllConversations({ limit: 2000 });
    if (all.length <= 100) {
      return 0;
    }
    var toDelete = all.slice(100);
    for (var i = 0; i < toDelete.length; i++) {
      await this.deleteConversation(toDelete[i].id);
    }
    return toDelete.length;
  }

  getPreferences() {
    try {
      var raw = localStorage.getItem('synapse_preferences');
      if (raw) {
        var parsed = JSON.parse(raw);
        var defaults = this._createDefaultPreferences();
        var merged = {};
        var keys = Object.keys(defaults);
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i];
          merged[k] = (parsed[k] !== undefined) ? parsed[k] : defaults[k];
        }
        if (parsed.search && typeof parsed.search === 'object') {
          merged.search = merged.search || {};
          var searchKeys = Object.keys(defaults.search);
          for (var j = 0; j < searchKeys.length; j++) {
            var sk = searchKeys[j];
            if (parsed.search[sk] !== undefined) {
              merged.search[sk] = parsed.search[sk];
            }
          }
        }
        if (parsed.chat && typeof parsed.chat === 'object') {
          merged.chat = merged.chat || {};
          var chatKeys = Object.keys(defaults.chat);
          for (var m = 0; m < chatKeys.length; m++) {
            var ck = chatKeys[m];
            if (parsed.chat[ck] !== undefined) {
              merged.chat[ck] = parsed.chat[ck];
            }
          }
        }
        if (parsed.advanced && typeof parsed.advanced === 'object') {
          merged.advanced = merged.advanced || {};
          var advKeys = Object.keys(defaults.advanced);
          for (var n = 0; n < advKeys.length; n++) {
            var ak = advKeys[n];
            if (parsed.advanced[ak] !== undefined) {
              merged.advanced[ak] = parsed.advanced[ak];
            }
          }
        }
        return merged;
      }
    } catch(e) {
      console.warn('[StorageManager] Could not parse preferences. Using defaults. Error: ' + e.message);
    }
    return this._createDefaultPreferences();
  }

  setPreferences(updates) {
    try {
      var current = this.getPreferences();
      if (updates.theme !== undefined) current.theme = updates.theme;
      if (updates.language !== undefined) current.language = updates.language;
      if (updates.fontSize !== undefined) current.fontSize = updates.fontSize;
      if (updates.reducedMotion !== undefined) current.reducedMotion = updates.reducedMotion;
      if (updates.highContrast !== undefined) current.highContrast = updates.highContrast;
      if (updates.search) {
        if (updates.search.fuzzyTolerance !== undefined) current.search.fuzzyTolerance = updates.search.fuzzyTolerance;
        if (updates.search.maxResults !== undefined) current.search.maxResults = updates.search.maxResults;
        if (updates.search.autoSuggest !== undefined) current.search.autoSuggest = updates.search.autoSuggest;
      }
      if (updates.chat) {
        if (updates.chat.showWelcomeMessage !== undefined) current.chat.showWelcomeMessage = updates.chat.showWelcomeMessage;
        if (updates.chat.autoScrollToBottom !== undefined) current.chat.autoScrollToBottom = updates.chat.autoScrollToBottom;
        if (updates.chat.compactMode !== undefined) current.chat.compactMode = updates.chat.compactMode;
      }
      if (updates.advanced) {
        if (updates.advanced.enableVectorSearch !== undefined) current.advanced.enableVectorSearch = updates.advanced.enableVectorSearch;
        if (updates.advanced.preloadAIModel !== undefined) current.advanced.preloadAIModel = updates.advanced.preloadAIModel;
        if (updates.advanced.developerMode !== undefined) current.advanced.developerMode = updates.advanced.developerMode;
      }
      current.updatedAt = new Date().toISOString();
      localStorage.setItem('synapse_preferences', JSON.stringify(current));
      return current;
    } catch(e) {
      console.warn('[StorageManager] Could not save preferences. Error: ' + e.message);
      return this.getPreferences();
    }
  }

  resetPreferences() {
    try {
      localStorage.removeItem('synapse_preferences');
    } catch(e) {
      console.warn('[StorageManager] Could not remove preferences. Error: ' + e.message);
    }
  }

  getSuggestions() {
    try {
      var raw = localStorage.getItem('synapse_suggestions');
      if (raw) {
        return JSON.parse(raw);
      }
    } catch(e) {
      console.warn('[StorageManager] Could not parse suggestions. Error: ' + e.message);
    }
    return [];
  }

  addSuggestion(suggestion) {
    var suggestions = this.getSuggestions();
    var today = new Date().toISOString().split('T')[0];
    var todayCount = 0;
    for (var i = 0; i < suggestions.length; i++) {
      if (suggestions[i].submittedAt && suggestions[i].submittedAt.startsWith(today)) {
        todayCount++;
      }
    }
    if (todayCount >= 3) {
      return { success: false, remaining: 0, error: 'Daily limit of 3 suggestions reached.' };
    }
    var newSuggestion = {
      id: this._generateId(),
      name: suggestion.name || '',
      url: suggestion.url || '',
      reason: suggestion.reason || '',
      submittedAt: new Date().toISOString(),
      status: 'pending'
    };
    suggestions.push(newSuggestion);
    try {
      localStorage.setItem('synapse_suggestions', JSON.stringify(suggestions));
    } catch(e) {
      console.warn('[StorageManager] Could not save suggestions. Error: ' + e.message);
      return { success: false, remaining: 0, error: 'Storage write failed.' };
    }
    var remaining = 3 - todayCount - 1;
    return { success: true, remaining: remaining, suggestion: newSuggestion };
  }

  clearSuggestions() {
    try {
      localStorage.removeItem('synapse_suggestions');
    } catch(e) {
      console.warn('[StorageManager] Could not clear suggestions. Error: ' + e.message);
    }
  }

  saveDraftConversation(conversation) {
    try {
      sessionStorage.setItem('synapse_draft_conversation', JSON.stringify(conversation));
    } catch(e) {
      console.warn('[StorageManager] Could not save draft conversation. Error: ' + e.message);
    }
  }

  getDraftConversation() {
    try {
      var raw = sessionStorage.getItem('synapse_draft_conversation');
      if (raw) {
        return JSON.parse(raw);
      }
    } catch(e) {
      console.warn('[StorageManager] Could not read draft conversation. Error: ' + e.message);
    }
    return null;
  }

  clearDraftConversation() {
    try {
      sessionStorage.removeItem('synapse_draft_conversation');
    } catch(e) {
      console.warn('[StorageManager] Could not clear draft conversation. Error: ' + e.message);
    }
  }

  saveCommandHistory(history) {
    try {
      var trimmed = history.slice(-50);
      sessionStorage.setItem('synapse_command_history', JSON.stringify(trimmed));
    } catch(e) {
      console.warn('[StorageManager] Could not save command history. Error: ' + e.message);
    }
  }

  getCommandHistory() {
    try {
      var raw = sessionStorage.getItem('synapse_command_history');
      if (raw) {
        return JSON.parse(raw);
      }
    } catch(e) {
      console.warn('[StorageManager] Could not read command history. Error: ' + e.message);
    }
    return [];
  }

  isTourSeen() {
    try {
      return localStorage.getItem('synapse_tour_seen') === 'true';
    } catch(e) {
      return false;
    }
  }

  markTourSeen() {
    try {
      localStorage.setItem('synapse_tour_seen', 'true');
    } catch(e) {
      console.warn('[StorageManager] Could not mark tour as seen. Error: ' + e.message);
    }
  }

  resetTour() {
    try {
      localStorage.removeItem('synapse_tour_seen');
    } catch(e) {
      console.warn('[StorageManager] Could not reset tour state. Error: ' + e.message);
    }
  }

  isSplashSeenThisSession() {
    try {
      return sessionStorage.getItem('synapse_splash_seen') === 'true';
    } catch(e) {
      return false;
    }
  }

  markSplashSeen() {
    try {
      sessionStorage.setItem('synapse_splash_seen', 'true');
    } catch(e) {
      console.warn('[StorageManager] Could not mark splash as seen. Error: ' + e.message);
    }
  }

  async exportAllData() {
    var conversations = await this.getAllConversations({ limit: 5000 });
    var preferences = this.getPreferences();
    var suggestions = this.getSuggestions();
    var exportData = {
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      data: {
        conversations: conversations,
        preferences: preferences,
        suggestions: suggestions
      }
    };
    var json = JSON.stringify(exportData, null, 2);
    return new Blob([json], { type: 'application/json' });
  }

  async importData(file) {
    if (file.size > 10485760) {
      return { success: false, imported: { conversations: 0, suggestions: 0 }, error: 'File size exceeds the maximum allowed size of 10MB.' };
    }
    try {
      var text = await new Promise(function(resolve, reject) {
        var reader = new FileReader();
        reader.onload = function() { resolve(reader.result); };
        reader.onerror = function() { reject(new Error('Failed to read file')); };
        reader.readAsText(file);
      });
      var imported = JSON.parse(text);
      if (!imported.version || !imported.data) {
        return { success: false, imported: { conversations: 0, suggestions: 0 }, error: 'Invalid import file: missing version or data fields.' };
      }
      var convCount = 0;
      var suggCount = 0;
      if (imported.data.conversations && Array.isArray(imported.data.conversations)) {
        var self = this;
        for (var i = 0; i < imported.data.conversations.length; i++) {
          var conv = imported.data.conversations[i];
          if (conv.id && conv.messages) {
            await self.saveConversation(conv);
            convCount++;
          }
        }
      }
      if (imported.data.suggestions && Array.isArray(imported.data.suggestions)) {
        var existing = this.getSuggestions();
        var merged = existing.slice();
        var existingIds = {};
        for (var j = 0; j < merged.length; j++) {
          existingIds[merged[j].id] = true;
        }
        for (var k = 0; k < imported.data.suggestions.length; k++) {
          var sugg = imported.data.suggestions[k];
          if (sugg.id && !existingIds[sugg.id]) {
            merged.push(sugg);
            existingIds[sugg.id] = true;
            suggCount++;
          }
        }
        try {
          localStorage.setItem('synapse_suggestions', JSON.stringify(merged));
        } catch(e) {
          console.warn('[StorageManager] Could not save imported suggestions. Error: ' + e.message);
        }
      }
      if (imported.data.preferences) {
        this.setPreferences(imported.data.preferences);
      }
      await this._recordImport({
        convCount: convCount,
        suggCount: suggCount,
        source: file.name
      });
      return { success: true, imported: { conversations: convCount, suggestions: suggCount } };
    } catch(e) {
      return { success: false, imported: { conversations: 0, suggestions: 0 }, error: 'Import failed: ' + e.message };
    }
  }

  async _recordImport(details) {
    if (this._usingFallback) return;
    try {
      await this._runTransaction('import_history', 'readwrite', function(store) {
        return store.put({
          id: 'import-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 8),
          importedAt: new Date().toISOString(),
          conversationsImported: details.convCount,
          suggestionsImported: details.suggCount,
          source: details.source
        });
      });
    } catch(e) {
      console.warn('[StorageManager] Could not record import in history. Error: ' + e.message);
    }
  }

  async clearAllData() {
    if (!this._usingFallback && this._db) {
      var stores = ['conversations', 'vector_index', 'ai_cache', 'import_history'];
      for (var i = 0; i < stores.length; i++) {
        try {
          await this._runTransaction(stores[i], 'readwrite', function(store) {
            return store.clear();
          });
        } catch(e) {
          console.warn('[StorageManager] Could not clear store "' + stores[i] + '". Error: ' + e.message);
        }
      }
    }
    this._memoryFallback.clear();
    try {
      localStorage.removeItem('synapse_preferences');
      localStorage.removeItem('synapse_suggestions');
      localStorage.removeItem('synapse_tour_seen');
      localStorage.removeItem('synapse_last_session');
    } catch(e) {
      console.warn('[StorageManager] Could not clear localStorage items. Error: ' + e.message);
    }
    try {
      sessionStorage.clear();
    } catch(e) {
      console.warn('[StorageManager] Could not clear sessionStorage. Error: ' + e.message);
    }
  }

  async _checkQuota() {
    try {
      if ('storage' in navigator && 'estimate' in navigator.storage) {
        var estimate = await navigator.storage.estimate();
        var quota = estimate.quota || 0;
        var usage = estimate.usage || 0;
        var percentUsed = quota > 0 ? (usage / quota) * 100 : 0;
        this._quotaPercent = percentUsed;
        return { quota: quota, usage: usage, percentUsed: percentUsed };
      }
    } catch(e) {
      console.warn('[StorageManager] Storage quota check failed. Error: ' + e.message);
    }
    return { quota: 0, usage: 0, percentUsed: 0 };
  }

  async getQuotaPercent() {
    var info = await this._checkQuota();
    return info.percentUsed;
  }

  async isStorageLow() {
    var info = await this._checkQuota();
    return info.percentUsed > 80;
  }

  async cleanupStorage() {
    var cleaned = 0;
    cleaned += await this.trimConversations();
    if (!this._usingFallback && this._db) {
      try {
        await this._runTransaction('ai_cache', 'readwrite', function(store) {
          return store.clear();
        });
        cleaned++;
      } catch(e) {
        console.warn('[StorageManager] Could not clear AI cache during cleanup. Error: ' + e.message);
      }
    }
    return cleaned;
  }

  _runTransaction(storeName, mode, callback) {
    var self = this;
    return new Promise(function(resolve, reject) {
      if (!self._db || !self._dbReady) {
        reject(new Error('Database is not initialized or connection was lost.'));
        return;
      }
      var tx;
      try {
        tx = self._db.transaction(storeName, mode);
      } catch(e) {
        reject(new Error('Failed to create transaction on store "' + storeName + '": ' + e.message));
        return;
      }
      var store = tx.objectStore(storeName);
      var result;
      try {
        result = callback(store);
      } catch(e) {
        reject(e);
        return;
      }
      if (result && typeof result.onsuccess !== 'undefined') {
        result.onsuccess = function() { resolve(result.result); };
        result.onerror = function() { reject(result.error || new Error('IDBRequest failed')); };
      } else if (result && typeof result.then === 'function') {
        result.then(resolve).catch(reject);
      } else {
        tx.oncomplete = function() { resolve(result); };
        tx.onerror = function() { reject(tx.error || new Error('Transaction failed')); };
        tx.onabort = function() { reject(new Error('Transaction was aborted')); };
      }
    });
  }

  _generateId() {
    var timestamp = Date.now().toString(36);
    var randomPart = '';
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    for (var i = 0; i < 8; i++) {
      randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return timestamp + '-' + randomPart;
  }

  _createDefaultPreferences() {
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var prefersRTL = navigator.language && (navigator.language.startsWith('fa') || navigator.language.startsWith('ar'));
    var prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var prefersHighContrast = window.matchMedia && window.matchMedia('(prefers-contrast: high)').matches;
    var hardwareConcurrency = navigator.hardwareConcurrency || 4;
    var deviceMemory = navigator.deviceMemory || 4;
    var isLowEndDevice = hardwareConcurrency <= 2 || deviceMemory <= 2;
    var isHighEndDevice = hardwareConcurrency >= 8 && deviceMemory >= 8;
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    var isSlowConnection = conn && (conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g');
    return {
      theme: prefersDark ? 'dark' : 'light',
      language: prefersRTL ? 'fa' : 'en',
      fontSize: 'medium',
      reducedMotion: prefersReducedMotion,
      highContrast: prefersHighContrast,
      search: {
        fuzzyTolerance: 0.4,
        maxResults: 12,
        autoSuggest: true
      },
      chat: {
        showWelcomeMessage: true,
        autoScrollToBottom: true,
        compactMode: false
      },
      advanced: {
        enableVectorSearch: !isLowEndDevice,
        preloadAIModel: isHighEndDevice && !isSlowConnection,
        developerMode: false
      },
      updatedAt: new Date().toISOString()
    };
  }

  getStatus() {
    var localStorageAvailable = false;
    try { localStorage.setItem('_s', '1'); localStorage.removeItem('_s'); localStorageAvailable = true; } catch(e) {}
    var sessionStorageAvailable = false;
    try { sessionStorage.setItem('_s', '1'); sessionStorage.removeItem('_s'); sessionStorageAvailable = true; } catch(e) {}
    return {
      indexedDB: this._dbReady,
      localStorage: localStorageAvailable,
      sessionStorage: sessionStorageAvailable,
      usingFallback: this._usingFallback,
      quotaPercent: this._quotaPercent,
      dbError: this._dbError ? this._dbError.message : null
    };
  }
}

export var storage = new StorageManager();
