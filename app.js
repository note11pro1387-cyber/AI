import { CONFIG, ENV, t, createDefaultPreferences } from './config.js';
import { storage } from './storage.js';
import { SynapseAI } from './synapse-ai.js';
import { UIEngine } from './ui-engine.js';

var AppState = {
  initialized: false,
  libraries: [],
  preferences: null,
  conversations: [],
  currentConversation: null
};

var engine = null;
var ui = null;

async function fetchLibraries() {
  var controller = new AbortController();
  var timeoutId = setTimeout(function() { controller.abort(); }, 10000);
  var response = await fetch('data.json', { signal: controller.signal });
  clearTimeout(timeoutId);
  if (!response.ok) {
    throw new Error('Failed to load library data: ' + response.status + ' ' + response.statusText);
  }
  var data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error('Invalid library data format: expected an array');
  }
  return data;
}

function createNewConversation(title) {
  var id = 'conv-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 8);
  var now = new Date().toISOString();
  return {
    id: id,
    title: title || (AppState.preferences.language === 'fa' ? 'گفتگوی جدید' : 'New conversation'),
    messages: [],
    createdAt: now,
    updatedAt: now,
    metadata: {
      messageCount: 0,
      librariesDiscussed: [],
      language: AppState.preferences.language
    },
    pinned: false,
    archived: false
  };
}

function generateConversationTitle(messageText) {
  var text = messageText.trim();
  if (text.length <= 50) return text;
  return text.substring(0, 47) + '...';
}

async function loadConversation(id) {
  var conv = await storage.getConversation(id);
  if (conv) {
    AppState.currentConversation = conv;
    ui.setConversation(conv);
    ui.state.chatMode = 'chat';
    ui.navigateTo('chat');
    ui.renderChatPage();
  }
}

async function saveCurrentConversation() {
  if (!AppState.currentConversation) return;
  AppState.currentConversation.metadata.messageCount = AppState.currentConversation.messages.length;
  await storage.saveConversation(AppState.currentConversation);
  var allConversations = await storage.getAllConversations({ limit: 200 });
  AppState.conversations = allConversations;
  ui.setConversations(allConversations);
}

async function deleteConversation(id) {
  await storage.deleteConversation(id);
  if (AppState.currentConversation && AppState.currentConversation.id === id) {
    AppState.currentConversation = createNewConversation();
    ui.setConversation(AppState.currentConversation);
    ui.state.chatMode = 'start';
    ui.renderChatPage();
  }
  var allConversations = await storage.getAllConversations({ limit: 200 });
  AppState.conversations = allConversations;
  ui.setConversations(allConversations);
  if (ui.state.currentRoute === 'history') {
    ui.renderHistoryPage();
  }
}

async function handleMessageSent(text) {
  if (!AppState.currentConversation) {
    AppState.currentConversation = createNewConversation(generateConversationTitle(text));
  }
  if (AppState.currentConversation.messages.length === 0) {
    AppState.currentConversation.title = generateConversationTitle(text);
  }
  var userMessage = {
    id: 'msg-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 6),
    conversationId: AppState.currentConversation.id,
    role: 'user',
    timestamp: new Date().toISOString(),
    content: {
      type: 'text',
      text: text
    }
  };
  AppState.currentConversation.messages.push(userMessage);
  AppState.currentConversation.updatedAt = new Date().toISOString();
  ui.addMessage(userMessage);
  ui.showThinking();
  await saveCurrentConversation();

  var result = engine.search(text);
  ui.hideThinking();
  var response = engine.composeResponse(result.results, result.intent, AppState.preferences.language, text);

  var assistantMessage = {
    id: 'msg-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 6),
    conversationId: AppState.currentConversation.id,
    role: 'assistant',
    timestamp: new Date().toISOString(),
    content: response
  };

  if (response.type === 'search_results' && response.text && response.text.length > 150) {
    AppState.currentConversation.messages.push(assistantMessage);
    AppState.currentConversation.updatedAt = new Date().toISOString();
    ui.streamMessage(assistantMessage);
    await saveCurrentConversation();
  } else {
    AppState.currentConversation.messages.push(assistantMessage);
    AppState.currentConversation.updatedAt = new Date().toISOString();
    ui.addMessage(assistantMessage);
    await saveCurrentConversation();
  }

  var stats = engine.getStats();
  ui.updateStats(stats);
}

