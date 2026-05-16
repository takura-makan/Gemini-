const CONFIG = {
  SHEET_ID_PROPERTY: 'DISPATCH_SHEET_ID',
  ADMIN_EMAILS_PROPERTY: 'DISPATCH_ADMIN_EMAILS',
  DEFAULT_ADMIN_EMAILS: 'takuramak@gmail.com',
  CHAT_WEBHOOK_PROPERTY: 'DISPATCH_CHAT_WEBHOOK_URL',
  SHEET_NAME: 'items',
  SOURCE_SHEET_NAME: 'sources',
  MAX_FETCH_ITEMS: 30,
  MAX_DISPLAY_ITEMS: 12,
  SKIP_TITLE_PATTERNS: [/weekly recap/i],
  SOURCE_HEADERS: [
    'enabled',
    'name',
    'kind',
    'url',
    'tier',
    'includeKeywords',
    'excludeKeywords',
    'tags',
    'queryHint',
    'notes',
  ],
  HEADERS: [
    'id',
    'status',
    'sourceDate',
    'type',
    'service',
    'title',
    'summary',
    'audience',
    'tryThis',
    'caution',
    'sourceName',
    'url',
    'priority',
    'createdAt',
    'updatedAt',
    'sourceTitle',
    'sourceExcerpt',
    'sourceCategories',
    'reviewChecklist',
    'reviewNotes',
    'publishedAt',
    'sourceKind',
    'sourceTier',
    'officialConfirmationUrl',
  ],
};

function doGet(e) {
  const mode = e && e.parameter && e.parameter.mode;
  const template = HtmlService.createTemplateFromFile(mode === 'publisher' ? 'Publisher' : 'Index');
  template.publisherUrl = `${ScriptApp.getService().getUrl()}?mode=publisher`;
  return template
    .evaluate()
    .setTitle(mode === 'publisher' ? 'Dispatch Publisher' : 'Workspace / Gemini Dispatch')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function setup() {
  const props = PropertiesService.getScriptProperties();
  let sheetId = props.getProperty(CONFIG.SHEET_ID_PROPERTY);

  if (!sheetId) {
    const ss = SpreadsheetApp.create('Workspace Gemini Dispatch Data');
    sheetId = ss.getId();
    props.setProperty(CONFIG.SHEET_ID_PROPERTY, sheetId);
  }

  const sheet = getItemsSheet_();
  ensureHeaders_(sheet);
  const sourceSheet = getSourcesSheet_();
  ensureSourceHeaders_(sourceSheet);
  seedDefaultSources_();

  return {
    sheetId,
    sheetUrl: SpreadsheetApp.openById(sheetId).getUrl(),
    webAppUrl: ScriptApp.getService().getUrl(),
    message: '初期設定が完了しました。dailyScan() で候補を取得できます。',
  };
}

function connectSpreadsheet(sheetId) {
  if (!sheetId) {
    throw new Error('接続するスプレッドシートIDを指定してください。');
  }

  const ss = SpreadsheetApp.openById(sheetId);
  PropertiesService.getScriptProperties().setProperty(CONFIG.SHEET_ID_PROPERTY, sheetId);
  ensureHeaders_(getItemsSheet_());
  ensureSourceHeaders_(getSourcesSheet_());
  seedDefaultSources_();

  return {
    sheetId,
    sheetUrl: ss.getUrl(),
    message: '接続先スプレッドシートを更新しました。dailyScan() を実行してください。',
  };
}

function installDailyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === 'dailyScan')
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));

  ScriptApp.newTrigger('dailyScan')
    .timeBased()
    .everyDays(1)
    .atHour(9)
    .create();

  return '毎日9時ごろに dailyScan() を実行するトリガーを設定しました。';
}

function dailyScan() {
  log_('dailyScan start');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    log_('dailyScan skipped: another scan is running');
    throw new Error('別の取得処理が実行中です。少し待ってから再実行してください。');
  }

  try {
    const result = scanSources_();
    log_(`dailyScan complete: ${result}`);
    return result;
  } catch (error) {
    log_(`dailyScan failed: ${error.stack || error.message || error}`);
    throw error;
  } finally {
    lock.releaseLock();
    log_('dailyScan lock released');
  }
}

function getPublishedItems() {
  return getRows_()
    .filter((item) => item.status === 'Published')
    .sort((a, b) => new Date(b.sourceDate) - new Date(a.sourceDate))
    .slice(0, CONFIG.MAX_DISPLAY_ITEMS);
}

function getCandidateItems() {
  return getRows_()
    .filter((item) => ['Candidate', 'Published'].includes(item.status))
    .sort((a, b) => new Date(b.sourceDate) - new Date(a.sourceDate));
}

