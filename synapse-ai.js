import { CONFIG, SYNONYMS, STOP_WORDS, INTENT_RULES } from './config.js';

export class SynapseAI {
  constructor(libraries) {
    this.libraries = libraries || [];
    this.searchHistory = [];
    this.totalSearches = 0;
    this.avgTime = 0;
    this.index = [];
    this.docFrequency = {};
    this.idf = {};
    this._buildIndex();
  }

  _buildIndex() {
    this.index = [];
    this.docFrequency = {};
    var totalDocs = this.libraries.length;
    for (var i = 0; i < this.libraries.length; i++) {
      var lib = this.libraries[i];
      var textParts = [
        this._safeGet(lib, 'names.en', '').toLowerCase(),
        this._safeGet(lib, 'names.fa', ''),
        this._safeGet(lib, 'content.descriptions.fa.short', '') + ' ' + this._safeGet(lib, 'content.descriptions.fa.long', ''),
        this._safeGet(lib, 'content.descriptions.en.short', '') + ' ' + this._safeGet(lib, 'content.descriptions.en.long', ''),
        (lib.classification && lib.classification.tags ? lib.classification.tags.join(' ') : '').toLowerCase(),
        this._safeGet(lib, 'classification.category', '').toLowerCase(),
        (lib.names && lib.names.aliases ? lib.names.aliases.join(' ') : '').toLowerCase()
      ];
      var text = textParts.join(' ');
      var tokens = text.split(/\s+/);
      var uniqueTokens = [];
      var seen = {};
      for (var j = 0; j < tokens.length; j++) {
        var token = tokens[j];
        if (token.length > 1 && !seen[token]) {
          uniqueTokens.push(token);
          seen[token] = true;
        }
      }
      this.index.push({
        library: lib,
        _tokens: uniqueTokens,
        _text: text
      });
      for (var k = 0; k < uniqueTokens.length; k++) {
        var utoken = uniqueTokens[k];
        this.docFrequency[utoken] = (this.docFrequency[utoken] || 0) + 1;
      }
    }
    var keys = Object.keys(this.docFrequency);
    for (var m = 0; m < keys.length; m++) {
      var tk = keys[m];
      var df = this.docFrequency[tk];
      this.idf[tk] = Math.log((totalDocs + 1) / (df + 1)) + 1;
    }
  }

  _safeGet(obj, path, defaultValue) {
    var parts = path.split('.');
    var current = obj;
    for (var i = 0; i < parts.length; i++) {
      if (current == null || typeof current !== 'object') return defaultValue;
      current = current[parts[i]];
    }
    return current !== undefined ? current : defaultValue;
  }

