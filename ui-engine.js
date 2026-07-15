import { CONFIG, ENV, THEMES, I18N, t, createDefaultPreferences } from './config.js';

export class UIEngine {
  constructor() {
    this.root = null;
    this.state = {
      query: '',
      results: [],
      isThinking: false,
      autocomplete: [],
      showAutocomplete: false,
      selectedAutocompleteIndex: -1,
      currentConversation: null,
      conversations: [],
      currentRoute: 'chat',
      preferences: createDefaultPreferences(),
      commandPaletteOpen: false,
      commandPaletteQuery: '',
      commandPaletteResults: [],
      commandPaletteSelected: -1,
      modalOpen: false,
      modalContent: null,
      mobileMenuOpen: false,
      tourActive: false,
      tourStep: 0,
      devtoolsOpen: false,
      suggestionsRemaining: CONFIG.MAX_SUGGESTIONS_PER_DAY,
      stats: { totalLibraries: 0, totalSearches: 0, categories: {} }
    };
    this.eventHandlers = {};
    this._autocompleteTimer = null;
    this._mouseDownOnAutocomplete = false;
    this._renderedMessages = new Map();
    this._scrollContainer = null;
    this._toastIdCounter = 0;
    this._splashAnimationId = null;
  }

  init(rootElement) {
    this.root = rootElement;
    this._bindGlobalEvents();
    this._applyPreferences();
    this.renderChatPage();
    this._updateSidebarActive('chat');
  }

  on(event, handler) {
    if (!this.eventHandlers[event]) {
      this.eventHandlers[event] = [];
    }
    this.eventHandlers[event].push(handler);
  }

  _emit(event, data) {
    var handlers = this.eventHandlers[event];
    if (handlers) {
      for (var i = 0; i < handlers.length; i++) {
        handlers[i](data);
      }
    }
  }

  _bindGlobalEvents() {
    var self = this;
    document.addEventListener('keydown', function(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        self.toggleCommandPalette();
        return;
      }
      if (e.key === 'Escape') {
        if (self.state.commandPaletteOpen) {
          self.closeCommandPalette();
          return;
        }
        if (self.state.modalOpen) {
          self.closeModal();
          return;
        }
        if (self.state.mobileMenuOpen) {
          self.closeMobileMenu();
          return;
        }
        if (self.state.showAutocomplete) {
          self.state.showAutocomplete = false;
          self.state.selectedAutocompleteIndex = -1;
          var dropdown = document.getElementById('autocomplete-dropdown');
          if (dropdown) dropdown.remove();
          return;
        }
      }
    });

    document.addEventListener('click', function(e) {
      if (self.state.showAutocomplete) {
        var inputWrapper = document.querySelector('.chat-input-wrapper');
        if (inputWrapper && !inputWrapper.contains(e.target)) {
          self.state.showAutocomplete = false;
          self.state.selectedAutocompleteIndex = -1;
          var dropdown = document.getElementById('autocomplete-dropdown');
          if (dropdown) dropdown.remove();
        }
      }
    });