function saveItemDraft(draft) {
  assertAdmin_();
  if (!draft || !draft.id) throw new Error('更新対象のIDがありません。');

  const allowed = [
    'type',
    'service',
    'title',
    'summary',
    'audience',
    'tryThis',
    'caution',
    'priority',
    'reviewNotes',
    'officialConfirmationUrl',
  ];
  const updates = {};
  allowed.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(draft, field)) {
      updates[field] = String(draft[field] || '').trim();
    }
  });

  updateFields_(draft.id, updates);
  return getCandidateItems();
}

function publishItem(id) {
  assertAdmin_();
  const item = getItemById_(id);
  validatePublishReady_(item);
  updateStatus_(id, 'Published');
  return getCandidateItems();
}

function archiveItem(id) {
  assertAdmin_();
  updateStatus_(id, 'Archived');
  return getCandidateItems();
}

function rejectItem(id) {
  assertAdmin_();
  updateStatus_(id, 'Rejected');
  return getCandidateItems();
}

function addManualCandidate(url) {
  assertAdmin_();
  const normalizedUrl = normalizeUrl_(url);
  if (!/^https?:\/\//i.test(normalizedUrl)) {
    throw new Error('http または https のURLを入力してください。');
  }

  const existing = new Set(getRows_().map((row) => normalizeUrl_(row.url)).filter(Boolean));
  if (existing.has(normalizedUrl)) {
    throw new Error('このURLはすでに候補に入っています。');
  }

  const response = UrlFetchApp.fetch(normalizedUrl, {
    muteHttpExceptions: true,
    followRedirects: true,
  });
  if (response.getResponseCode() >= 400) {
    throw new Error(`URLの取得に失敗しました: HTTP ${response.getResponseCode()}`);
  }

  const html = response.getContentText();
  const host = hostnameFromUrl_(normalizedUrl);
  const source = {
    name: host,
    kind: detectKindFromUrl_(normalizedUrl),
    tier: 'watch',
  };
  const title = extractHtmlTitle_(html) || normalizedUrl;
  const description = extractMetaDescription_(html) || title;
  const item = toCandidate_(source, title, normalizedUrl, description, new Date(), [source.kind, 'manual']);

  const sheet = getItemsSheet_();
  ensureHeaders_(sheet);
  appendItem_(sheet, item);
  notifyNewCandidates_([item]);
  return getCandidateItems();
}

function addNoteSource(input, includeKeywords, excludeKeywords) {
  assertAdmin_();
  const source = buildNoteSource_(input, includeKeywords, excludeKeywords);
  const sheet = getSourcesSheet_();
  ensureSourceHeaders_(sheet);

  const existing = getSourceRows_().find((row) => normalizeUrl_(row.url) === normalizeUrl_(source.url));
  if (existing) {
    return {
      added: false,
      message: `note取得元は登録済みです: ${existing.name}`,
      source: existing,
    };
  }

  const items = fetchFeed_(source);
  sheet.appendRow(CONFIG.SOURCE_HEADERS.map((header) => source[header]));

  return {
    added: true,
    message: `note取得元を登録しました: ${source.name}。確認できた記事数: ${items.length} 件。`,
    source,
  };
}

function addRssSource(url, name, includeKeywords, excludeKeywords) {
  assertAdmin_();
  const normalizedUrl = normalizeUrl_(url);
  if (!/^https?:\/\//i.test(normalizedUrl)) {
    throw new Error('http または https のRSS/Atom URLを入力してください。');
  }

  const source = {
    enabled: true,
    name: compactText_(name) || hostnameFromUrl_(normalizedUrl),
    kind: 'ブログ/RSS',
    url: normalizedUrl,
    tier: 'trusted',
    includeKeywords: normalizeKeywordList_(includeKeywords),
    excludeKeywords: normalizeKeywordList_(excludeKeywords),
    tags: normalizeKeywordList_(includeKeywords),
    queryHint: '投稿者画面から追加したRSS取得元',
    notes: '一般ブログ。必要に応じて公式情報も確認する',
  };

  const sheet = getSourcesSheet_();
  ensureSourceHeaders_(sheet);

  const existing = getSourceRows_().find((row) => normalizeUrl_(row.url) === source.url);
  if (existing) {
    return {
      added: false,
      message: `RSS取得元は登録済みです: ${existing.name}`,
      source: existing,
    };
  }

  const items = fetchFeed_(source);
  sheet.appendRow(CONFIG.SOURCE_HEADERS.map((header) => source[header]));

  return {
    added: true,
    message: `RSS取得元を登録しました: ${source.name}。確認できた記事数: ${items.length} 件。`,
    source,
  };
}