async function handleLibrarySelected(library) {
  var response = engine._composeLibraryDetail(library, AppState.preferences.language);
  var assistantMessage = {
    id: 'msg-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 6),
    conversationId: AppState.currentConversation ? AppState.currentConversation.id : 'temp',
    role: 'assistant',
    timestamp: new Date().toISOString(),
    content: response
  };
  if (!AppState.currentConversation) {
    AppState.currentConversation = createNewConversation(library.names.en);
    assistantMessage.conversationId = AppState.currentConversation.id;
  }
  AppState.currentConversation.messages.push(assistantMessage);
  AppState.currentConversation.updatedAt = new Date().toISOString();
  ui.addMessage(assistantMessage);
  await saveCurrentConversation();
}

async function handleLibrarySelectedById(libId) {
  var library = engine.getById(libId);
  if (library) {
    await handleLibrarySelected(library);
  }
}

async function handleSuggestionSubmitted(suggestion) {
  var result = storage.addSuggestion(suggestion);
  if (result.success) {
    ui.updateSuggestionsRemaining(result.remaining);
    ui.showToast(t('suggest.success', AppState.preferences.language) + ' ' + t('suggest.success_detail', AppState.preferences.language), 'success', 3000);
  } else {
    ui.showToast(result.error || t('suggest.error', AppState.preferences.language), 'error', 4000);
  }
}

async function handlePreferencesChanged(updates) {
  var prefs = storage.setPreferences(updates);
  AppState.preferences = prefs;
  ui.setPreferences(prefs);
  ui.updateSidebarInfo(AppState.libraries.length, engine ? engine.totalSearches : 0, prefs.language, prefs.theme);
  if (ui.state.currentRoute === 'chat') {
    ui.renderChatPage();
  }
}

async function handleToggleTheme() {
  var currentTheme = AppState.preferences.theme;
  var newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  await handlePreferencesChanged({ theme: newTheme });
}

async function handleToggleLanguage() {
  var currentLang = AppState.preferences.language;
  var newLang = currentLang === 'fa' ? 'en' : 'fa';
  await handlePreferencesChanged({ language: newLang });
}

async function handleExportData() {
  var blob = await storage.exportAllData();
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'synapse-export-' + new Date().toISOString().split('T')[0] + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  ui.showToast(t('toast.export_success', AppState.preferences.language), 'success', 3000);
}

async function handleImportData(file) {
  var result = await storage.importData(file);
  if (result.success) {
    ui.showToast(t('toast.import_success', AppState.preferences.language), 'success', 3000);
    var allConversations = await storage.getAllConversations({ limit: 200 });
    AppState.conversations = allConversations;
    ui.setConversations(allConversations);
    AppState.currentConversation = createNewConversation();
    ui.setConversation(AppState.currentConversation);
    ui.state.chatMode = 'start';
    ui.renderChatPage();
  } else {
    ui.showToast(result.error || t('error.import_invalid', AppState.preferences.language), 'error', 4000);
  }
}

async function handleClearData() {
  await storage.clearAllData();
  AppState.conversations = [];
  AppState.currentConversation = createNewConversation();
  ui.setConversations(AppState.conversations);
  ui.setConversation(AppState.currentConversation);
  ui.state.chatMode = 'start';
  ui.renderChatPage();
  ui.showToast(t('toast.data_cleared', AppState.preferences.language), 'success', 3000);
}

function handleNavigate(route) {
  if (route === 'chat') {
    if (!AppState.currentConversation) {
      AppState.currentConversation = createNewConversation();
      ui.setConversation(AppState.currentConversation);
      ui.state.chatMode = 'start';
    } else if (AppState.currentConversation.messages.length > 0) {
      ui.state.chatMode = 'chat';
    } else {
      ui.state.chatMode = 'start';
    }
    ui.navigateTo('chat');
  } else if (route === 'history') {
    ui.navigateTo('history');
  } else if (route === 'about') {
    ui.navigateTo('about');
  }
}

async function handleOpenConversation(convId) {
  await loadConversation(convId);
}

async function handleDeleteConversation(convId) {
  await deleteConversation(convId);
}

function handleSearchQuery(query) {
  var input = document.getElementById('chat-input');
  if (input) {
    input.value = query;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    var sendBtn = document.getElementById('chat-send-btn');
    if (sendBtn) sendBtn.click();
  }
}