  preprocess(query) {
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return null;
    }
    var normalized = query.trim().toLowerCase();
    var hasPersian = /[\u0600-\u06FF]/.test(query);
    var rawTokens = normalized.split(/\s+/);
    var filteredTokens = [];
    for (var i = 0; i < rawTokens.length; i++) {
      var token = rawTokens[i];
      if (token.length > 1 && !STOP_WORDS.has(token) && !/^[0-9۰-۹]+$/.test(token)) {
        filteredTokens.push(token);
      }
    }
    return {
      original: query.trim(),
      normalized: normalized,
      tokens: filteredTokens,
      language: hasPersian ? 'fa' : 'en',
      hasPersian: hasPersian
    };
  }

  detectIntent(processed) {
    var text = processed.original.toLowerCase();
    var bestIntent = 'search';
    var bestWeight = 1;
    for (var i = 0; i < INTENT_RULES.length; i++) {
      var rule = INTENT_RULES[i];
      for (var j = 0; j < rule.patterns.length; j++) {
        if (rule.patterns[j].test(text)) {
          if (rule.weight > bestWeight) {
            bestWeight = rule.weight;
            bestIntent = rule.intent;
          }
        }
      }
    }
    return bestIntent;
  }

  _expandTokens(tokens) {
    var expanded = [];
    var seen = {};
    for (var i = 0; i < tokens.length; i++) {
      var token = tokens[i];
      if (!seen[token]) {
        expanded.push(token);
        seen[token] = true;
      }
      var synonyms = SYNONYMS[token];
      if (synonyms && Array.isArray(synonyms)) {
        for (var j = 0; j < synonyms.length; j++) {
          var syn = synonyms[j];
          if (!seen[syn]) {
            expanded.push(syn);
            seen[syn] = true;
          }
        }
      }
    }
    return expanded;
  }

  fuzzySearch(processed, maxResults) {
    if (!maxResults) maxResults = CONFIG.MAX_SEARCH_RESULTS * 2;
    var queryTokens = this._expandTokens(processed.tokens);
    if (queryTokens.length === 0) return [];
    var results = [];
    for (var i = 0; i < this.index.length; i++) {
      var indexed = this.index[i];
      var libTokens = indexed._tokens;
      var intersection = 0;
      for (var j = 0; j < queryTokens.length; j++) {
        if (libTokens.indexOf(queryTokens[j]) >= 0) {
          intersection++;
        }
      }
      var unionSet = {};
      for (var k = 0; k < queryTokens.length; k++) { unionSet[queryTokens[k]] = true; }
      for (var l = 0; l < libTokens.length; l++) { unionSet[libTokens[l]] = true; }
      var unionSize = Object.keys(unionSet).length;
      var jaccard = unionSize > 0 ? intersection / unionSize : 0;
      var nameMatch = 0;
      var libNameLower = this._safeGet(indexed.library, 'names.en', '').toLowerCase();
      var libNameFa = this._safeGet(indexed.library, 'names.fa', '');
      var normalized = processed.normalized;
      if (libNameLower.indexOf(normalized) >= 0 || libNameFa.indexOf(normalized) >= 0) {
        nameMatch = CONFIG.NAME_MATCH_EXACT;
      } else {
        var aliases = this._safeGet(indexed.library, 'names.aliases', []);
        for (var a = 0; a < aliases.length; a++) {
          if (aliases[a].toLowerCase().indexOf(normalized) >= 0 || normalized.indexOf(aliases[a].toLowerCase()) >= 0) {
            nameMatch = CONFIG.NAME_MATCH_ALIAS;
            break;
          }
        }
      }
      var tagMatch = 0;
      var tags = this._safeGet(indexed.library, 'classification.tags', []);
      for (var t = 0; t < queryTokens.length; t++) {
        var qt = queryTokens[t];
        for (var tt = 0; tt < tags.length; tt++) {
          if (tags[tt].toLowerCase().indexOf(qt) >= 0 || qt.indexOf(tags[tt].toLowerCase()) >= 0) {
            tagMatch = CONFIG.TAG_MATCH_BONUS;
            break;
          }
        }
        if (tagMatch > 0) break;
      }
      var score = jaccard * CONFIG.JACCARD_WEIGHT + nameMatch + tagMatch;
      if (score > CONFIG.FUZZY_THRESHOLD) {
        results.push({ library: indexed.library, score: Math.min(score, 1), source: 'fuzzy' });
      }
    }
    results.sort(function(a, b) { return b.score - a.score; });
    return results.slice(0, maxResults);
  }

  semanticSearch(processed, maxResults) {
    if (!maxResults) maxResults = CONFIG.MAX_SEARCH_RESULTS * 2;
    var queryTokens = processed.tokens;
    if (queryTokens.length === 0) return [];
    var results = [];
    for (var i = 0; i < this.index.length; i++) {
      var indexed = this.index[i];
      var libTokens = indexed._tokens;
      var score = 0;
      for (var j = 0; j < queryTokens.length; j++) {
        var token = queryTokens[j];
        var tf = 0;
        for (var k = 0; k < libTokens.length; k++) {
          if (libTokens[k] === token) tf++;
        }
        tf = libTokens.length > 0 ? tf / libTokens.length : 0;
        var idfVal = this.idf[token] || 1;
        score += tf * idfVal;
      }
      score = Math.min(score / (queryTokens.length * 0.5), 1);
      if (score > CONFIG.SEMANTIC_THRESHOLD) {
        results.push({ library: indexed.library, score: score, source: 'semantic' });
      }
    }
    results.sort(function(a, b) { return b.score - a.score; });
    return results.slice(0, maxResults);
  }

  reciprocalRankFusion(fuzzyResults, semanticResults) {
    var k = CONFIG.RRF_K;
    var scores = {};
    for (var i = 0; i < fuzzyResults.length; i++) {
      var item = fuzzyResults[i];
      var id = item.library.id;
      var rrfScore = CONFIG.FUZZY_WEIGHT / (k + i + 1);
      scores[id] = (scores[id] || 0) + rrfScore;
    }
    for (var j = 0; j < semanticResults.length; j++) {
      var sItem = semanticResults[j];
      var sId = sItem.library.id;
      var sRrfScore = CONFIG.SEMANTIC_WEIGHT / (k + j + 1);
      scores[sId] = (scores[sId] || 0) + sRrfScore;
    }
    var merged = [];
    var ids = Object.keys(scores);
    for (var m = 0; m < ids.length; m++) {
      var libId = ids[m];
      var lib = null;
      for (var n = 0; n < this.libraries.length; n++) {
        if (this.libraries[n].id === libId) {
          lib = this.libraries[n];
          break;
        }
      }
      if (lib) {
        merged.push({ library: lib, score: Math.min(scores[libId] * 100, 100) });
      }
    }
    merged.sort(function(a, b) { return b.score - a.score; });
    return merged;
  }

  search(query, options) {
    var startTime = performance.now();
    var maxResults = (options && options.maxResults) ? options.maxResults : CONFIG.MAX_SEARCH_RESULTS;
    var processed = this.preprocess(query);
    if (!processed) {
      return { results: [], intent: 'search', processed: null, meta: { totalSearches: this.totalSearches, avgTime: this.avgTime.toFixed(1), elapsed: '0' } };
    }
    var intent = this.detectIntent(processed);
    var fuzzyResults = this.fuzzySearch(processed);
    var semanticResults = this.semanticSearch(processed);
    var merged = this.reciprocalRankFusion(fuzzyResults, semanticResults);
    var results = merged.slice(0, maxResults);
    var elapsed = performance.now() - startTime;
    this.totalSearches++;
    this.avgTime = this.totalSearches > 1
      ? (this.avgTime * (this.totalSearches - 1) + elapsed) / this.totalSearches
      : elapsed;
    this.searchHistory.push({
      query: query,
      resultCount: results.length,
      intent: intent,
      timestamp: Date.now()
    });
    if (this.searchHistory.length > CONFIG.SEARCH_HISTORY_LIMIT) {
      this.searchHistory.shift();
    }
    return {
      results: results,
      intent: intent,
      processed: processed,
      meta: {
        totalSearches: this.totalSearches,
        avgTime: this.avgTime.toFixed(1),
        elapsed: elapsed.toFixed(1)
      }
    };
  }

  autocomplete(query, maxResults) {
    if (!query || typeof query !== 'string' || query.trim().length < 1) return [];
    if (!maxResults) maxResults = CONFIG.MAX_AUTOCOMPLETE_RESULTS;
    var lower = query.toLowerCase().trim();
    var matches = [];
    for (var i = 0; i < this.libraries.length; i++) {
      var lib = this.libraries[i];
      var score = 0;
      var libNameEn = this._safeGet(lib, 'names.en', '').toLowerCase();
      if (libNameEn.startsWith(lower)) {
        score += CONFIG.AUTOCMPLETE_NAME_STARTS;
      } else if (libNameEn.indexOf(lower) >= 0) {
        score += CONFIG.AUTOCOMPLETE_NAME_CONTAINS;
      }
      var libNameFa = this._safeGet(lib, 'names.fa', '');
      if (libNameFa.indexOf(lower) >= 0) {
        score += CONFIG.AUTOCOMPLETE_FA_NAME;
      }
      var aliases = this._safeGet(lib, 'names.aliases', []);
      for (var a = 0; a < aliases.length; a++) {
        if (aliases[a].toLowerCase().startsWith(lower)) {
          score += CONFIG.AUTOCOMPLETE_ALIAS_STARTS;
          break;
        } else if (aliases[a].toLowerCase().indexOf(lower) >= 0) {
          score += CONFIG.AUTOCOMPLETE_ALIAS_CONTAINS;
          break;
        }
      }
      var tags = this._safeGet(lib, 'classification.tags', []);
      for (var t = 0; t < tags.length; t++) {
        if (tags[t].toLowerCase().indexOf(lower) >= 0) {
          score += CONFIG.AUTOCOMPLETE_TAG;
          break;
        }
      }
      var category = this._safeGet(lib, 'classification.category', '').toLowerCase();
      if (category.indexOf(lower) >= 0) {
        score += CONFIG.AUTOCOMPLETE_CATEGORY;
      }
      if (score > 0) {
        matches.push({ library: lib, score: score });
      }
    }
    matches.sort(function(a, b) { return b.score - a.score; });
    var result = [];
    for (var m = 0; m < Math.min(matches.length, maxResults); m++) {
      result.push(matches[m].library);
    }
    return result;
  }

  getById(id) {
    for (var i = 0; i < this.libraries.length; i++) {
      if (this.libraries[i].id === id) {
        return this.libraries[i];
      }
    }
    return null;
  }

  getStats() {
    var categories = {};
    for (var i = 0; i < this.libraries.length; i++) {
      var cat = this._safeGet(this.libraries[i], 'classification.category', 'Other');
      categories[cat] = (categories[cat] || 0) + 1;
    }
    return {
      totalLibraries: this.libraries.length,
      totalSearches: this.totalSearches,
      avgTime: this.avgTime.toFixed(1),
      categories: categories
    };
  }

  getCategoryStats() {
    var categories = {};
    for (var i = 0; i < this.libraries.length; i++) {
      var cat = this._safeGet(this.libraries[i], 'classification.category', 'Other');
      if (!categories[cat]) {
        categories[cat] = { count: 0, libraries: [] };
      }
      categories[cat].count++;
      categories[cat].libraries.push(this.libraries[i].id);
    }
    return categories;
  }

  composeResponse(results, intent, lang, query) {
    if (!lang) lang = 'fa';
    if (!query) query = '';
    var isFa = lang === 'fa';
    if (results.length === 0) {
      var randomLibs = this._getRandomLibraries(3);
      var noResultsText = isFa
        ? 'متأسفانه برای **«' + query + '»** نتیجه‌ای پیدا نکردم. 😕\n\nپیشنهاد می‌کنم این‌ها رو امتحان کنی:'
        : 'Sorry, I couldn\'t find anything for **"' + query + '"**. 😕\n\nTry these suggestions:';
      return {
        text: noResultsText,
        results: randomLibs,
        type: 'no_results'
      };
    }
    if (results.length === 1) {
      var lib = results[0].library;
      return this._composeLibraryDetail(lib, lang);
    }
    var count = results.length;
    var introText = isFa
      ? 'بر اساس جستجوی **«' + query + '»**، **' + count + '** کتابخانه مرتبط پیدا کردم:\n\nایناهاش 👇'
      : 'Based on **"' + query + '"**, I found **' + count + '** related libraries:\n\nHere you go 👇';
    return {
      text: introText,
      results: results,
      type: 'search_results'
    };
  }

  _composeLibraryDetail(lib, lang) {
    var isFa = lang === 'fa';
    var desc = this._safeGet(lib, 'content.descriptions.' + lang + '.short', '') ||
               this._safeGet(lib, 'content.descriptions.en.short', '');
    var longDesc = this._safeGet(lib, 'content.descriptions.' + lang + '.long', '') ||
                   this._safeGet(lib, 'content.descriptions.en.long', '');
    var intro = '📚 **' + this._safeGet(lib, 'names.en', lib.id) + '** — ' + desc + '\n\n' + longDesc;
    var externalNotice = isFa
      ? '\n\n> ⚠️ این یک کتابخانه **خارجی (Third-Party)** است و توسط SYNAPSE نگهداری نمی‌شود.'
      : '\n\n> ⚠️ This is a **third-party library** and is not maintained by SYNAPSE.';
    var installName = this._safeGet(lib, 'names.en', '').toLowerCase().replace(/\s+/g, '-') || lib.id;
    var installSection = '\n\n📦 **' + (isFa ? 'نصب' : 'Install') + '**' +
      '\n```bash\nnpm install ' + installName + '\n```';
    var linksSection = '\n\n🔗 **' + (isFa ? 'لینک‌ها' : 'Links') + '**';
    if (lib.resources) {
      if (lib.resources.docs) linksSection += '\n• 📖 ' + (isFa ? 'مستندات' : 'Documentation') + ': ' + lib.resources.docs;
      if (lib.resources.github) linksSection += '\n• ⭐ ' + (isFa ? 'گیت‌هاب' : 'GitHub') + ': ' + lib.resources.github;
      if (lib.resources.npm) linksSection += '\n• 📦 npm: ' + lib.resources.npm;
    }
    var metricsSection = '';
    if (lib.metadata) {
      metricsSection += '\n\n📊 **' + (isFa ? 'آمار' : 'Metrics') + '**';
      if (lib.metadata.githubStars) metricsSection += '\n• ⭐ ' + lib.metadata.githubStars + ' ' + (isFa ? 'ستاره' : 'stars');
      if (lib.metadata.weeklyDownloads) metricsSection += '\n• 📥 ' + lib.metadata.weeklyDownloads + ' ' + (isFa ? 'دانلود هفتگی' : 'weekly downloads');
      if (lib.metadata.bundleSize) metricsSection += '\n• 📦 ' + lib.metadata.bundleSize + ' ' + (isFa ? 'حجم' : 'size');
      if (lib.metadata.license) metricsSection += '\n• ⚖️ ' + lib.metadata.license + ' ' + (isFa ? 'مجوز' : 'license');
    }
    var alternativesSection = '';
    var alts = this._safeGet(lib, 'intelligence.alternatives', []);
    if (alts.length > 0) {
      var altNames = [];
      for (var a = 0; a < alts.length; a++) {
        var altLib = this.getById(alts[a]);
        if (altLib) {
          altNames.push(this._safeGet(altLib, 'names.en', alts[a]));
        } else {
          altNames.push(alts[a]);
        }
      }
      if (altNames.length > 0) {
        alternativesSection += '\n\n⚖️ **' + (isFa ? 'جایگزین‌ها' : 'Alternatives') + '**: ' + altNames.join(', ');
      }
    }
    var fullText = intro + externalNotice + installSection + linksSection + metricsSection + alternativesSection;
    return {
      text: fullText,
      results: [{ library: lib, score: 100 }],
      type: 'library_detail'
    };
  }

  _getRandomLibraries(count) {
    var shuffled = this.libraries.slice();
    for (var i = shuffled.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var temp = shuffled[i];
      shuffled[i] = shuffled[j];
      shuffled[j] = temp;
    }
    var result = [];
    for (var k = 0; k < Math.min(count, shuffled.length); k++) {
      result.push({ library: shuffled[k], score: 0 });
    }
    return result;
  }

  updateLibraries(newLibraries) {
    this.libraries = newLibraries || [];
    this._buildIndex();
    this.searchHistory = [];
    this.totalSearches = 0;
    this.avgTime = 0;
  }
}