function addSearchSources(query, includeKeywords, excludeKeywords) {
  assertAdmin_();
  const searchTerms = parseKeywordList_(query);
  if (!searchTerms.length) {
    throw new Error('検索語句を入力してください。');
  }

  const include = normalizeKeywordList_(includeKeywords || query);
  const exclude = normalizeKeywordList_(excludeKeywords);
  const sources = buildSearchSources_(searchTerms, include, exclude);
  const sheet = getSourcesSheet_();
  ensureSourceHeaders_(sheet);
  const existingUrls = new Set(getSourceRows_().map((row) => normalizeUrl_(row.url)).filter(Boolean));
  const added = [];
  const skipped = [];

  sources.forEach((source) => {
    const key = normalizeUrl_(source.url);
    if (existingUrls.has(key)) {
      skipped.push(source.name);
      return;
    }
    sheet.appendRow(CONFIG.SOURCE_HEADERS.map((header) => source[header]));
    existingUrls.add(key);
    added.push(source.name);
  });

  return {
    addedCount: added.length,
    skippedCount: skipped.length,
    message: `検索取得元を ${added.length} 件登録しました。登録済みスキップ ${skipped.length} 件。`,
    added,
    skipped,
  };
}

function scanSources_() {
  log_('scanSources start');
  const sheet = getItemsSheet_();
  ensureHeaders_(sheet);

  const rowsBeforeRefresh = getRows_();
  const previouslyKnownSet = new Set(
    rowsBeforeRefresh
      .map((row) => normalizeUrl_(row.url))
      .filter(Boolean)
  );
  const refreshedCandidateCount = clearCandidateRows_(sheet);
  if (refreshedCandidateCount) {
    log_(`cleared candidate rows: ${refreshedCandidateCount}`);
  }

  const existingRows = getRows_();
  log_(`existing item rows: ${existingRows.length}, refreshed candidate rows: ${refreshedCandidateCount}`);
  const existingSet = new Set(
    existingRows
      .map((row) => normalizeUrl_(row.url))
      .filter(Boolean)
  );

  let fetchedCount = 0;
  let addedCount = 0;
  let skippedCount = 0;
  let duplicateCount = 0;
  let emptyUrlCount = 0;
  const addedItems = [];
  const errors = [];
  const sources = getEnabledSources_();
  log_(`enabled sources: ${sources.length}`);

  sources.forEach((source) => {
    let items = [];
    try {
      log_(`fetch source start: ${source.name} (${source.kind}/${source.tier}) ${source.url}`);
      items = fetchFeed_(source);
      log_(`fetch source success: ${source.name}, parsed items=${items.length}`);
    } catch (error) {
      log_(`fetch source failed: ${source.name}, ${error.message || error}`);
      errors.push(`${source.name}: ${error.message || error}`);
      return;
    }
    fetchedCount += items.length;

    items.forEach((item) => {
      if (!matchesSourceFilters_(item, source)) {
        skippedCount += 1;
        log_(`skip filter: ${source.name} / ${item.sourceTitle || item.title}`);
        return;
      }

      const key = normalizeUrl_(item.url);
      if (!key) {
        skippedCount += 1;
        emptyUrlCount += 1;
        log_(`skip empty url: ${source.name} / ${item.sourceTitle || item.title}`);
        return;
      }

      if (existingSet.has(key)) {
        skippedCount += 1;
        duplicateCount += 1;
        log_(`skip duplicate: ${source.name} / ${item.sourceTitle || item.title}`);
        return;
      }

      appendItem_(sheet, item);
      existingSet.add(key);
      addedCount += 1;
      if (!previouslyKnownSet.has(key)) addedItems.push(item);
      log_(`add candidate: ${item.sourceDate} ${item.sourceName} / ${item.service} / ${item.sourceTitle}`);
    });
  });

  notifyNewCandidates_(addedItems);

  const errorText = errors.length ? ` 取得失敗 ${errors.length} 件: ${errors.join(' / ')}` : '';
  const result = `取得完了: 候補リフレッシュ ${refreshedCandidateCount} 件、候補作成 ${addedCount} 件、通知対象 ${addedItems.length} 件、重複 ${duplicateCount} 件、URLなし ${emptyUrlCount} 件、スキップ合計 ${skippedCount} 件、確認対象 ${fetchedCount} 件、取得元 ${sources.length} 件。${errorText}`;
  log_(result);
  return result;
}

function fetchFeed_(source) {
  const response = UrlFetchApp.fetch(source.url, {
    muteHttpExceptions: true,
    followRedirects: true,
  });
  log_(`fetch response: ${source.name}, http=${response.getResponseCode()}`);

  if (response.getResponseCode() >= 400) {
    throw new Error(`${source.name} の取得に失敗しました: HTTP ${response.getResponseCode()}`);
  }

  const xml = XmlService.parse(response.getContentText());
  const root = xml.getRootElement();
  const rootName = root.getName().toLowerCase();
  log_(`feed root: ${source.name}, ${rootName}`);

  if (rootName === 'feed') return parseAtomFeed_(root, source);
  if (rootName === 'rss') return parseRssFeed_(root, source);

  throw new Error(`${source.name} のフィード形式を判定できませんでした。`);
}

function log_(message) {
  const line = `[Dispatch] ${message}`;
  console.log(line);
}