    window.addEventListener('resize', function() {
      if (window.innerWidth >= 1024 && self.state.mobileMenuOpen) {
        self.closeMobileMenu();
      }
    });
  }

  _applyPreferences() {
    var prefs = this.state.preferences;
    document.documentElement.setAttribute('data-theme', prefs.theme);
    if (prefs.theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    document.documentElement.lang = prefs.language;
    document.documentElement.dir = prefs.language === 'fa' ? 'rtl' : 'ltr';
    if (prefs.reducedMotion) {
      document.documentElement.classList.add('reduce-motion');
    } else {
      document.documentElement.classList.remove('reduce-motion');
    }
    this._updateI18nElements();
  }

  _updateI18nElements() {
    var lang = this.state.preferences.language;
    var elements = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      var key = el.getAttribute('data-i18n');
      if (key) {
        var text = t(key, lang);
        if (text && text !== key) {
          el.textContent = text;
        }
      }
    }
    var placeholders = document.querySelectorAll('[data-i18n-placeholder]');
    for (var j = 0; j < placeholders.length; j++) {
      var pel = placeholders[j];
      var pkey = pel.getAttribute('data-i18n-placeholder');
      if (pkey) {
        pel.placeholder = t(pkey, lang);
      }
    }
  }

  setPreferences(prefs) {
    this.state.preferences = prefs;
    this._applyPreferences();
  }

  getPreferences() {
    return this.state.preferences;
  }

  updateStats(stats) {
    this.state.stats = stats;
    if (this.state.currentRoute === 'about') {
      this.renderAboutPage();
    }
  }

  updateSuggestionsRemaining(remaining) {
    this.state.suggestionsRemaining = remaining;
  }

  setSearchEngine(engine) {
    this.searchEngine = engine;
  }

  toggleCommandPalette() {
    if (this.state.commandPaletteOpen) {
      this.closeCommandPalette();
    } else {
      this.openCommandPalette();
    }
  }

  openCommandPalette() {
    this.state.commandPaletteOpen = true;
    this.state.commandPaletteQuery = '';
    this.state.commandPaletteResults = [];
    this.state.commandPaletteSelected = -1;
    var palette = document.getElementById('command-palette');
    if (palette) {
      palette.classList.remove('hidden');
      palette.classList.add('open');
      var input = document.getElementById('command-palette-input');
      if (input) {
        input.value = '';
        setTimeout(function() { input.focus(); }, 100);
      }
      this._renderCommandPaletteResults();
    }
  }

  closeCommandPalette() {
    this.state.commandPaletteOpen = false;
    this.state.commandPaletteQuery = '';
    var palette = document.getElementById('command-palette');
    if (palette) {
      palette.classList.add('hidden');
      palette.classList.remove('open');
    }
  }

  _renderCommandPaletteResults() {
    var container = document.getElementById('command-palette-results');
    if (!container) return;
    var query = this.state.commandPaletteQuery.toLowerCase().trim();
    var lang = this.state.preferences.language;
    var items = [];
    if (!query) {
      items.push({ type: 'header', label: t('command.libraries', lang) });
      if (this.searchEngine && this.searchEngine.libraries) {
        var libs = this.searchEngine.libraries.slice(0, 6);
        for (var i = 0; i < libs.length; i++) {
          items.push({ type: 'library', library: libs[i] });
        }
      }
      items.push({ type: 'header', label: t('command.actions', lang) });
      items.push({ type: 'action', id: 'theme_toggle', label: t('command.theme_toggle', lang), icon: '🌓' });
      items.push({ type: 'action', id: 'lang_toggle', label: t('command.lang_toggle', lang), icon: '🌐' });
      items.push({ type: 'action', id: 'history', label: t('command.history_open', lang), icon: '📜' });
      items.push({ type: 'action', id: 'about', label: t('command.about_open', lang), icon: 'ℹ️' });
      items.push({ type: 'action', id: 'suggest', label: t('command.suggest_lib', lang), icon: '➕' });
    } else {
      if (this.searchEngine) {
        var searchResults = this.searchEngine.autocomplete(query, 8);
        for (var j = 0; j < searchResults.length; j++) {
          items.push({ type: 'library', library: searchResults[j] });
        }
      }
      items.push({ type: 'action', id: 'search_chat', label: (lang === 'fa' ? 'جستجو در چت: ' : 'Search in chat: ') + query, icon: '🔍' });
    }
    this.state.commandPaletteResults = items;
    var html = '';
    for (var k = 0; k < items.length; k++) {
      var item = items[k];
      if (item.type === 'header') {
        html += '<div class="px-3 py-2 text-[11px] font-semibold text-muted uppercase tracking-wider">' + item.label + '</div>';
      } else if (item.type === 'library') {
        var lib = item.library;
        var isSelected = k === this.state.commandPaletteSelected;
        html += '<div class="command-palette-item' + (isSelected ? ' highlighted' : '') + '" data-index="' + k + '" data-library-id="' + lib.id + '">';
        html += '<span class="text-lg">📦</span>';
        html += '<div class="flex-1"><div class="text-sm font-medium">' + lib.names.en + '</div><div class="text-xs text-muted">' + (lib.content.descriptions[lang] ? lib.content.descriptions[lang].short : lib.content.descriptions.en.short) + '</div></div>';
        html += '<span class="text-xs text-muted">' + lib.classification.category + '</span>';
        html += '</div>';
      } else if (item.type === 'action') {
        var isActionSelected = k === this.state.commandPaletteSelected;
        html += '<div class="command-palette-item' + (isActionSelected ? ' highlighted' : '') + '" data-index="' + k + '" data-action="' + item.id + '">';
        html += '<span class="text-lg">' + item.icon + '</span>';
        html += '<span class="text-sm">' + item.label + '</span>';
        html += '</div>';
      }
    }
    container.innerHTML = html;
    this._bindCommandPaletteEvents();
  }

  _bindCommandPaletteEvents() {
    var self = this;
    var container = document.getElementById('command-palette-results');
    if (!container) return;
    container.onclick = function(e) {
      var item = e.target.closest('.command-palette-item');
      if (item) {
        var index = parseInt(item.getAttribute('data-index'), 10);
        if (!isNaN(index)) {
          self._executeCommandPaletteItem(index);
        }
      }
    };
    container.onmouseover = function(e) {
      var item = e.target.closest('.command-palette-item');
      if (item) {
        var index = parseInt(item.getAttribute('data-index'), 10);
        if (!isNaN(index)) {
          self.state.commandPaletteSelected = index;
          self._renderCommandPaletteResults();
        }
      }
    };
    var input = document.getElementById('command-palette-input');
    if (input) {
      input.oninput = function() {
        self.state.commandPaletteQuery = input.value;
        self.state.commandPaletteSelected = -1;
        self._renderCommandPaletteResults();
      };
      input.onkeydown = function(e) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          self.state.commandPaletteSelected = Math.min(self.state.commandPaletteSelected + 1, self.state.commandPaletteResults.length - 1);
          self._renderCommandPaletteResults();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          self.state.commandPaletteSelected = Math.max(self.state.commandPaletteSelected - 1, -1);
          self._renderCommandPaletteResults();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (self.state.commandPaletteSelected >= 0) {
            self._executeCommandPaletteItem(self.state.commandPaletteSelected);
          }
        } else if (e.key === 'Escape') {
          self.closeCommandPalette();
        }
      };
    }
    var overlay = document.querySelector('#command-palette .fixed.inset-0');
    if (overlay) {
      overlay.onclick = function() {
        self.closeCommandPalette();
      };
    }
  }

  _executeCommandPaletteItem(index) {
    var items = this.state.commandPaletteResults;
    if (index < 0 || index >= items.length) return;
    var item = items[index];
    this.closeCommandPalette();
    if (item.type === 'library' && item.library) {
      this._emit('library-selected', item.library);
    } else if (item.type === 'action') {
      if (item.id === 'theme_toggle') {
        this._emit('toggle-theme');
      } else if (item.id === 'lang_toggle') {
        this._emit('toggle-language');
      } else if (item.id === 'history') {
        this._emit('navigate', 'history');
      } else if (item.id === 'about') {
        this._emit('navigate', 'about');
      } else if (item.id === 'suggest') {
        this.openSuggestionModal();
      } else if (item.id === 'search_chat') {
        this._emit('search-query', this.state.commandPaletteQuery);
      }
    }
  }

  openModal(content) {
    this.state.modalOpen = true;
    this.state.modalContent = content;
    var container = document.getElementById('modal-container');
    var contentEl = document.getElementById('modal-content');
    if (container && contentEl) {
      contentEl.innerHTML = content;
      container.classList.add('open');
      container.classList.remove('hidden');
    }
  }

  closeModal() {
    this.state.modalOpen = false;
    this.state.modalContent = null;
    var container = document.getElementById('modal-container');
    if (container) {
      container.classList.remove('open');
      container.classList.add('hidden');
    }
  }

  openSuggestionModal() {
    var lang = this.state.preferences.language;
    var remaining = this.state.suggestionsRemaining;
    var content = '<div class="p-6">';
    content += '<h2 class="text-xl font-bold mb-4">' + t('suggest.title', lang) + '</h2>';
    if (remaining <= 0) {
      content += '<div class="suggestion-remaining warning">' + t('suggest.remaining_zero', lang) + '</div>';
    } else {
      content += '<div class="suggestion-remaining">' + t('suggest.remaining', lang, { count: String(remaining), max: String(CONFIG.MAX_SUGGESTIONS_PER_DAY) }) + '</div>';
    }
    content += '<div class="form-group"><label class="form-label">' + t('suggest.name', lang) + ' <span class="text-error">*</span></label><input id="suggest-name" class="form-input" type="text" placeholder="e.g. Framer Motion"></div>';
    content += '<div class="form-group"><label class="form-label">' + t('suggest.url', lang) + '</label><input id="suggest-url" class="form-input" type="url" placeholder="https://github.com/..."></div>';
    content += '<div class="form-group"><label class="form-label">' + t('suggest.reason', lang) + '</label><textarea id="suggest-reason" class="form-textarea" placeholder="' + (lang === 'fa' ? 'توضیح کوتاه...' : 'Brief explanation...') + '"></textarea></div>';
    content += '<div class="flex gap-3 justify-end">';
    content += '<button id="suggest-cancel" class="btn btn-secondary">' + t('common.cancel', lang) + '</button>';
    content += '<button id="suggest-submit" class="btn btn-primary">' + t('suggest.submit', lang) + '</button>';
    content += '</div></div>';
    this.openModal(content);
    var self = this;
    setTimeout(function() {
      var cancelBtn = document.getElementById('suggest-cancel');
      var submitBtn = document.getElementById('suggest-submit');
      if (cancelBtn) cancelBtn.onclick = function() { self.closeModal(); };
      if (submitBtn) {
        submitBtn.onclick = function() {
          var name = document.getElementById('suggest-name');
          var url = document.getElementById('suggest-url');
          var reason = document.getElementById('suggest-reason');
          if (name && name.value.trim()) {
            self._emit('suggestion-submitted', {
              name: name.value.trim(),
              url: url ? url.value.trim() : '',
              reason: reason ? reason.value.trim() : ''
            });
            self.closeModal();
          } else {
            if (name) {
              name.classList.add('error');
              setTimeout(function() { name.classList.remove('error'); }, 2000);
            }
          }
        };
      }
    }, 100);
  }

  openSettingsModal() {
    var lang = this.state.preferences.language;
    var prefs = this.state.preferences;
    var content = '<div class="p-6"><h2 class="text-xl font-bold mb-6">' + t('settings.title', lang) + '</h2>';
    content += '<div class="settings-group"><div class="settings-group__title">' + t('settings.appearance', lang) + '</div>';
    content += '<div class="settings-option"><span class="settings-option__label">' + t('settings.theme', lang) + '</span><select id="setting-theme" class="form-input w-auto">';
    content += '<option value="light"' + (prefs.theme === 'light' ? ' selected' : '') + '>' + t('settings.theme_light', lang) + '</option>';
    content += '<option value="dark"' + (prefs.theme === 'dark' ? ' selected' : '') + '>' + t('settings.theme_dark', lang) + '</option>';
    content += '<option value="auto"' + (prefs.theme === 'auto' ? ' selected' : '') + '>' + t('settings.theme_auto', lang) + '</option>';
    content += '</select></div>';
    content += '<div class="settings-option"><span class="settings-option__label">' + t('settings.language', lang) + '</span><select id="setting-language" class="form-input w-auto">';
    content += '<option value="fa"' + (prefs.language === 'fa' ? ' selected' : '') + '>' + t('settings.language_fa', lang) + '</option>';
    content += '<option value="en"' + (prefs.language === 'en' ? ' selected' : '') + '>' + t('settings.language_en', lang) + '</option>';
    content += '</select></div></div>';
    content += '<div class="settings-group"><div class="settings-group__title">' + t('settings.data', lang) + '</div>';
    content += '<button id="setting-export" class="btn btn-secondary w-full mb-2">' + t('settings.export_data', lang) + '</button>';
    content += '<button id="setting-import" class="btn btn-secondary w-full mb-2">' + t('settings.import_data', lang) + '</button>';
    content += '<button id="setting-clear" class="btn btn-danger w-full">' + t('settings.clear_data', lang) + '</button></div>';
    content += '<div class="flex justify-end mt-4"><button id="setting-close" class="btn btn-primary">' + t('common.close', lang) + '</button></div>';
    content += '</div>';
    this.openModal(content);
    var self = this;
    setTimeout(function() {
      var themeSelect = document.getElementById('setting-theme');
      var langSelect = document.getElementById('setting-language');
      var exportBtn = document.getElementById('setting-export');
      var importBtn = document.getElementById('setting-import');
      var clearBtn = document.getElementById('setting-clear');
      var closeBtn = document.getElementById('setting-close');
      if (themeSelect) {
        themeSelect.onchange = function() {
          self._emit('preferences-changed', { theme: themeSelect.value });
          self.closeModal();
          self.openSettingsModal();
        };
      }
      if (langSelect) {
        langSelect.onchange = function() {
          self._emit('preferences-changed', { language: langSelect.value });
          self.closeModal();
          self.openSettingsModal();
        };
      }
      if (exportBtn) exportBtn.onclick = function() { self._emit('export-data'); self.closeModal(); };
      if (importBtn) {
        importBtn.onclick = function() {
          var input = document.createElement('input');
          input.type = 'file';
          input.accept = '.json';
          input.onchange = function(e) {
            var file = e.target.files[0];
            if (file) {
              self._emit('import-data', file);
            }
          };
          input.click();
          self.closeModal();
        };
      }
      if (clearBtn) {
        clearBtn.onclick = function() {
          if (confirm(t('settings.clear_confirm', lang))) {
            self._emit('clear-data');
            self.closeModal();
          }
        };
      }
      if (closeBtn) closeBtn.onclick = function() { self.closeModal(); };
    }, 100);
  }

  showToast(message, type, duration) {
    if (!type) type = 'info';
    if (!duration) duration = 3000;
    var container = document.getElementById('toast-container');
    if (!container) return;
    var toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    var icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    toast.innerHTML = '<span class="toast-icon">' + (icons[type] || 'ℹ️') + '</span><span class="flex-1 text-sm">' + this._escapeHtml(message) + '</span>';
    container.appendChild(toast);
    var self = this;
    setTimeout(function() {
      toast.classList.add('removing');
      setTimeout(function() {
        if (toast.parentNode) {
          toast.parentNode.removeChild(toast);
        }
      }, 300);
    }, duration);
  }

  toggleMobileMenu() {
    if (this.state.mobileMenuOpen) {
      this.closeMobileMenu();
    } else {
      this.openMobileMenu();
    }
  }

  openMobileMenu() {
    this.state.mobileMenuOpen = true;
    var menu = document.getElementById('mobile-menu');
    var overlay = document.getElementById('mobile-menu-overlay');
    if (menu) menu.classList.add('open');
    if (overlay) overlay.classList.add('open');
  }

  closeMobileMenu() {
    this.state.mobileMenuOpen = false;
    var menu = document.getElementById('mobile-menu');
    var overlay = document.getElementById('mobile-menu-overlay');
    if (menu) menu.classList.remove('open');
    if (overlay) overlay.classList.remove('open');
  }

  navigateTo(route) {
    this.state.currentRoute = route;
    this._updateSidebarActive(route);
    if (route === 'chat') {
      this.renderChatPage();
    } else if (route === 'history') {
      this.renderHistoryPage();
    } else if (route === 'about') {
      this.renderAboutPage();
    } else if (route === 'devtools') {
      this.renderDevtoolsPage();
    }
    window.location.hash = '#' + route;
  }

  _updateSidebarActive(route) {
    var navItems = document.querySelectorAll('.nav-item, .mobile-nav-item');
    for (var i = 0; i < navItems.length; i++) {
      var item = navItems[i];
      var itemRoute = item.getAttribute('data-route');
      if (itemRoute === route) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    }
  }

  renderChatPage() {
    if (!this.root) return;
    var lang = this.state.preferences.language;
    var html = '<div class="chat-window">';
    html += '<div class="chat-messages" id="chat-messages">';
    if (!this.state.currentConversation || this.state.currentConversation.messages.length === 0) {
      html += '<div class="welcome-message">';
      html += '<h2>' + t('chat.welcome_title', lang) + '</h2>';
      html += '<p class="text-secondary whitespace-pre-wrap text-sm leading-relaxed">' + t('chat.welcome_text', lang).replace(/\n/g, '<br>') + '</p>';
      html += '</div>';
    } else {
      var messages = this.state.currentConversation.messages;
      for (var i = 0; i < messages.length; i++) {
        html += this._renderMessage(messages[i]);
      }
    }
    html += '</div>';
    html += '<div class="chat-input-container">';
    html += '<div id="autocomplete-dropdown" class="autocomplete-dropdown hidden"></div>';
    html += '<div class="chat-input-wrapper">';
    html += '<textarea id="chat-input" class="chat-input-textarea" rows="1" placeholder="' + t('chat.input_placeholder', lang) + '" data-i18n-placeholder="chat.input_placeholder"></textarea>';
    html += '<button id="chat-send-btn" class="chat-send-btn" title="' + t('chat.send', lang) + '">';
    html += '<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 12h14M12 5l7 7-7 7"/></svg>';
    html += '</button>';
    html += '</div></div></div>';
    this.root.innerHTML = html;
    this._scrollContainer = document.getElementById('chat-messages');
    this._bindChatEvents();
    if (this.state.currentConversation && this.state.currentConversation.messages.length > 0) {
      this._scrollToBottom();
    }
  }

  _renderMessage(message) {
    var html = '';
    var role = message.role;
    var content = message.content;
    if (role === 'user') {
      html += '<div class="message user">';
      html += '<div class="message-avatar">U</div>';
      html += '<div class="message-bubble">';
      if (content.type === 'text') {
        html += '<p class="whitespace-pre-wrap">' + this._escapeHtml(content.text) + '</p>';
      }
      html += '</div></div>';
    } else if (role === 'assistant') {
      html += '<div class="message assistant">';
      html += '<div class="message-avatar">S</div>';
      html += '<div class="message-bubble">';
      if (content.type === 'text') {
        html += '<div class="whitespace-pre-wrap text-sm leading-relaxed">' + this._formatMarkdown(content.text) + '</div>';
      } else if (content.type === 'thinking') {
        html += '<div class="thinking-indicator">';
        html += '<div class="thinking-dot"></div><div class="thinking-dot"></div><div class="thinking-dot"></div><div class="thinking-dot"></div>';
        html += '</div>';
      } else if (content.type === 'search_results' || content.type === 'no_results') {
        html += '<div class="whitespace-pre-wrap text-sm leading-relaxed mb-4">' + this._formatMarkdown(content.text) + '</div>';
        if (content.results && content.results.length > 0) {
          html += '<div class="results-grid stagger-children">';
          for (var i = 0; i < content.results.length; i++) {
            html += this._renderLibraryCard(content.results[i]);
          }
          html += '</div>';
        }
      } else if (content.type === 'library_detail') {
        html += '<div class="whitespace-pre-wrap text-sm leading-relaxed">' + this._formatMarkdown(content.text) + '</div>';
      } else if (content.type === 'error') {
        html += '<div class="error-state"><div class="error-state__title">' + this._escapeHtml(content.error) + '</div></div>';
      }
      html += '</div></div>';
    } else if (role === 'system') {
      html += '<div class="text-center text-xs text-muted py-2">' + this._escapeHtml(content.text || '') + '</div>';
    }
    return html;
  }

  _renderLibraryCard(item) {
    var lib = item.library;
    var lang = this.state.preferences.language;
    var desc = lang === 'fa' ? lib.content.descriptions.fa.short : lib.content.descriptions.en.short;
    var html = '<div class="library-card" data-library-id="' + lib.id + '">';
    html += '<div class="library-card__header">';
    html += '<div class="library-card__icon">📦</div>';
    html += '<div><div class="library-card__name">' + this._escapeHtml(lib.names.en) + '</div>';
    html += '<div class="library-card__stars">⭐ ' + this._escapeHtml(lib.metadata && lib.metadata.githubStars ? lib.metadata.githubStars : '—') + '</div></div>';
    html += '</div>';
    html += '<div class="library-card__description">' + this._escapeHtml(desc) + '</div>';
    html += '<div class="library-card__meta">';
    html += '<span>📦 ' + this._escapeHtml(lib.metadata && lib.metadata.bundleSize ? lib.metadata.bundleSize : '—') + '</span>';
    html += '<span>📥 ' + this._escapeHtml(lib.metadata && lib.metadata.weeklyDownloads ? lib.metadata.weeklyDownloads : '—') + '</span>';
    html += '</div>';
    html += '<div class="library-card__tags">';
    var tags = lib.classification.tags.slice(0, 4);
    for (var i = 0; i < tags.length; i++) {
      html += '<span class="library-card__tag">#' + this._escapeHtml(tags[i]) + '</span>';
    }
    html += '</div></div>';
    return html;
  }

  _formatMarkdown(text) {
    var html = this._escapeHtml(text);
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/`([^`]+)`/g, '<code class="bg-surface px-1 py-0.5 rounded text-sm font-mono">$1</code>');
    html = html.replace(/\n\n/g, '</p><p class="mb-2">');
    html = html.replace(/\n/g, '<br>');
    html = '<p class="mb-2">' + html + '</p>';
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function(match, lang, code) {
      return '<div class="code-block"><div class="code-block__header"><span>' + (lang || 'code') + '</span><button class="code-block__copy" data-code="' + code.replace(/"/g, '&quot;') + '">📋</button></div><pre>' + code + '</pre></div>';
    });
    html = html.replace(/(\n)?(https?:\/\/\S+)/g, function(match, newline, url) {
      return (newline || '') + '<a href="' + url + '" target="_blank" rel="noopener noreferrer" class="text-violet-400 hover:underline">' + url + '</a>';
    });
    return html;
  }

  _escapeHtml(text) {
    if (!text) return '';
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
  }

  _bindChatEvents() {
    var self = this;
    var input = document.getElementById('chat-input');
    var sendBtn = document.getElementById('chat-send-btn');
    var messagesContainer = document.getElementById('chat-messages');

    if (input) {
      input.addEventListener('input', function() {
        self.state.query = input.value;
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 128) + 'px';
        clearTimeout(self._autocompleteTimer);
        self._autocompleteTimer = setTimeout(function() {
          if (input.value.trim().length > 0 && self.searchEngine) {
            var suggestions = self.searchEngine.autocomplete(input.value.trim());
            self.state.autocomplete = suggestions;
            self.state.showAutocomplete = suggestions.length > 0;
            self._renderAutocomplete();
          } else {
            self.state.showAutocomplete = false;
            self._renderAutocomplete();
          }
        }, CONFIG.DEBOUNCE_AUTOCOMPLETE);
      });

      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (self.state.showAutocomplete && self.state.selectedAutocompleteIndex >= 0) {
            self._selectAutocomplete(self.state.selectedAutocompleteIndex);
          } else {
            self._sendMessage();
          }
        } else if (e.key === 'ArrowUp' && self.state.showAutocomplete) {
          e.preventDefault();
          self.state.selectedAutocompleteIndex = Math.max(self.state.selectedAutocompleteIndex - 1, -1);
          self._renderAutocomplete();
        } else if (e.key === 'ArrowDown' && self.state.showAutocomplete) {
          e.preventDefault();
          self.state.selectedAutocompleteIndex = Math.min(self.state.selectedAutocompleteIndex + 1, self.state.autocomplete.length - 1);
          self._renderAutocomplete();
        } else if (e.key === 'Escape' && self.state.showAutocomplete) {
          self.state.showAutocomplete = false;
          self.state.selectedAutocompleteIndex = -1;
          self._renderAutocomplete();
        }
      });

      input.addEventListener('focus', function() {
        if (input.value.trim().length > 0 && self.searchEngine) {
          var suggestions = self.searchEngine.autocomplete(input.value.trim());
          if (suggestions.length > 0) {
            self.state.autocomplete = suggestions;
            self.state.showAutocomplete = true;
            self._renderAutocomplete();
          }
        }
      });
    }

    if (sendBtn) {
      sendBtn.addEventListener('click', function() {
        self._sendMessage();
      });
    }

    if (messagesContainer) {
      messagesContainer.addEventListener('click', function(e) {
        var card = e.target.closest('.library-card');
        if (card) {
          var libId = card.getAttribute('data-library-id');
          if (libId) {
            self._emit('library-selected-by-id', libId);
          }
        }
        var copyBtn = e.target.closest('.code-block__copy');
        if (copyBtn) {
          var code = copyBtn.getAttribute('data-code');
          if (code) {
            self._copyToClipboard(code, copyBtn);
          }
        }
      });
    }

    var hamburger = document.getElementById('hamburger-btn');
    if (hamburger) hamburger.onclick = function() { self.toggleMobileMenu(); };
    var mobileClose = document.getElementById('mobile-menu-close');
    if (mobileClose) mobileClose.onclick = function() { self.closeMobileMenu(); };
    var mobileOverlay = document.getElementById('mobile-menu-overlay');
    if (mobileOverlay) mobileOverlay.onclick = function() { self.closeMobileMenu(); };

    var sidebarSuggest = document.getElementById('suggest-btn-sidebar');
    if (sidebarSuggest) sidebarSuggest.onclick = function() { self.openSuggestionModal(); };
    var mobileSuggest = document.getElementById('mobile-suggest-btn');
    if (mobileSuggest) mobileSuggest.onclick = function() { self.openSuggestionModal(); self.closeMobileMenu(); };

    var sidebarSettings = document.getElementById('settings-btn-sidebar');
    if (sidebarSettings) sidebarSettings.onclick = function() { self.openSettingsModal(); };
    var mobileSettings = document.getElementById('mobile-settings-btn');
    if (mobileSettings) mobileSettings.onclick = function() { self.openSettingsModal(); self.closeMobileMenu(); };

    var navItems = document.querySelectorAll('.nav-item, .mobile-nav-item');
    for (var i = 0; i < navItems.length; i++) {
      (function(item) {
        item.addEventListener('click', function(e) {
          e.preventDefault();
          var route = item.getAttribute('data-route');
          if (route) {
            self._emit('navigate', route);
            self.closeMobileMenu();
          }
        });
      })(navItems[i]);
    }

    var modalOverlay = document.querySelector('#modal-container .fixed.inset-0');
    if (modalOverlay) {
      modalOverlay.addEventListener('click', function() {
        self.closeModal();
      });
    }
  }

  _renderAutocomplete() {
    var dropdown = document.getElementById('autocomplete-dropdown');
    if (!dropdown) return;
    if (!this.state.showAutocomplete || this.state.autocomplete.length === 0) {
      dropdown.classList.add('hidden');
      dropdown.innerHTML = '';
      return;
    }
    dropdown.classList.remove('hidden');
    var html = '';
    var lang = this.state.preferences.language;
    for (var i = 0; i < this.state.autocomplete.length; i++) {
      var lib = this.state.autocomplete[i];
      var isSelected = i === this.state.selectedAutocompleteIndex;
      var desc = lang === 'fa' ? lib.content.descriptions.fa.short : lib.content.descriptions.en.short;
      html += '<div class="autocomplete-item' + (isSelected ? ' highlighted' : '') + '" data-index="' + i + '">';
      html += '<span class="text-sm font-medium">' + this._escapeHtml(lib.names.en) + '</span>';
      html += '<span class="text-xs text-muted truncate flex-1">' + this._escapeHtml(desc) + '</span>';
      html += '<span class="text-[10px] text-muted bg-surface px-2 py-0.5 rounded-full">' + this._escapeHtml(lib.classification.category) + '</span>';
      html += '</div>';
    }
    dropdown.innerHTML = html;
    var self = this;
    dropdown.onmousedown = function() {
      self._mouseDownOnAutocomplete = true;
    };
    dropdown.onclick = function(e) {
      var item = e.target.closest('.autocomplete-item');
      if (item) {
        var index = parseInt(item.getAttribute('data-index'), 10);
        if (!isNaN(index)) {
          self._selectAutocomplete(index);
        }
      }
    };
  }

  _selectAutocomplete(index) {
    if (index < 0 || index >= this.state.autocomplete.length) return;
    var lib = this.state.autocomplete[index];
    this.state.showAutocomplete = false;
    this.state.selectedAutocompleteIndex = -1;
    this._renderAutocomplete();
    this._emit('library-selected', lib);
  }

  _sendMessage() {
    var input = document.getElementById('chat-input');
    if (!input) return;
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    this.state.query = '';
    this.state.showAutocomplete = false;
    this._renderAutocomplete();
    this._emit('message-sent', text);
  }

  addMessage(message) {
    if (!this.state.currentConversation) return;
    this.state.currentConversation.messages.push(message);
    this.state.currentConversation.updatedAt = new Date().toISOString();
    if (this.state.currentRoute === 'chat') {
      var container = document.getElementById('chat-messages');
      if (container) {
        var welcomeEl = container.querySelector('.welcome-message');
        if (welcomeEl) welcomeEl.remove();
        container.insertAdjacentHTML('beforeend', this._renderMessage(message));
        this._scrollToBottom();
      }
    }
  }

  showThinking() {
    if (this.state.currentRoute === 'chat') {
      var container = document.getElementById('chat-messages');
      if (container) {
        container.insertAdjacentHTML('beforeend', this._renderMessage({ role: 'assistant', content: { type: 'thinking' } }));
        this._scrollToBottom();
      }
    }
  }

  hideThinking() {
    var container = document.getElementById('chat-messages');
    if (container) {
      var thinkingEls = container.querySelectorAll('.thinking-indicator');
      for (var i = 0; i < thinkingEls.length; i++) {
        var parent = thinkingEls[i].closest('.message');
        if (parent) parent.remove();
      }
    }
  }

  setConversation(conversation) {
    this.state.currentConversation = conversation;
  }

  setConversations(conversations) {
    this.state.conversations = conversations;
  }

  _scrollToBottom() {
    var self = this;
    requestAnimationFrame(function() {
      var container = document.getElementById('chat-messages');
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    });
  }

  _copyToClipboard(text, buttonElement) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function() {
        if (buttonElement) {
          buttonElement.textContent = '✅';
          buttonElement.classList.add('copied');
          setTimeout(function() {
            buttonElement.textContent = '📋';
            buttonElement.classList.remove('copied');
          }, 2000);
        }
      }, function() {
        self.showToast(t('toast.clipboard_denied', self.state.preferences.language), 'error', 3000);
      });
    } else {
      this.showToast(t('toast.clipboard_denied', this.state.preferences.language), 'error', 3000);
    }
  }

  renderHistoryPage() {
    if (!this.root) return;
    var lang = this.state.preferences.language;
    var conversations = this.state.conversations || [];
    var html = '<div class="chat-window"><div class="p-6">';
    html += '<h1 class="text-2xl font-bold mb-6">' + t('history.title', lang) + '</h1>';
    if (conversations.length === 0) {
      html += '<div class="empty-state">';
      html += '<div class="empty-state__icon">📭</div>';
      html += '<div class="empty-state__title">' + t('history.empty', lang) + '</div>';
      html += '<div class="empty-state__description">' + t('history.empty_cta', lang) + '</div>';
      html += '<button id="history-start-chat" class="btn btn-primary">' + t('history.empty_cta', lang) + '</button>';
      html += '</div>';
    } else {
      html += '<div class="history-list">';
      for (var i = 0; i < conversations.length; i++) {
        var conv = conversations[i];
        var msgCount = conv.messages ? conv.messages.length : 0;
        var date = new Date(conv.updatedAt || conv.createdAt);
        var dateStr = this._formatDate(date, lang);
        html += '<div class="history-item" data-conversation-id="' + conv.id + '">';
        html += '<div><div class="history-item__title">' + this._escapeHtml(conv.title || (lang === 'fa' ? 'گفتگوی جدید' : 'New conversation')) + '</div>';
        html += '<div class="history-item__meta"><span>' + t('history.messages_count', lang, { count: String(msgCount) }) + '</span><span>' + dateStr + '</span></div></div>';
        html += '<button class="btn btn-ghost btn-sm history-delete-btn" data-conversation-id="' + conv.id + '">🗑️</button>';
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</div></div>';
    this.root.innerHTML = html;
    var self = this;
    var historyContainer = this.root.querySelector('.history-list');
    if (historyContainer) {
      historyContainer.addEventListener('click', function(e) {
        var historyItem = e.target.closest('.history-item');
        if (historyItem && !e.target.closest('.history-delete-btn')) {
          var convId = historyItem.getAttribute('data-conversation-id');
          if (convId) {
            self._emit('open-conversation', convId);
          }
        }
        var deleteBtn = e.target.closest('.history-delete-btn');
        if (deleteBtn) {
          e.stopPropagation();
          var convId = deleteBtn.getAttribute('data-conversation-id');
          if (convId && confirm(t('history.delete_confirm', lang))) {
            self._emit('delete-conversation', convId);
          }
        }
      });
    }
    var startChatBtn = document.getElementById('history-start-chat');
    if (startChatBtn) {
      startChatBtn.addEventListener('click', function() {
        self._emit('navigate', 'chat');
      });
    }
  }

  renderAboutPage() {
    if (!this.root) return;
    var lang = this.state.preferences.language;
    var stats = this.state.stats || { totalLibraries: 0, totalSearches: 0, categories: {} };
    var html = '<div class="chat-window"><div class="p-6">';
    html += '<div class="about-hero">';
    html += '<div class="about-hero__avatar">S</div>';
    html += '<h1 class="text-2xl font-bold mb-2">' + t('about.title', lang) + '</h1>';
    html += '<p class="text-secondary mb-4">' + t('about.tagline', lang) + '</p>';
    html += '<p class="text-sm text-muted max-w-lg mx-auto">' + t('about.mission_text', lang) + '</p>';
    html += '</div>';
    html += '<div class="about-stats mb-8">';
    html += '<div class="stat-card"><div class="stat-card__value">' + stats.totalLibraries + '</div><div class="stat-card__label">' + t('about.stats_libraries', lang) + '</div></div>';
    var categoryCount = Object.keys(stats.categories).length;
    html += '<div class="stat-card"><div class="stat-card__value">' + categoryCount + '</div><div class="stat-card__label">' + t('about.stats_categories', lang) + '</div></div>';
    html += '<div class="stat-card"><div class="stat-card__value">' + stats.totalSearches + '</div><div class="stat-card__label">' + t('about.stats_searches', lang) + '</div></div>';
    html += '<div class="stat-card"><div class="stat-card__value">99.9%</div><div class="stat-card__label">' + t('about.stats_uptime', lang) + '</div></div>';
    html += '</div>';
    html += '<div class="mb-8"><h3 class="text-lg font-semibold mb-4">' + t('about.tech_stack', lang) + '</h3>';
    html += '<div class="flex flex-wrap gap-2"><span class="library-card__tag">Vanilla JavaScript</span><span class="library-card__tag">ES Modules</span><span class="library-card__tag">IndexedDB</span><span class="library-card__tag">Transformers.js</span><span class="library-card__tag">Fuse.js</span><span class="library-card__tag">Tailwind CSS</span><span class="library-card__tag">GitHub Pages</span></div></div>';
    html += '<div class="mb-8"><h3 class="text-lg font-semibold mb-4">' + t('about.privacy', lang) + '</h3><p class="text-sm text-secondary">' + t('about.privacy_text', lang) + '</p></div>';
    html += '<div class="mb-8"><h3 class="text-lg font-semibold mb-4">' + t('about.open_source', lang) + '</h3><p class="text-sm text-secondary">' + t('about.open_source_text', lang) + '</p></div>';
    html += '<div class="text-center text-sm text-muted pt-4 border-t border-subtle">';
    html += '<p>' + t('about.founder', lang) + ' — ' + t('about.founder_title', lang) + '</p>';
    html += '<p class="mt-1">v' + CONFIG.VERSION + ' · ' + CONFIG.BUILD_DATE + '</p>';
    html += '</div>';
    html += '</div></div>';
    this.root.innerHTML = html;
  }

  renderDevtoolsPage() {
    if (!this.root) return;
    var lang = this.state.preferences.language;
    var html = '<div class="chat-window"><div class="p-6">';
    html += '<h1 class="text-2xl font-bold mb-6">' + t('devtools.title', lang) + '</h1>';
    html += '<div id="devtools-suggestions-list"></div>';
    html += '<div class="flex gap-3 mt-6">';
    html += '<button id="devtools-generate-issue" class="btn btn-primary">' + t('devtools.generate_issue', lang) + '</button>';
    html += '<button id="devtools-export-suggestions" class="btn btn-secondary">' + t('devtools.export_suggestions', lang) + '</button>';
    html += '</div></div></div>';
    this.root.innerHTML = html;
    var self = this;
    var generateBtn = document.getElementById('devtools-generate-issue');
    if (generateBtn) generateBtn.onclick = function() { self._emit('devtools-generate-issue'); };
    var exportBtn = document.getElementById('devtools-export-suggestions');
    if (exportBtn) exportBtn.onclick = function() { self._emit('devtools-export-suggestions'); };
  }

  renderSplashAnimation() {
    var canvas = document.getElementById('splash-canvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    var particleCount = ENV.isLowEndDevice ? CONFIG.SPLASH_PARTICLE_COUNT_LOW : CONFIG.SPLASH_PARTICLE_COUNT_HIGH;
    var particles = [];
    for (var i = 0; i < particleCount; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 1.5,
        vy: (Math.random() - 0.5) * 1.5,
        radius: Math.random() * 3 + 1,
        alpha: Math.random() * 0.5 + 0.3
      });
    }
    var self = this;
    function animate() {
      if (!document.getElementById('splash-screen') || document.getElementById('splash-screen').classList.contains('hide')) {
        self._splashAnimationId = null;
        return;
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0) p.x = canvas.width;
        if (p.x > canvas.width) p.x = 0;
        if (p.y < 0) p.y = canvas.height;
        if (p.y > canvas.height) p.y = 0;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(139, 92, 246, ' + p.alpha + ')';
        ctx.fill();
      }
      for (var j = 0; j < particles.length; j++) {
        for (var k = j + 1; k < particles.length; k++) {
          var dx = particles[j].x - particles[k].x;
          var dy = particles[j].y - particles[k].y;
          var dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < CONFIG.SPLASH_PARTICLE_CONNECTION_DIST) {
            ctx.beginPath();
            ctx.moveTo(particles[j].x, particles[j].y);
            ctx.lineTo(particles[k].x, particles[k].y);
            ctx.strokeStyle = 'rgba(6, 182, 212, ' + (0.15 * (1 - dist / CONFIG.SPLASH_PARTICLE_CONNECTION_DIST)) + ')';
            ctx.lineWidth = 0.5;
            ctx.stroke();
          }
        }
      }
      self._splashAnimationId = requestAnimationFrame(animate);
    }
    animate();
    setTimeout(function() {
      var logo = document.getElementById('splash-logo');
      var tagline = document.getElementById('splash-tagline');
      var progress = document.getElementById('splash-progress');
      var status = document.getElementById('splash-status');
      if (logo) logo.classList.add('show');
      if (tagline) tagline.classList.add('show');
      if (progress) progress.classList.add('show');
      if (status) status.classList.add('show');
    }, 300);
  }

  hideSplash() {
    if (this._splashAnimationId) {
      cancelAnimationFrame(this._splashAnimationId);
      this._splashAnimationId = null;
    }
    var splash = document.getElementById('splash-screen');
    if (splash) {
      splash.classList.add('hide');
    }
    var shell = document.getElementById('app-shell');
    if (shell) {
      shell.classList.remove('hidden');
      requestAnimationFrame(function() {
        shell.classList.add('visible');
      });
    }
  }

  _formatDate(date, lang) {
    var now = new Date();
    var diff = now.getTime() - date.getTime();
    var dayMs = 86400000;
    if (diff < dayMs) {
      return t('history.today', lang);
    } else if (diff < 2 * dayMs) {
      return t('history.yesterday', lang);
    } else if (diff < 7 * dayMs) {
      return t('history.days_ago', lang, { n: String(Math.floor(diff / dayMs)) });
    }
    if (lang === 'fa') {
      return date.toLocaleDateString('fa-IR', { year: 'numeric', month: 'long', day: 'numeric' });
    }
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  updateSidebarInfo(totalLibraries, totalSearches, lang, theme) {
    var langBadge = document.getElementById('sidebar-lang-badge');
    if (langBadge) langBadge.textContent = lang === 'fa' ? 'FA' : 'EN';
    var themeIcon = document.getElementById('sidebar-theme-icon');
    if (themeIcon) {
      if (theme === 'dark') themeIcon.textContent = '🌙';
      else if (theme === 'light') themeIcon.textContent = '☀️';
      else themeIcon.textContent = '🌓';
    }
    this._updateI18nElements();
  }
}