function handleDevtoolsGenerateIssue() {
  var suggestions = storage.getSuggestions();
  if (suggestions.length === 0) {
    ui.showToast(t('devtools.no_suggestions', AppState.preferences.language), 'warning', 3000);
    return;
  }
  var title = 'پیشنهادات کاربران - ' + suggestions.length + ' مورد';
  var body = '## User Library Suggestions\n\n';
  for (var i = 0; i < suggestions.length; i++) {
    var s = suggestions[i];
    body += '### ' + (i + 1) + '. ' + s.name + '\n';
    if (s.url) body += '- **URL:** ' + s.url + '\n';
    if (s.reason) body += '- **Reason:** ' + s.reason + '\n';
    body += '- **Submitted:** ' + s.submittedAt + '\n';
    body += '- **Status:** ' + s.status + '\n\n';
  }
  body += '\n---\n*Generated by SYNAPSE DevTools*';
  var issueUrl = 'https://github.com/mjghaderi/synapse/issues/new?title=' + encodeURIComponent(title) + '&body=' + encodeURIComponent(body);
  window.open(issueUrl, '_blank');
  ui.showToast(t('devtools.issue_generated', AppState.preferences.language), 'success', 3000);
}

function handleDevtoolsExportSuggestions() {
  var suggestions = storage.getSuggestions();
  if (suggestions.length === 0) {
    ui.showToast(t('devtools.no_suggestions', AppState.preferences.language), 'warning', 3000);
    return;
  }
  var json = JSON.stringify(suggestions, null, 2);
  var blob = new Blob([json], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'synapse-suggestions-' + new Date().toISOString().split('T')[0] + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  ui.showToast(t('toast.export_success', AppState.preferences.language), 'success', 3000);
}

function setupEventListeners() {
  ui.on('message-sent', function(text) {
    handleMessageSent(text);
  });

  ui.on('library-selected', function(library) {
    handleLibrarySelected(library);
  });

  ui.on('library-selected-by-id', function(libId) {
    handleLibrarySelectedById(libId);
  });

  ui.on('suggestion-submitted', function(suggestion) {
    handleSuggestionSubmitted(suggestion);
  });

  ui.on('preferences-changed', function(updates) {
    handlePreferencesChanged(updates);
  });

  ui.on('toggle-theme', function() {
    handleToggleTheme();
  });

  ui.on('toggle-language', function() {
    handleToggleLanguage();
  });

  ui.on('export-data', function() {
    handleExportData();
  });

  ui.on('import-data', function(file) {
    handleImportData(file);
  });

  ui.on('clear-data', function() {
    handleClearData();
  });

  ui.on('navigate', function(route) {
    handleNavigate(route);
  });

  ui.on('open-conversation', function(convId) {
    handleOpenConversation(convId);
  });

  ui.on('delete-conversation', function(convId) {
    handleDeleteConversation(convId);
  });

  ui.on('search-query', function(query) {
    handleSearchQuery(query);
  });

  ui.on('devtools-generate-issue', function() {
    handleDevtoolsGenerateIssue();
  });

  ui.on('devtools-export-suggestions', function() {
    handleDevtoolsExportSuggestions();
  });
}

function checkDevtoolsRoute() {
  var hash = window.location.hash;
  if (hash.startsWith('#devtools')) {
    AppState.preferences.advanced.developerMode = true;
    ui.navigateTo('devtools');
    return true;
  }
  return false;
}

function handleRouteChange() {
  var hash = window.location.hash;
  if (hash.startsWith('#devtools')) {
    checkDevtoolsRoute();
    return;
  }
  var route = 'chat';
  if (hash === '#history') {
    route = 'history';
  } else if (hash === '#about') {
    route = 'about';
  } else if (hash.startsWith('#chat')) {
    route = 'chat';
    var convIdMatch = hash.match(/^#chat\/(.+)/);
    if (convIdMatch && convIdMatch[1]) {
      loadConversation(convIdMatch[1]);
      return;
    }
  }
  handleNavigate(route);
}

window.addEventListener('hashchange', function() {
  handleRouteChange();
});

async function init() {
  AppState.preferences = storage.getPreferences();
  ui = new UIEngine();
  ui.setPreferences(AppState.preferences);

  var appShell = document.getElementById('app-shell');
  var mainContent = document.getElementById('main-content');
  var routerView = document.getElementById('router-view');
  if (!routerView) {
    var newRouterView = document.createElement('div');
    newRouterView.id = 'router-view';
    newRouterView.className = 'flex-1 overflow-y-auto overflow-x-hidden';
    if (mainContent) {
      mainContent.appendChild(newRouterView);
    }
    routerView = newRouterView;
  }

  ui.init(routerView);
  setupEventListeners();

  var splashSeen = storage.isSplashSeenThisSession();
  if (CONFIG.FEATURES.ENABLE_SPLASH_SCREEN && !splashSeen && !ENV.prefersReducedMotion && !ENV.isSlowConnection) {
    ui.renderSplashAnimation();
    storage.markSplashSeen();
    setTimeout(function() {
      ui.hideSplash();
    }, CONFIG.SPLASH_DURATION);
  } else {
    var splash = document.getElementById('splash-screen');
    if (splash) {
      splash.classList.add('hide');
      splash.style.display = 'none';
    }
    if (appShell) {
      appShell.classList.remove('hidden');
      appShell.classList.add('visible');
    }
  }

  try {
    var libraries = await fetchLibraries();
    AppState.libraries = libraries;
  } catch (error) {
    ui.showToast(t('error.data_load', AppState.preferences.language), 'error', 5000);
    AppState.libraries = [];
  }

  engine = new SynapseAI(AppState.libraries);
  ui.setSearchEngine(engine);

  if (AppState.libraries.length > 0) {
    ui.updateStats(engine.getStats());
  }

  var initResult = await storage.init();
  if (initResult.usingFallback) {
    ui.showToast(t('app.offline', AppState.preferences.language), 'warning', 5000);
  }

  var allConversations = await storage.getAllConversations({ limit: 200 });
  AppState.conversations = allConversations;
  ui.setConversations(allConversations);

  var draftConv = storage.getDraftConversation();
  if (draftConv && draftConv.messages && draftConv.messages.length > 0) {
    AppState.currentConversation = draftConv;
    ui.state.chatMode = 'chat';
  } else {
    AppState.currentConversation = createNewConversation();
    ui.state.chatMode = 'start';
  }
  ui.setConversation(AppState.currentConversation);

  var suggestions = storage.getSuggestions();
  var today = new Date().toISOString().split('T')[0];
  var todayCount = 0;
  for (var i = 0; i < suggestions.length; i++) {
    if (suggestions[i].submittedAt && suggestions[i].submittedAt.startsWith(today)) {
      todayCount++;
    }
  }
  ui.updateSuggestionsRemaining(CONFIG.MAX_SUGGESTIONS_PER_DAY - todayCount);

  ui.updateSidebarInfo(AppState.libraries.length, engine.totalSearches, AppState.preferences.language, AppState.preferences.theme);

  var isDevtools = checkDevtoolsRoute();
  if (!isDevtools) {
    handleRouteChange();
  }

  if (!ENV.isOnline) {
    ui.showToast(t('app.offline', AppState.preferences.language), 'warning', 5000);
  }

  window.addEventListener('online', function() {
    ui.showToast('Back online!', 'success', 3000);
  });

  window.addEventListener('offline', function() {
    ui.showToast(t('app.offline', AppState.preferences.language), 'warning', 5000);
  });

  window.addEventListener('beforeunload', function() {
    if (AppState.currentConversation && AppState.currentConversation.messages.length > 0) {
      storage.saveDraftConversation(AppState.currentConversation);
    }
  });

  AppState.initialized = true;
}

document.addEventListener('DOMContentLoaded', function() {
  init().catch(function(error) {
    var splash = document.getElementById('splash-screen');
    if (splash) {
      splash.classList.add('hide');
      splash.style.display = 'none';
    }
    var shell = document.getElementById('app-shell');
    if (shell) {
      shell.classList.remove('hidden');
      shell.classList.add('visible');
    }
    var routerView = document.getElementById('router-view');
    if (routerView) {
      routerView.innerHTML = '<div class="flex items-center justify-center h-full"><div class="error-state"><div class="error-state__title">Failed to initialize SYNAPSE</div><p class="text-sm text-muted mt-2">' + error.message + '</p><button class="btn btn-primary mt-4" onclick="location.reload()">Reload</button></div></div>';
    }
  });
});