function parseAtomFeed_(root, source) {
  const atom = XmlService.getNamespace('http://www.w3.org/2005/Atom');
  const media = XmlService.getNamespace('http://search.yahoo.com/mrss/');
  return root
    .getChildren('entry', atom)
    .slice(0, CONFIG.MAX_FETCH_ITEMS)
    .map((entry) => {
      const title = text_(entry.getChild('title', atom));
      const content = text_(entry.getChild('content', atom)) || text_(entry.getChild('summary', atom)) || mediaDescription_(entry, media);
      const url = atomLink_(entry, atom);
      const sourceDate = text_(entry.getChild('published', atom)) || text_(entry.getChild('updated', atom));
      const categories = entry
        .getChildren('category', atom)
        .map((category) => attr_(category, 'term'))
        .filter(Boolean);

      return toCandidate_(source, title, url, content, sourceDate, categories);
    })
    .filter(Boolean);
}

function mediaDescription_(entry, media) {
  const group = entry.getChild('group', media);
  if (!group) return '';
  return text_(group.getChild('description', media));
}

function parseRssFeed_(root, source) {
  const channel = root.getChild('channel');
  if (!channel) return [];

  return channel
    .getChildren('item')
    .slice(0, CONFIG.MAX_FETCH_ITEMS)
    .map((item) => {
      const title = childText_(item, 'title');
      const url = childText_(item, 'link');
      const content = childText_(item, 'description');
      const sourceDate = childText_(item, 'pubDate');
      const categories = item.getChildren('category').map((category) => category.getText()).filter(Boolean);

      return toCandidate_(source, title, url, content, sourceDate, categories);
    })
    .filter(Boolean);
}

function toCandidate_(source, title, url, rawContent, rawDate, categories) {
  const sourceTitle = compactText_(title);
  if (!sourceTitle || shouldSkipTitle_(sourceTitle)) return null;

  const excerpt = truncate_(stripHtml_(rawContent), 1400);
  const service = detectService_(sourceTitle, excerpt, categories);
  const type = detectType_(sourceTitle, excerpt, service, categories);
  const caution = buildCaution_(service, type, source);

  return {
    id: idFromUrl_(url || `${source.name}:${sourceTitle}:${rawDate}`),
    status: 'Candidate',
    sourceDate: toDateString_(rawDate),
    type,
    service,
    title: sourceTitle,
    summary: buildSummary_(sourceTitle, excerpt, caution, source),
    audience: detectAudience_(service, sourceTitle, excerpt),
    tryThis: buildTryThis_(service),
    caution,
    sourceName: source.name,
    sourceKind: source.kind || 'feed',
    sourceTier: source.tier || 'watch',
    url,
    priority: type === '注意' || /gemini|ai|admin|meet|security|privacy/i.test(`${sourceTitle} ${excerpt}`) ? '高' : '中',
    sourceTitle,
    sourceExcerpt: excerpt,
    sourceCategories: categories.join(', '),
    reviewChecklist: buildReviewChecklist_(source),
    reviewNotes: '',
    officialConfirmationUrl: source.tier === 'official' ? url : '',
  };
}

function getItemsSheet_() {
  const props = PropertiesService.getScriptProperties();
  const sheetId = props.getProperty(CONFIG.SHEET_ID_PROPERTY);
  if (!sheetId) {
    throw new Error('DISPATCH_SHEET_ID が未設定です。先に setup() を実行してください。');
  }

  const ss = SpreadsheetApp.openById(sheetId);
  return ss.getSheetByName(CONFIG.SHEET_NAME) || ss.insertSheet(CONFIG.SHEET_NAME);
}

function getSourcesSheet_() {
  const props = PropertiesService.getScriptProperties();
  const sheetId = props.getProperty(CONFIG.SHEET_ID_PROPERTY);
  if (!sheetId) {
    throw new Error('DISPATCH_SHEET_ID が未設定です。先に setup() を実行してください。');
  }

  const ss = SpreadsheetApp.openById(sheetId);
  return ss.getSheetByName(CONFIG.SOURCE_SHEET_NAME) || ss.insertSheet(CONFIG.SOURCE_SHEET_NAME);
}

function ensureSourceHeaders_(sheet) {
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const current = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map((value) => String(value || '').trim());
  const isEmpty = current.every((value) => !value);

  if (isEmpty) {
    sheet.getRange(1, 1, 1, CONFIG.SOURCE_HEADERS.length).setValues([CONFIG.SOURCE_HEADERS]);
    sheet.setFrozenRows(1);
    return;
  }

  const missing = CONFIG.SOURCE_HEADERS.filter((header) => !current.includes(header));
  if (missing.length) {
    sheet.getRange(1, current.length + 1, 1, missing.length).setValues([missing]);
  }
  sheet.setFrozenRows(1);
}

function seedDefaultSources_() {
  const sheet = getSourcesSheet_();
  ensureSourceHeaders_(sheet);
  if (sheet.getLastRow() > 1) return;

  const existingKeys = new Set(getSourceRows_().map((source) => normalizeUrl_(source.url) || source.name));
  const rows = [
    {
      enabled: true,
      name: 'Google Workspace Updates',
      kind: '公式ブログ',
      url: 'https://workspaceupdates.googleblog.com/feeds/posts/default?alt=rss',
      tier: 'official',
      includeKeywords: '',
      excludeKeywords: '',
      tags: '',
      queryHint: 'Workspace / Gemini の公式リリース',
      notes: '公開前確認の最優先ソース',
    },
    {
      enabled: true,
      name: 'Google News: Workspace / Gemini',
      kind: 'ニュース',
      url: 'https://news.google.com/rss/search?q=Google%20Workspace%20Gemini%20OR%20%22Gemini%20for%20Google%20Workspace%22&hl=ja&gl=JP&ceid=JP:ja',
      tier: 'watch',
      includeKeywords: 'Google Workspace,Gemini,NotebookLM,Workspace Studio,Gmail,Google Meet,Google Chat,Google Drive,Google Docs,Google Sheets,Google Slides',
      excludeKeywords: '求人,採用,株価,広告',
      tags: '',
      queryHint: '外部ニュースの発見用',
      notes: '発見用。公開時は公式情報または一次情報で確認する',
    },
    {
      enabled: true,
      name: '吉積情報 コラボラボ',
      kind: '企業ブログ',
      url: 'https://www.yoshidumi.co.jp/collaboration-lab/rss.xml',
      tier: 'trusted',
      includeKeywords: 'Google Workspace,Gemini,NotebookLM,Workspace Studio,Gmail,Google Meet,Google Chat,Google Drive,Google Docs,Google Sheets,Google Slides,管理コンソール',
      excludeKeywords: '求人,採用,株価,広告,セミナー,イベント',
      tags: 'Google Workspace,Gemini',
      queryHint: '吉積情報のWorkspace/Gemini関連記事',
      notes: '一般ブログ。必要に応じて公式情報も確認する',
    },
  ];

  rows.forEach((source) => {
    const key = normalizeUrl_(source.url) || source.name;
    if (existingKeys.has(key)) return;
    sheet.appendRow(CONFIG.SOURCE_HEADERS.map((header) => source[header]));
    existingKeys.add(key);
  });
}

function buildSearchSources_(searchTerms, includeKeywords, excludeKeywords) {
  const phraseQuery = searchTerms.map((term) => quoteQueryTerm_(term)).join(' OR ');
  const label = searchTerms.join(' / ');
  const noteTags = searchTerms
    .map((term) => term.replace(/^#+/, '').trim())
    .filter(Boolean);

  const sources = [
    {
      enabled: true,
      name: `Google News search: ${label}`,
      kind: 'ニュース検索',
      url: googleNewsRssUrl_(phraseQuery),
      tier: 'watch',
      includeKeywords,
      excludeKeywords,
      tags: searchTerms.join(','),
      queryHint: `検索語句: ${label}`,
      notes: '検索語句から自動登録。公開時は公式情報または一次情報で確認する',
    },
  ];

  noteTags.forEach((tag) => {
    sources.push({
      enabled: true,
      name: `note tag: ${tag}`,
      kind: 'noteタグ',
      url: `https://note.com/hashtag/${encodeURIComponent(tag)}/rss`,
      tier: 'community',
      includeKeywords,
      excludeKeywords,
      tags: tag,
      queryHint: `noteタグ: ${tag}`,
      notes: 'noteタグから自動登録。公開時は公式情報または一次情報で確認する',
    });
  });

  return sources;
}

function googleNewsRssUrl_(query) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ja&gl=JP&ceid=JP:ja`;
}

function quoteQueryTerm_(term) {
  const value = String(term || '').trim();
  if (!value) return '';
  return /\s/.test(value) ? `"${value}"` : value;
}

function getEnabledSources_() {
  const rows = getSourceRows_();
  const sources = rows.filter((source) => source.enabled && source.url);
  if (!sources.length) {
    throw new Error('有効な取得元がありません。sources シートで enabled を TRUE にしてください。');
  }
  return sources;
}

function matchesSourceFilters_(item, source) {
  const includeKeywords = parseKeywordList_(source.includeKeywords || source.tags);
  const excludeKeywords = parseKeywordList_(source.excludeKeywords);
  if (!includeKeywords.length && !excludeKeywords.length) return true;

  const haystack = [
    item.sourceTitle,
    item.title,
    item.sourceExcerpt,
    item.summary,
    item.sourceCategories,
    item.service,
    item.type,
  ].join(' ').toLowerCase();

  const includesOk = !includeKeywords.length || includeKeywords.some((keyword) => haystack.includes(keyword.toLowerCase()));
  const excludesOk = !excludeKeywords.some((keyword) => haystack.includes(keyword.toLowerCase()));
  return includesOk && excludesOk;
}

function parseKeywordList_(value) {
  return String(value || '')
    .split(/[,、\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getSourceRows_() {
  const sheet = getSourcesSheet_();
  ensureSourceHeaders_(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const values = sheet.getRange(2, 1, lastRow - 1, CONFIG.SOURCE_HEADERS.length).getValues();
  return values
    .filter((row) => row[1] || row[3])
    .map((row) => CONFIG.SOURCE_HEADERS.reduce((acc, header, index) => {
      const value = row[index];
      acc[header] = header === 'enabled' ? isEnabled_(value) : String(value || '').trim();
      return acc;
    }, {}));
}

function isEnabled_(value) {
  if (value === true) return true;
  const text = String(value || '').trim().toLowerCase();
  return ['true', 'yes', 'y', '1', 'on'].includes(text);
}

function ensureHeaders_(sheet) {
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const current = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map((value) => String(value || '').trim());
  const isEmpty = current.every((value) => !value);

  if (isEmpty) {
    sheet.getRange(1, 1, 1, CONFIG.HEADERS.length).setValues([CONFIG.HEADERS]);
    sheet.setFrozenRows(1);
    return;
  }

  const missing = CONFIG.HEADERS.filter((header) => !current.includes(header));
  if (missing.length) {
    sheet.getRange(1, current.length + 1, 1, missing.length).setValues([missing]);
  }
  sheet.setFrozenRows(1);
}

function getRows_() {
  const sheet = getItemsSheet_();
  ensureHeaders_(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const values = sheet.getRange(2, 1, lastRow - 1, CONFIG.HEADERS.length).getValues();
  return values
    .filter((row) => row[0])
    .map((row) => rowToObject_(row));
}

function rowToObject_(row) {
  return CONFIG.HEADERS.reduce((acc, header, index) => {
    const value = row[index];
    acc[header] = value instanceof Date
      ? Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd')
      : value;
    return acc;
  }, {});
}

function clearCandidateRows_(sheet) {
  ensureHeaders_(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  const statusColumn = columnFor_('status');
  const statuses = sheet.getRange(2, statusColumn, lastRow - 1, 1).getValues().flat();
  let deletedCount = 0;
  for (let index = statuses.length - 1; index >= 0; index -= 1) {
    if (String(statuses[index] || '').trim() === 'Candidate') {
      sheet.deleteRow(index + 2);
      deletedCount += 1;
    }
  }
  return deletedCount;
}

function appendItem_(sheet, item) {
  const now = new Date();
  const row = CONFIG.HEADERS.map((header) => {
    if (header === 'createdAt' || header === 'updatedAt') return now;
    return Object.prototype.hasOwnProperty.call(item, header) ? item[header] : '';
  });
  sheet.appendRow(row);
}

function updateStatus_(id, status) {
  const updates = { status };
  if (status === 'Published') updates.publishedAt = new Date();
  updateFields_(id, updates);
}

function updateFields_(id, updates) {
  const sheet = getItemsSheet_();
  const rowNumber = findRowNumberById_(sheet, id);
  if (!rowNumber) throw new Error(`Item not found: ${id}`);

  Object.keys(updates).forEach((field) => {
    const column = columnFor_(field);
    if (!column) return;
    sheet.getRange(rowNumber, column).setValue(updates[field]);
  });
  sheet.getRange(rowNumber, columnFor_('updatedAt')).setValue(new Date());
}

function getItemById_(id) {
  const item = getRows_().find((row) => row.id === id);
  if (!item) throw new Error(`Item not found: ${id}`);
  return item;
}

function findRowNumberById_(sheet, id) {
  ensureHeaders_(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat();
  const index = ids.findIndex((value) => value === id);
  return index < 0 ? null : index + 2;
}

function columnFor_(field) {
  const index = CONFIG.HEADERS.indexOf(field);
  return index < 0 ? null : index + 1;
}

function validatePublishReady_(item) {
  const requiredFields = ['title', 'summary', 'audience', 'tryThis', 'caution', 'url'];
  const missing = requiredFields.filter((field) => !String(item[field] || '').trim());
  if (missing.length) {
    throw new Error(`公開前に未入力項目を埋めてください: ${missing.join(', ')}`);
  }

  const needsEdit = ['title', 'summary', 'audience', 'tryThis', 'caution'].some((field) =>
    String(item[field] || '').includes('[要編集]')
  );
  if (needsEdit) {
    throw new Error('公開前に [要編集] を削除し、元記事を確認した掲載文に直してください。');
  }
}

function atomLink_(entry, atom) {
  const links = entry.getChildren('link', atom);
  const alternate = links.find((link) => attr_(link, 'rel') === 'alternate');
  const firstHref = links.find((link) => attr_(link, 'href'));
  return attr_(alternate || firstHref, 'href');
}

function childText_(element, name) {
  const child = element.getChild(name);
  return child ? child.getText() : '';
}

function text_(element) {
  return element ? element.getText() : '';
}

function attr_(element, name) {
  if (!element) return '';
  const attribute = element.getAttribute(name);
  return attribute ? attribute.getValue() : '';
}

function shouldSkipTitle_(title) {
  return CONFIG.SKIP_TITLE_PATTERNS.some((pattern) => pattern.test(title));
}

function normalizeUrl_(url) {
  return String(url || '').trim().replace(/#.*$/, '').replace(/\/$/, '');
}

function buildNoteSource_(input, includeKeywords, excludeKeywords) {
  const feedUrl = noteFeedUrl_(input);
  const creator = noteCreatorName_(feedUrl);
  const tag = noteTagName_(feedUrl);
  return {
    enabled: true,
    name: tag ? `note tag: ${tag}` : creator ? `note: ${creator}` : 'note',
    kind: 'note',
    url: feedUrl,
    tier: 'community',
    includeKeywords: normalizeKeywordList_(includeKeywords),
    excludeKeywords: normalizeKeywordList_(excludeKeywords),
    tags: tag || normalizeKeywordList_(includeKeywords),
    queryHint: 'noteからWorkspace/Gemini活用記事を発見',
    notes: '発見用。公開時は公式情報または一次情報で確認する',
  };
}

function noteFeedUrl_(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    throw new Error('noteのユーザー名、クリエイターページURL、またはRSS URLを入力してください。');
  }

  if (raw.startsWith('#')) {
    const tag = raw.replace(/^#+/, '').trim();
    if (!tag) throw new Error('noteタグ名を入力してください。');
    return `https://note.com/hashtag/${encodeURIComponent(tag)}/rss`;
  }

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://note.com/${raw}`;
  const normalized = normalizeUrl_(withScheme);
  const match = normalized.match(/^https?:\/\/(?:www\.)?note\.com\/(.+)$/i);
  if (!match) {
    throw new Error('note.com のURL、またはnoteのユーザー名を入力してください。');
  }

  const path = match[1].replace(/^\/+|\/+$/g, '');
  if (path.startsWith('hashtag/')) {
    return path.endsWith('/rss') ? normalized : `https://note.com/${path}/rss`;
  }
  if (!path || path.includes('/n/')) {
    throw new Error('note記事URLではなく、クリエイターページURLまたはRSS URLを入力してください。');
  }
  if (path.endsWith('/rss')) return normalized;
  return `https://note.com/${path}/rss`;
}

function noteCreatorName_(feedUrl) {
  const match = String(feedUrl || '').match(/^https?:\/\/(?:www\.)?note\.com\/([^/]+)/i);
  return match && match[1] !== 'hashtag' ? match[1] : '';
}

function noteTagName_(feedUrl) {
  const match = String(feedUrl || '').match(/^https?:\/\/(?:www\.)?note\.com\/hashtag\/([^/]+)/i);
  return match ? decodeURIComponent(match[1]) : '';
}

function normalizeKeywordList_(value) {
  return String(value || '')
    .split(/[,、\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .join(',');
}

function hostnameFromUrl_(url) {
  const match = String(url || '').match(/^https?:\/\/([^/?#]+)/i);
  return match ? match[1].replace(/^www\./, '') : 'manual source';
}

function detectKindFromUrl_(url) {
  const host = hostnameFromUrl_(url).toLowerCase();
  if (host.includes('youtube.com') || host.includes('youtu.be')) return 'YouTube';
  if (host.includes('note.com')) return 'note';
  if (host.includes('news.google.com') || host.includes('itmedia') || host.includes('impress')) return 'ニュース';
  if (host.includes('blog') || host.includes('medium.com') || host.includes('zenn.dev') || host.includes('qiita.com')) return 'ブログ';
  return '外部記事';
}

function idFromUrl_(value) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value));
  return Utilities.base64EncodeWebSafe(digest).replace(/=+$/, '').slice(0, 22);
}

function extractHtmlTitle_(html) {
  const ogTitle = String(html || '').match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const title = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return decodeHtml_(stripHtml_(ogTitle ? ogTitle[1] : title ? title[1] : ''));
}

function extractMetaDescription_(html) {
  const meta = String(html || '').match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["']/i);
  return decodeHtml_(meta ? meta[1] : '');
}

function decodeHtml_(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripHtml_(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactText_(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncate_(value, limit) {
  const text = compactText_(value);
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function toDateString_(value) {
  const date = value ? new Date(value) : new Date();
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function detectService_(title, body, categories) {
  const text = `${title} ${body} ${(categories || []).join(' ')}`.toLowerCase();
  const services = [
    ['Gemini', ['gemini', 'ai ']],
    ['Admin', ['admin console', 'administrator', 'security', 'control center', 'admin']],
    ['Gmail', ['gmail']],
    ['Meet', ['meet']],
    ['Chat', ['chat']],
    ['Docs', ['docs', 'document']],
    ['Sheets', ['sheets', 'spreadsheet']],
    ['Drive', ['drive']],
    ['Calendar', ['calendar']],
    ['Slides', ['slides']],
    ['Chrome', ['chrome']],
  ];

  const found = services.find(([, keywords]) => keywords.some((keyword) => text.includes(keyword)));
  return found ? found[0] : 'Workspace';
}

function detectType_(title, body, service, categories) {
  const text = `${title} ${body} ${(categories || []).join(' ')}`.toLowerCase();
  if (/admin|security|consent|control|policy|audit|access|privacy|compliance|rollout|available to/.test(text) || service === 'Admin') {
    return '注意';
  }
  if (/gemini|prompt|summar|draft|analyz|generate|create|ai /.test(text)) {
    return '活用';
  }
  return '速報';
}

function detectAudience_(service, title, body) {
  const text = `${title} ${body}`.toLowerCase();
  if (service === 'Admin') return '情シス・管理者';
  if (service === 'Meet') return '会議主催者・管理者';
  if (service === 'Gmail' || service === 'Chat') return '全社・営業・CS';
  if (service === 'Sheets') return '企画・経理・管理';
  if (service === 'Docs' || service === 'Slides') return '全社・文書作成';
  if (text.includes('developer') || text.includes('api')) return '開発・管理者';
  return '全社';
}

function buildSummary_(title, excerpt, caution, source) {
  const sourceMemo = excerpt ? truncate_(excerpt, 180) : title;
  const prefix = source && source.tier !== 'official'
    ? `[要編集] ${source.kind || '外部情報'}からの発見候補です。公式情報または一次情報で確認してください。`
    : `[要編集] 公式記事では「${title}」について案内されています。`;
  return [
    prefix,
    `元記事メモ: ${sourceMemo}`,
    caution,
  ].join('\n');
}

function buildTryThis_(service) {
  const suggestions = {
    Admin: '[要編集] 管理コンソールで対象設定、対象エディション、影響範囲を確認する。',
    Meet: '[要編集] 会議主催者向けに、録画・文字起こし・Geminiメモ利用時の注意を短く共有する。',
    Gmail: '[要編集] 社内向けの軽いメール文面で下書きや要約を試す。',
    Chat: '[要編集] 大人数スペースへ投稿する前に、文章の言い回しを整える。',
    Docs: '[要編集] 議事録や提案書など、社内文書のたたき台で試す。',
    Sheets: '[要編集] ダミーデータや公開可能な表で、集計やグラフ作成を試す。',
    Chrome: '[要編集] よく使う要約や調査の指示を保存して再利用する。',
  };
  return suggestions[service] || '[要編集] 社内情報を入れずに、公開可能な検証データで動作を確認する。';
}

function buildCaution_(service, type, source) {
  if (source && source.tier !== 'official') {
    return '[要編集] 外部情報だけで断言せず、公式情報、一次情報、当社環境のいずれかで確認してから公開してください。';
  }
  if (type === '注意' || service === 'Admin') {
    return '[要編集] 管理者設定、ライセンス、リリース時期によって利用可否が異なる可能性があります。';
  }
  return '[要編集] 社外秘、個人情報、顧客情報は社内ルールに従って扱ってください。';
}

function buildReviewChecklist_(source) {
  return '';
}

function notifyNewCandidates_(items) {
  if (!items.length) return;

  const webhook = PropertiesService.getScriptProperties().getProperty(CONFIG.CHAT_WEBHOOK_PROPERTY);
  if (!webhook) return;

  const lines = items.slice(0, 5).map((item) => `・${item.sourceDate} ${item.service}: ${item.sourceTitle}`);
  const text = [
    `Workspace / Gemini Dispatch に新規候補が ${items.length} 件追加されました。`,
    ...lines,
    items.length > 5 ? `ほか ${items.length - 5} 件` : '',
    '投稿者画面で元記事確認と掲載文編集をしてください。',
  ].filter(Boolean).join('\n');

  UrlFetchApp.fetch(webhook, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ text }),
    muteHttpExceptions: true,
  });
}

function assertAdmin_() {
  const raw = PropertiesService.getScriptProperties().getProperty(CONFIG.ADMIN_EMAILS_PROPERTY) || CONFIG.DEFAULT_ADMIN_EMAILS;
  const admins = raw
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  if (!admins.length) {
    throw new Error('DISPATCH_ADMIN_EMAILS が未設定です。Script Properties に投稿担当者メールを追加してください。');
  }

  const email = Session.getActiveUser().getEmail().toLowerCase();
  if (!email || !admins.includes(email)) {
    throw new Error(`権限がありません: ${email || 'unknown user'}`);
  }
}
