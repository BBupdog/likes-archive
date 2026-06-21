const DB_NAME = 'likesArchive';
const DB_VERSION = 6;
let db;

let currentMainTab = 'general';
let currentGeneralView = 'all';
let currentBoard = null;
let currentBoardView = 'all';
let currentCols = 2;
let massSelectMode = false;
let selectedIds = new Set();
let contextTargetItem = null;
let longPressTimer = null;
let confirmCallback = null;
let boardMoveMode = false;
let boardDeleteMode = false;
let organizeMode = false;
let boardPickerCallback = null;
let selectedBoardIds = new Set();
let manualBoardSelected = null;

// Virtual scroll state
let vsAllItems = [];
let vsRenderedCount = 0;
const VS_BATCH = 30;
let vsObserver = null;
let vsGalleryId = 'gallery';
let vsContext = 'general';
let vsRendering = false;

// ==================== DATABASE ====================

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('likes')) db.createObjectStore('likes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('trash')) db.createObjectStore('trash', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('deleted')) db.createObjectStore('deleted', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('boards')) db.createObjectStore('boards', { keyPath: 'id' });
    };
    request.onsuccess = e => resolve(e.target.result);
    request.onerror = e => reject(e);
  });
}

function dbGet(store, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(id);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e);
  });
}

function dbPut(store, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(value);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e);
  });
}

function dbGetAll(store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e);
  });
}

function dbDelete(store, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).delete(id);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e);
  });
}

function dbClear(store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).clear();
    req.onsuccess = () => resolve();
    req.onerror = e => reject(e);
  });
}

// ==================== CSV PARSER ====================

function parseCSV(text) {
  const results = [];
  const rows = [];
  let current = '';
  let inQuotes = false;
  let row = [];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"') {
      if (inQuotes && next === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      row.push(current); current = '';
    } else if ((ch === '\n' || (ch === '\r' && next === '\n')) && !inQuotes) {
      if (ch === '\r') i++;
      row.push(current); current = '';
      rows.push(row); row = [];
    } else {
      current += ch;
    }
  }
  if (current || row.length) { row.push(current); rows.push(row); }

  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i];
    if (!cols || cols.length < 2) continue;
    const tweetType = cols[0]?.trim();
    const id = cols[1]?.trim();
    const date = cols[2]?.trim();
    const username = cols[3]?.trim();
    const displayName = cols[4]?.trim();
    const text = cols[5]?.trim();
    const mediaRaw = cols[16]?.trim();
    const videoUrl = cols[17]?.trim();
    const thumbnailUrl = cols[19]?.trim();
    const quotedId = cols[24]?.trim();
    if (!id) continue;
    const images = mediaRaw
      ? mediaRaw.split(';').map(u => u.trim()).filter(u => u.startsWith('http'))
      : [];
    results.push({ id, date, username, displayName, text, images, videoUrl, thumbnailUrl, tweetType, quotedId });
  }
  return results;
}

// ==================== MEDIA ====================

async function downloadAndStoreMedia(url, key, forceType) {
  try {
    const response = await fetch(url);
    if (!response.ok) return false;
    const blob = await response.blob();
    const type = forceType || blob.type;
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onloadend = () => {
        dbPut('images', { id: key, data: reader.result, type }).then(() => resolve(true));
      };
      reader.onerror = () => resolve(false);
      reader.readAsDataURL(blob);
    });
  } catch { return false; }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function renderMediaInContainer(mediaKeys, container) {
  if (!mediaKeys || mediaKeys.length === 0) return;
  for (const m of mediaKeys) {
    const record = await dbGet('images', m.key);
    if (!record) continue;
    const isVideo = m.mediaType === 'video' || (record.type && record.type.startsWith('video'));
    if (isVideo) {
      const video = document.createElement('video');
      video.src = record.data;
      video.controls = true;
      video.playsInline = true;
      video.style.cssText = 'width:100%;border-radius:10px;display:block;margin-bottom:8px;';
      container.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.src = record.data;
      img.style.cssText = 'width:100%;border-radius:10px;display:block;margin-bottom:8px;';
      container.appendChild(img);
    }
  }
}

// ==================== CARD COVER ====================

async function buildCardCover(item) {
  const mediaKeys = item.mediaKeys || [];
  const count = mediaKeys.length;

  if (count === 0) {
    // Text only card
    const div = document.createElement('div');
    div.className = 'card-text-only';
    if (item.text) {
      const p = document.createElement('div');
      p.className = 'card-text';
      p.textContent = item.text;
      div.appendChild(p);
    }
    if (item.displayName || item.username) {
      const a = document.createElement('div');
      a.className = 'card-author';
      a.textContent = item.displayName || item.username;
      div.appendChild(a);
    }
    return div;
  }

  if (count === 1) {
    const record = await dbGet('images', mediaKeys[0].key);
    if (!record) return null;
    const isVideo = mediaKeys[0].mediaType === 'video' || (record.type && record.type.startsWith('video'));
    if (isVideo) {
      const video = document.createElement('video');
      video.src = record.data;
      video.className = 'card-cover-video';
      video.muted = true;
      video.playsInline = true;
      video.loop = true;
      video.autoplay = true;
      return video;
    } else {
      const img = document.createElement('img');
      img.src = record.data;
      img.className = 'card-cover';
      img.loading = 'lazy';
      img.decoding = 'async';
      return img;
    }
  }

  // Multi image — Twitter layout
  const grid = document.createElement('div');
  grid.className = `card-multi count-${Math.min(count, 4)}`;

  const showCount = Math.min(count, 4);
  for (let i = 0; i < showCount; i++) {
    const record = await dbGet('images', mediaKeys[i].key);
    const cell = document.createElement('div');
    cell.className = 'multi-img';

    if (i === 3 && count > 4) {
      cell.classList.add('more-overlay');
      cell.setAttribute('data-more', `+${count - 3}`);
    }

    if (record) {
      const isVideo = mediaKeys[i].mediaType === 'video' || (record.type && record.type.startsWith('video'));
      if (isVideo) {
        const video = document.createElement('video');
        video.src = record.data;
        video.muted = true;
        video.playsInline = true;
        cell.appendChild(video);
      } else {
        const img = document.createElement('img');
        img.src = record.data;
        img.loading = 'lazy';
        cell.appendChild(img);
      }
    }
    grid.appendChild(cell);
  }
  return grid;
}

// ==================== PROGRESS ====================

function updateProgress(current, total, label) {
  const container = document.getElementById('progress-bar-container');
  const fill = document.getElementById('progress-bar-fill');
  const lbl = document.getElementById('progress-label');
  container.classList.add('visible');
  fill.style.width = Math.round((current / total) * 100) + '%';
  lbl.textContent = label;
}

function hideProgress() {
  document.getElementById('progress-bar-container').classList.remove('visible');
  document.getElementById('progress-bar-fill').style.width = '0%';
}

// ==================== IMPORT ====================

async function importFiles(files) {
  const deletedAll = await dbGetAll('deleted');
  const deletedIds = new Set(deletedAll.map(d => d.id));
  const trashAll = await dbGetAll('trash');
  const trashIds = new Set(trashAll.map(d => d.id));
  let imported = 0;
  let skippedDuplicate = 0;
  let skippedDeleted = 0;
  let skippedTrash = 0;
  let allEntries = [];

  for (const file of files) {
    const text = await file.text();
    if (file.name.endsWith('.csv')) {
      allEntries = allEntries.concat(parseCSV(text));
    } else {
      try {
        const cleaned = text
          .replace(/^window\.YTD\.like\.part\d+\s*=\s*/, '')
          .replace(/^window\.YTD\.bookmark\.part\d+\s*=\s*/, '')
          .trim();
        const json = JSON.parse(cleaned);
        allEntries = allEntries.concat(json.map(entry => {
          const item = entry.like || entry.bookmark;
          return {
            id: item.tweetId, text: item.fullText || '',
            username: '', displayName: '', date: '',
            images: [], videoUrl: '', thumbnailUrl: '',
            tweetType: 'original', quotedId: ''
          };
        }));
      } catch { alert(`Could not read ${file.name}. Skipping.`); }
    }
  }

  const total = allEntries.length;

  for (let idx = 0; idx < allEntries.length; idx++) {
    const entry = allEntries[idx];
    updateProgress(idx + 1, total, `Importing ${idx + 1} of ${total}...`);
    if (!entry.id) continue;
    if (deletedIds.has(entry.id)) { skippedDeleted++; continue; }
    if (trashIds.has(entry.id)) { skippedTrash++; continue; }
    const existing = await dbGet('likes', entry.id);
    if (existing) { skippedDuplicate++; continue; }

    const mediaKeys = [];
    for (let i = 0; i < entry.images.length; i++) {
      const key = `${entry.id}_img_${i}`;
      const ok = await downloadAndStoreMedia(entry.images[i], key, 'image/jpeg');
      if (ok) mediaKeys.push({ key, mediaType: 'image' });
    }
    if (entry.videoUrl) {
      const key = `${entry.id}_video`;
      const ok = await downloadAndStoreMedia(entry.videoUrl, key, 'video/mp4');
      if (ok) {
        mediaKeys.push({ key, mediaType: 'video' });
      } else if (entry.thumbnailUrl) {
        const thumbKey = `${entry.id}_thumb`;
        const thumbOk = await downloadAndStoreMedia(entry.thumbnailUrl, thumbKey, 'image/jpeg');
        if (thumbOk) mediaKeys.push({ key: thumbKey, mediaType: 'image' });
      }
    }

    const allLikes = await dbGetAll('likes');
    const maxPos = allLikes.length > 0 ? Math.max(...allLikes.map(l => l.position || 0)) : -1;

    await dbPut('likes', {
      id: entry.id,
      text: entry.text || '',
      username: entry.username || '',
      displayName: entry.displayName || '',
      date: entry.date || '',
      mediaKeys,
      tweetType: entry.tweetType || 'original',
      quotedId: entry.quotedId || '',
      board: null,
      position: maxPos + 1,
      favorites: [],
      trashedAt: null,
      previousBoard: null,
      isManual: false
    });
    imported++;
  }

  hideProgress();
  alert(`Done.\n${imported} imported\n${skippedDuplicate} duplicates\n${skippedDeleted} permanently deleted\n${skippedTrash} in trash`);
  refreshCurrentView();
}

// ==================== MANUAL IMPORT ====================

let manualFiles = [];

async function openManualAdd() {
  manualFiles = [];
  manualBoardSelected = null;
  document.getElementById('manual-author').value = '';
  document.getElementById('manual-text').value = '';
  document.getElementById('manual-board-label').textContent = 'No board selected';
  document.getElementById('manual-preview-grid').innerHTML = '';
  document.getElementById('manual-add-modal').classList.remove('hidden');
  document.getElementById('photo-picker').click();
}

async function handlePhotoPicker(files) {
  if (!files || files.length === 0) return;
  manualFiles = Array.from(files);

  const grid = document.getElementById('manual-preview-grid');
  grid.innerHTML = '';

  for (const file of manualFiles) {
    const data = await fileToBase64(file);
    const isVideo = file.type.startsWith('video');
    if (isVideo) {
      const video = document.createElement('video');
      video.src = data;
      video.muted = true;
      video.style.cssText = 'width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;';
      grid.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.src = data;
      grid.appendChild(img);
    }
  }

  document.getElementById('manual-add-modal').classList.remove('hidden');
}

async function saveManualEntry() {
  if (manualFiles.length === 0 &&
      !document.getElementById('manual-text').value.trim() &&
      !document.getElementById('manual-author').value.trim()) {
    alert('Please select at least one photo or add some text.');
    return;
  }

  const author = document.getElementById('manual-author').value.trim();
  const text = document.getElementById('manual-text').value.trim();
  const id = 'manual_' + Date.now();

  const mediaKeys = [];
  for (let i = 0; i < manualFiles.length; i++) {
    const file = manualFiles[i];
    const data = await fileToBase64(file);
    const key = `${id}_img_${i}`;
    const mediaType = file.type.startsWith('video') ? 'video' : 'image';
    await dbPut('images', { id: key, data, type: file.type });
    mediaKeys.push({ key, mediaType });
  }

  const allLikes = await dbGetAll('likes');
  const maxPos = allLikes.length > 0 ? Math.max(...allLikes.map(l => l.position || 0)) : -1;

  await dbPut('likes', {
    id,
    text,
    username: author,
    displayName: author,
    date: new Date().toISOString(),
    mediaKeys,
    tweetType: 'manual',
    quotedId: '',
    board: manualBoardSelected || null,
    position: maxPos + 1,
    favorites: [],
    trashedAt: null,
    previousBoard: null,
    isManual: true
  });

  document.getElementById('manual-add-modal').classList.add('hidden');
  manualFiles = [];
  manualBoardSelected = null;
  refreshCurrentView();
}

// ==================== FILTERING / SORTING ====================

function getSortFilter() {
  return {
    sort: document.getElementById('sort-select').value,
    filter: document.getElementById('filter-select').value,
    text: document.getElementById('search-text').value.toLowerCase(),
    author: document.getElementById('search-author').value.toLowerCase()
  };
}

function itemHasImage(item) {
  return item.mediaKeys && item.mediaKeys.some(m => m.mediaType === 'image');
}

function itemHasVideo(item) {
  return item.mediaKeys && item.mediaKeys.some(m => m.mediaType === 'video');
}

function itemHasMedia(item) {
  return item.mediaKeys && item.mediaKeys.length > 0;
}

function applyFilters(likes, { sort, filter, text, author }, allLikesMap) {
  let result = likes.filter(item => {
    if (text && !(item.text || '').toLowerCase().includes(text)) return false;
    if (author && !(item.username || '').toLowerCase().includes(author) &&
        !(item.displayName || '').toLowerCase().includes(author)) return false;
    if (filter === 'images') {
      if (itemHasImage(item)) return true;
      if (item.quotedId && allLikesMap) {
        const orig = allLikesMap.get(item.quotedId);
        if (orig && itemHasImage(orig)) return true;
      }
      return false;
    }
    if (filter === 'videos') {
      if (itemHasVideo(item)) return true;
      if (item.quotedId && allLikesMap) {
        const orig = allLikesMap.get(item.quotedId);
        if (orig && itemHasVideo(orig)) return true;
      }
      return false;
    }
    if (filter === 'text') {
      if (itemHasMedia(item)) return false;
      if (item.quotedId && allLikesMap) {
        const orig = allLikesMap.get(item.quotedId);
        if (orig && itemHasMedia(orig)) return false;
      }
      return true;
    }
    return true;
  });

  if (sort === 'newest') result.sort((a, b) => new Date(b.date) - new Date(a.date));
  else if (sort === 'oldest') result.sort((a, b) => new Date(a.date) - new Date(b.date));
  else if (sort === 'images') {
    result.sort((a, b) => (itemHasImage(b) ? 1 : 0) - (itemHasImage(a) ? 1 : 0));
  } else if (sort === 'videos') {
    result.sort((a, b) => (itemHasVideo(b) ? 1 : 0) - (itemHasVideo(a) ? 1 : 0));
  } else if (sort === 'text') {
    result = result.filter(item => {
      if (itemHasMedia(item)) return false;
      if (item.quotedId && allLikesMap) {
        const orig = allLikesMap.get(item.quotedId);
        if (orig && itemHasMedia(orig)) return false;
      }
      return true;
    });
  } else {
    result.sort((a, b) => (a.position || 0) - (b.position || 0));
  }

  return result;
}

function getContextItems(all, context) {
  if (context === 'general') return all.filter(i => !i.board);
  if (context === 'favorites-general') return all.filter(i => !i.board && i.favorites && i.favorites.includes('general'));
  if (context === 'board') return all.filter(i => i.board === currentBoard);
  if (context === 'favorites-board') return all.filter(i => i.board === currentBoard && i.favorites && i.favorites.includes(currentBoard));
  return all;
}

// ==================== VIRTUAL SCROLL ====================

function setupVirtualScroll(galleryId, sentinelId, items, context) {
  if (vsObserver) vsObserver.disconnect();
  vsAllItems = items;
  vsRenderedCount = 0;
  vsGalleryId = galleryId;
  vsContext = context;
  vsRendering = false;

  const gallery = document.getElementById(galleryId);
  gallery.innerHTML = '';
  gallery.style.gridTemplateColumns = `repeat(${currentCols}, 1fr)`;

  renderNextBatch();

  const sentinel = document.getElementById(sentinelId);
  vsObserver = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting && vsRenderedCount < vsAllItems.length) {
      renderNextBatch();
    }
  }, { rootMargin: '300px' });
  vsObserver.observe(sentinel);
}

async function renderNextBatch() {
  if (vsRendering) return;
  vsRendering = true;
  const gallery = document.getElementById(vsGalleryId);
  const end = Math.min(vsRenderedCount + VS_BATCH, vsAllItems.length);
  const start = vsRenderedCount;
  vsRenderedCount = end;
  for (let i = start; i < end; i++) {
    gallery.appendChild(await createCard(vsAllItems[i], vsContext));
  }
  vsRendering = false;
}

// ==================== POSITION HELPERS ====================

async function getOrderedContextItems(context) {
  const all = await dbGetAll('likes');
  return getContextItems(all, context).sort((a, b) => (a.position || 0) - (b.position || 0));
}

async function moveCardUp(id, context) {
  const items = await getOrderedContextItems(context);
  const idx = items.findIndex(i => i.id === id);
  if (idx <= 0) return;
  const above = items[idx - 1];
  const current = items[idx];
  [above.position, current.position] = [current.position, above.position];
  await dbPut('likes', above);
  await dbPut('likes', current);
  refreshCurrentView();
}

async function moveCardDown(id, context) {
  const items = await getOrderedContextItems(context);
  const idx = items.findIndex(i => i.id === id);
  if (idx < 0 || idx >= items.length - 1) return;
  const below = items[idx + 1];
  const current = items[idx];
  [below.position, current.position] = [current.position, below.position];
  await dbPut('likes', below);
  await dbPut('likes', current);
  refreshCurrentView();
}

async function moveCardToTop(id, context) {
  const items = await getOrderedContextItems(context);
  const idx = items.findIndex(i => i.id === id);
  if (idx <= 0) return;
  items[idx].position = (items[0].position || 0) - 1;
  await dbPut('likes', items[idx]);
  refreshCurrentView();
}

async function moveCardToBottom(id, context) {
  const items = await getOrderedContextItems(context);
  const idx = items.findIndex(i => i.id === id);
  if (idx < 0 || idx >= items.length - 1) return;
  items[idx].position = (items[items.length - 1].position || 0) + 1;
  await dbPut('likes', items[idx]);
  refreshCurrentView();
}

// ==================== CARDS ====================

async function createCard(item, context = 'general') {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = item.id;

  const checkmark = document.createElement('div');
  checkmark.className = 'card-checkmark';
  checkmark.textContent = '✓';
  card.appendChild(checkmark);

  const favBadge = document.createElement('div');
  favBadge.className = 'card-favorite-badge';
  favBadge.textContent = '★';
  card.appendChild(favBadge);

  if (organizeMode) {
    const arrows = document.createElement('div');
    arrows.className = 'organize-arrows';
    const btns = [
      { text: '⇈', fn: () => moveCardToTop(item.id, context) },
      { text: '↑', fn: () => moveCardUp(item.id, context) },
      { text: '↓', fn: () => moveCardDown(item.id, context) },
      { text: '⇊', fn: () => moveCardToBottom(item.id, context) }
    ];
    for (const b of btns) {
      const btn = document.createElement('button');
      btn.className = 'arrow-btn';
      btn.textContent = b.text;
      btn.addEventListener('click', async e => { e.stopPropagation(); await b.fn(); });
      arrows.appendChild(btn);
    }
    card.appendChild(arrows);
  }

  if (item.tweetType === 'quote') {
    const qi = document.createElement('div');
    qi.className = 'card-quote-indicator';
    qi.textContent = 'Quote';
    card.appendChild(qi);
  }

  if ((item.mediaKeys || []).length > 1) {
    const mi = document.createElement('div');
    mi.className = 'card-multi-indicator';
    mi.textContent = `1/${item.mediaKeys.length}`;
    card.appendChild(mi);
  }

  const cover = await buildCardCover(item);
  if (cover) card.appendChild(cover);

  // For quote tweets show original image below if self has no media
  if (item.tweetType === 'quote' && item.quotedId && (!item.mediaKeys || item.mediaKeys.length === 0)) {
    const original = await dbGet('likes', item.quotedId);
    if (original) {
      const origCover = await buildCardCover(original);
      if (origCover) card.appendChild(origCover);
    }
  }

  const favScope = context === 'general' || context === 'favorites-general' ? 'general' : currentBoard;
  if (item.favorites && item.favorites.includes(favScope)) card.classList.add('favorited');
  if (selectedIds.has(item.id)) card.classList.add('selected');

  card.addEventListener('contextmenu', e => e.preventDefault());

  let pointerMoved = false;
  card.addEventListener('pointerdown', () => {
    pointerMoved = false;
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      if (!pointerMoved) showContextMenu(item, card, context);
    }, 500);
  });

  card.addEventListener('pointermove', () => {
    pointerMoved = true;
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  });

  card.addEventListener('pointerup', () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
      if (!pointerMoved) {
        if (massSelectMode) toggleCardSelection(item.id, card);
        else if (!organizeMode) openLightbox(item);
      }
    }
  });

  card.addEventListener('pointercancel', () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  });

  return card;
}

// ==================== GALLERY RENDER ====================

async function renderGallery(context = 'general') {
  const sf = getSortFilter();
  const all = await dbGetAll('likes');
  const allMap = new Map(all.map(i => [i.id, i]));
  let items = getContextItems(all, context);
  items = applyFilters(items, sf, allMap);
  updateCounter(items.length, 'likes');
  setupVirtualScroll('gallery', 'gallery-sentinel', items, context);
}

async function renderBoardGallery(boardId, context = 'board') {
  const sf = getSortFilter();
  const all = await dbGetAll('likes');
  const allMap = new Map(all.map(i => [i.id, i]));
  let items = getContextItems(all, context);
  items = applyFilters(items, sf, allMap);
  updateCounter(items.length, 'likes');
  setupVirtualScroll('board-gallery', 'board-gallery-sentinel', items, context);
}

// ==================== BOARDS ====================

async function renderBoards() {
  const boardsList = document.getElementById('boards-list');
  boardsList.innerHTML = '';
  const boards = await dbGetAll('boards');
  const likes = await dbGetAll('likes');
  const topLevel = boards.filter(b => !b.parentId).sort((a, b) => (a.position || 0) - (b.position || 0));

  if (topLevel.length === 0) {
    boardsList.innerHTML = '<p style="padding:20px;color:#666;grid-column:1/-1;">No boards yet. Tap + to create one.</p>';
    return;
  }

  for (const board of topLevel) {
    const count = likes.filter(l => l.board === board.id).length;
    const subBoards = boards.filter(b => b.parentId === board.id);
    const card = document.createElement('div');
    card.className = 'board-card';
    card.dataset.id = board.id;

    if (board.coverTweetId) {
      const coverTweet = await dbGet('likes', board.coverTweetId);
      if (coverTweet && coverTweet.mediaKeys && coverTweet.mediaKeys.length > 0) {
        const coverRecord = await dbGet('images', coverTweet.mediaKeys[0].key);
        if (coverRecord) {
          const coverImg = document.createElement('img');
          coverImg.className = 'board-card-cover';
          coverImg.src = coverRecord.data;
          card.appendChild(coverImg);
        }
      }
    }

    const check = document.createElement('div');
    check.className = 'board-card-check';
    check.textContent = '✓';
    card.appendChild(check);

    const actions = document.createElement('div');
    actions.className = 'board-card-actions';
    const upBtn = document.createElement('button');
    upBtn.className = 'board-arrow-btn';
    upBtn.textContent = '↑';
    upBtn.addEventListener('click', async e => { e.stopPropagation(); await moveBoardUp(board.id); });
    const downBtn = document.createElement('button');
    downBtn.className = 'board-arrow-btn';
    downBtn.textContent = '↓';
    downBtn.addEventListener('click', async e => { e.stopPropagation(); await moveBoardDown(board.id); });
    actions.appendChild(upBtn);
    actions.appendChild(downBtn);
    card.appendChild(actions);

    const info = document.createElement('div');
    info.className = 'board-card-info';
    const name = document.createElement('div');
    name.className = 'board-card-name';
    name.textContent = board.name;
    const meta = document.createElement('div');
    meta.className = 'board-card-meta';
    const subCount = subBoards.length > 0 ? ` · ${subBoards.length} sub` : '';
    meta.textContent = `${count} likes${subCount}`;
    info.appendChild(name);
    info.appendChild(meta);
    card.appendChild(info);

    card.addEventListener('contextmenu', e => e.preventDefault());
    card.addEventListener('click', () => {
      if (boardDeleteMode) toggleBoardSelection(board.id, card);
      else if (!boardMoveMode) openBoard(board.id, board.name);
    });

    let boardLongTimer = null;
    card.addEventListener('pointerdown', () => {
      boardLongTimer = setTimeout(() => { boardLongTimer = null; showBoardContextMenu(board, card); }, 500);
    });
    card.addEventListener('pointerup', () => { if (boardLongTimer) { clearTimeout(boardLongTimer); boardLongTimer = null; } });
    card.addEventListener('pointercancel', () => { if (boardLongTimer) { clearTimeout(boardLongTimer); boardLongTimer = null; } });
    card.addEventListener('pointermove', () => { if (boardLongTimer) { clearTimeout(boardLongTimer); boardLongTimer = null; } });

    if (selectedBoardIds.has(board.id)) card.classList.add('board-selected');
    boardsList.appendChild(card);
  }

  if (boardMoveMode) boardsList.classList.add('board-move-mode');
  else boardsList.classList.remove('board-move-mode');
  if (boardDeleteMode) boardsList.classList.add('board-delete-mode');
  else boardsList.classList.remove('board-delete-mode');
}

async function openBoard(boardId, boardName) {
  currentBoard = boardId;
  currentBoardView = 'all';
  document.getElementById('boards-list').classList.add('hidden');
  document.getElementById('board-contents').classList.remove('hidden');
  document.getElementById('board-title-label').textContent = boardName;
  document.getElementById('boards-bottom-bar').classList.add('hidden');
  document.getElementById('board-bottom-bar').classList.remove('hidden');
  await renderBoardViewTabs(boardId);
  renderBoardGallery(boardId, 'board');
}

async function renderBoardViewTabs(boardId) {
  const tabsContainer = document.getElementById('board-view-tabs');
  tabsContainer.innerHTML = '';
  const boards = await dbGetAll('boards');
  const subBoards = boards.filter(b => b.parentId === boardId).sort((a, b) => (a.position || 0) - (b.position || 0));

  const allTab = document.createElement('button');
  allTab.className = 'view-tab active';
  allTab.textContent = 'All';
  allTab.addEventListener('click', () => {
    currentBoard = boardId;
    currentBoardView = 'all';
    document.querySelectorAll('#board-view-tabs .view-tab').forEach(t => t.classList.remove('active'));
    allTab.classList.add('active');
    renderBoardGallery(boardId, 'board');
  });
  tabsContainer.appendChild(allTab);

  const favTab = document.createElement('button');
  favTab.className = 'view-tab';
  favTab.textContent = 'Favorites';
  favTab.addEventListener('click', () => {
    currentBoard = boardId;
    currentBoardView = 'favorites';
    document.querySelectorAll('#board-view-tabs .view-tab').forEach(t => t.classList.remove('active'));
    favTab.classList.add('active');
    renderBoardGallery(boardId, 'favorites-board');
  });
  tabsContainer.appendChild(favTab);

  for (const sub of subBoards) {
    const subTab = document.createElement('button');
    subTab.className = 'view-tab';
    subTab.textContent = sub.name;
    subTab.addEventListener('click', () => {
      currentBoard = sub.id;
      currentBoardView = 'sub-' + sub.id;
      document.querySelectorAll('#board-view-tabs .view-tab').forEach(t => t.classList.remove('active'));
      subTab.classList.add('active');
      document.getElementById('board-title-label').textContent = sub.name;
      renderBoardGallery(sub.id, 'board');
    });
    tabsContainer.appendChild(subTab);
  }
}

async function moveBoardUp(boardId) {
  const boards = await dbGetAll('boards');
  const topLevel = boards.filter(b => !b.parentId).sort((a, b) => (a.position || 0) - (b.position || 0));
  const idx = topLevel.findIndex(b => b.id === boardId);
  if (idx <= 0) return;
  [topLevel[idx - 1].position, topLevel[idx].position] = [topLevel[idx].position, topLevel[idx - 1].position];
  await dbPut('boards', topLevel[idx - 1]);
  await dbPut('boards', topLevel[idx]);
  renderBoards();
}

async function moveBoardDown(boardId) {
  const boards = await dbGetAll('boards');
  const topLevel = boards.filter(b => !b.parentId).sort((a, b) => (a.position || 0) - (b.position || 0));
  const idx = topLevel.findIndex(b => b.id === boardId);
  if (idx < 0 || idx >= topLevel.length - 1) return;
  [topLevel[idx + 1].position, topLevel[idx].position] = [topLevel[idx].position, topLevel[idx + 1].position];
  await dbPut('boards', topLevel[idx + 1]);
  await dbPut('boards', topLevel[idx]);
  renderBoards();
}

function toggleBoardSelection(boardId, card) {
  if (selectedBoardIds.has(boardId)) { selectedBoardIds.delete(boardId); card.classList.remove('board-selected'); }
  else { selectedBoardIds.add(boardId); card.classList.add('board-selected'); }
}

async function deleteSelectedBoards() {
  if (selectedBoardIds.size === 0) { alert('No boards selected.'); return; }
  if (!confirm(`Delete ${selectedBoardIds.size} board(s)? Likes will be moved to General.`)) return;
  for (const boardId of selectedBoardIds) {
    const all = await dbGetAll('likes');
    for (const like of all) {
      if (like.board === boardId) { like.board = null; await dbPut('likes', like); }
    }
    const subBoards = (await dbGetAll('boards')).filter(b => b.parentId === boardId);
    for (const sub of subBoards) {
      const subLikes = (await dbGetAll('likes')).filter(l => l.board === sub.id);
      for (const like of subLikes) { like.board = null; await dbPut('likes', like); }
      await dbDelete('boards', sub.id);
    }
    await dbDelete('boards', boardId);
  }
  selectedBoardIds.clear();
  boardDeleteMode = false;
  document.getElementById('boards-delete-btn').classList.remove('active-mode');
  renderBoards();
}

// ==================== BOARD CONTEXT MENU ====================

let boardContextTarget = null;

function showBoardContextMenu(board, card) {
  boardContextTarget = board;
  document.getElementById('board-ctx-menu')?.remove();
  document.getElementById('board-ctx-overlay')?.remove();

  const menu = document.createElement('div');
  menu.id = 'board-ctx-menu';
  const rect = card.getBoundingClientRect();
  menu.style.cssText = `position:fixed;z-index:400;background:#1a1a1a;border:1px solid #333;border-radius:12px;overflow:hidden;min-width:160px;top:${rect.top + 40}px;left:${rect.left + 10}px;`;

  const options = [
    { label: 'Rename', action: () => showRenameModal(board) },
    { label: 'Add sub-board', action: () => createSubBoard(board.id) },
    { label: 'Delete', action: () => deleteSingleBoard(board.id), danger: true }
  ];

  for (const opt of options) {
    const btn = document.createElement('button');
    btn.textContent = opt.label;
    btn.style.cssText = `display:block;width:100%;padding:12px 16px;background:transparent;border:none;border-bottom:1px solid #2a2a2a;color:${opt.danger ? '#ff4444' : '#f0f0f0'};font-size:14px;text-align:left;cursor:pointer;`;
    btn.addEventListener('click', () => { removeBoardCtxMenu(); opt.action(); });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  const overlay = document.createElement('div');
  overlay.id = 'board-ctx-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:399;';
  overlay.addEventListener('click', removeBoardCtxMenu);
  document.body.appendChild(overlay);
}

function removeBoardCtxMenu() {
  document.getElementById('board-ctx-menu')?.remove();
  document.getElementById('board-ctx-overlay')?.remove();
  boardContextTarget = null;
}

async function deleteSingleBoard(boardId) {
  const board = await dbGet('boards', boardId);
  if (!board) return;
  if (!confirm(`Delete "${board.name}"? Likes will be moved to General.`)) return;
  const all = await dbGetAll('likes');
  for (const like of all) {
    if (like.board === boardId) { like.board = null; await dbPut('likes', like); }
  }
  const subBoards = (await dbGetAll('boards')).filter(b => b.parentId === boardId);
  for (const sub of subBoards) {
    const subLikes = (await dbGetAll('likes')).filter(l => l.board === sub.id);
    for (const like of subLikes) { like.board = null; await dbPut('likes', like); }
    await dbDelete('boards', sub.id);
  }
  await dbDelete('boards', boardId);
  renderBoards();
}

function showRenameModal(board) {
  document.getElementById('rename-input').value = board.name;
  document.getElementById('rename-modal').classList.remove('hidden');
  document.getElementById('rename-ok').onclick = async () => {
    const newName = document.getElementById('rename-input').value.trim();
    if (!newName) return;
    board.name = newName;
    await dbPut('boards', board);
    document.getElementById('rename-modal').classList.add('hidden');
    renderBoards();
  };
}

async function createSubBoard(parentId) {
  const name = prompt('Sub-board name:');
  if (!name || !name.trim()) return;
  const boards = await dbGetAll('boards');
  const maxPos = boards.length > 0 ? Math.max(...boards.map(b => b.position || 0)) : -1;
  await dbPut('boards', {
    id: 'board_' + Date.now(),
    name: name.trim(),
    parentId,
    coverTweetId: null,
    position: maxPos + 1,
    createdAt: Date.now()
  });
  const parentBoard = await dbGet('boards', parentId);
  if (parentBoard) await openBoard(parentId, parentBoard.name);
}

// ==================== CONTEXT MENU ====================

function showContextMenu(item, card, context) {
  hideContextMenu();
  contextTargetItem = item;
  const menu = document.getElementById('context-menu');
  const overlay = document.getElementById('context-overlay');

  const favScope = context === 'general' || context === 'favorites-general' ? 'general' : currentBoard;
  const isFavorited = item.favorites && item.favorites.includes(favScope);
  document.getElementById('ctx-favorite').textContent = isFavorited ? 'Unfavorite ★' : 'Favorite ★';
  document.getElementById('ctx-set-cover').style.display = !!item.board ? 'block' : 'none';

  const rect = card.getBoundingClientRect();
  let top = rect.top + window.scrollY + rect.height / 2;
  let left = rect.left + 10;
  if (left + 180 > window.innerWidth) left = window.innerWidth - 190;
  if (top + 250 > window.innerHeight + window.scrollY) top = rect.top + window.scrollY - 260;

  menu.style.top = top + 'px';
  menu.style.left = left + 'px';
  menu.dataset.context = context;
  menu.classList.remove('hidden');
  overlay.classList.remove('hidden');
}

function hideContextMenu() {
  document.getElementById('context-menu').classList.add('hidden');
  document.getElementById('context-overlay').classList.add('hidden');
  contextTargetItem = null;
}

// ==================== FAVORITES ====================

async function toggleFavorite(item, context) {
  const like = await dbGet('likes', item.id);
  if (!like) return;
  if (!like.favorites) like.favorites = [];
  const scope = context === 'general' || context === 'favorites-general' ? 'general' : currentBoard;
  const idx = like.favorites.indexOf(scope);
  if (idx > -1) like.favorites.splice(idx, 1);
  else like.favorites.push(scope);
  await dbPut('likes', like);
  refreshCurrentView();
}

// ==================== EDIT ====================

async function openEditModal(ids) {
  const modal = document.createElement('div');
  modal.id = 'edit-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;';

  const overlay = document.createElement('div');
  overlay.id = 'edit-overlay';
  overlay.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.85);';
  overlay.addEventListener('click', () => modal.remove());

  const content = document.createElement('div');
  content.style.cssText = 'position:relative;z-index:301;background:#1a1a1a;border-radius:16px;width:88vw;max-width:400px;padding:20px;display:flex;flex-direction:column;gap:12px;';

  const title = document.createElement('h2');
  title.textContent = ids.size === 1 ? 'Edit tweet' : `Edit ${ids.size} tweets`;
  title.style.fontSize = '16px';

  const authorInput = document.createElement('input');
  authorInput.type = 'text';
  authorInput.placeholder = 'Author (leave blank to keep existing)';
  authorInput.style.cssText = 'padding:10px 12px;border-radius:10px;border:1px solid #333;background:#2a2a2a;color:#f0f0f0;font-size:14px;width:100%;';

  const textInput = document.createElement('textarea');
  textInput.placeholder = 'Text (leave blank to keep existing)';
  textInput.rows = 3;
  textInput.style.cssText = 'padding:10px 12px;border-radius:10px;border:1px solid #333;background:#2a2a2a;color:#f0f0f0;font-size:14px;width:100%;font-family:Arial,sans-serif;resize:none;';

  if (ids.size === 1) {
    const like = await dbGet('likes', [...ids][0]);
    if (like) {
      authorInput.value = like.displayName || like.username || '';
      textInput.value = like.text || '';
    }
  }

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:10px;';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = 'flex:1;padding:10px;border-radius:10px;border:1px solid #444;background:transparent;color:#aaa;font-size:14px;cursor:pointer;';
  cancelBtn.addEventListener('click', () => modal.remove());

  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save';
  saveBtn.style.cssText = 'flex:1;padding:10px;border-radius:10px;border:none;background:#1d9bf0;color:white;font-size:14px;cursor:pointer;';
  saveBtn.addEventListener('click', async () => {
    const newAuthor = authorInput.value.trim();
    const newText = textInput.value.trim();
    for (const id of ids) {
      const like = await dbGet('likes', id);
      if (!like) continue;
      if (newAuthor) { like.displayName = newAuthor; like.username = newAuthor; }
      if (newText) like.text = newText;
      await dbPut('likes', like);
    }
    modal.remove();
    exitMassSelectMode();
    refreshCurrentView();
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  content.appendChild(title);
  content.appendChild(authorInput);
  content.appendChild(textInput);
  content.appendChild(actions);
  modal.appendChild(overlay);
  modal.appendChild(content);
  document.body.appendChild(modal);
}

// ==================== COMPILE ====================

async function compileSelected(ids) {
  if (ids.size < 2) { alert('Select at least 2 cards to compile.'); return; }
  const idArray = [...ids];
  const likes = [];
  for (const id of idArray) {
    const like = await dbGet('likes', id);
    if (like) likes.push(like);
  }

  const combinedMediaKeys = [];
  for (const like of likes) {
    if (like.mediaKeys) combinedMediaKeys.push(...like.mediaKeys);
  }

  const firstLike = likes[0];
  const compiledId = 'compiled_' + Date.now();
  const allLikesData = await dbGetAll('likes');
  const maxPos = allLikesData.length > 0 ? Math.max(...allLikesData.map(l => l.position || 0)) : -1;

  await dbPut('likes', {
    id: compiledId,
    text: firstLike.text || '',
    username: firstLike.username || '',
    displayName: firstLike.displayName || '',
    date: firstLike.date || new Date().toISOString(),
    mediaKeys: combinedMediaKeys,
    tweetType: 'compiled',
    quotedId: '',
    board: firstLike.board || null,
    position: maxPos + 1,
    favorites: [],
    trashedAt: null,
    previousBoard: null,
    isManual: true
  });

  for (const id of idArray) {
    await moveToTrash(id, null);
  }

  exitMassSelectMode();
  refreshCurrentView();
  alert(`Compiled ${ids.size} cards into one post.`);
}

// ==================== TRASH ====================

async function moveToTrash(id, previousBoard = null) {
  const like = await dbGet('likes', id);
  if (!like) return;
  like.trashedAt = Date.now();
  like.previousBoard = previousBoard !== null ? previousBoard : like.board;
  like.board = null;
  await dbPut('trash', like);
  await dbDelete('likes', id);
  closeLightbox();
  renderTrashCount();
}

async function restoreFromTrash(id) {
  const item = await dbGet('trash', id);
  if (!item) return;
  item.trashedAt = null;
  const prevBoard = item.previousBoard;
  item.previousBoard = null;
  item.board = null;
  if (prevBoard) {
    const board = await dbGet('boards', prevBoard);
    if (board) item.board = prevBoard;
  }
  await dbPut('likes', item);
  await dbDelete('trash', id);
  renderTrash();
  renderTrashCount();
}

async function permanentlyDelete(id) {
  const item = await dbGet('trash', id);
  if (item && item.mediaKeys) {
    for (const m of item.mediaKeys) await dbDelete('images', m.key);
  }
  await dbDelete('trash', id);
  await dbPut('deleted', { id });
  renderTrash();
  renderTrashCount();
}

async function emptyTrash() {
  const all = await dbGetAll('trash');
  for (const item of all) {
    if (item.mediaKeys) {
      for (const m of item.mediaKeys) await dbDelete('images', m.key);
    }
    await dbPut('deleted', { id: item.id });
  }
  await dbClear('trash');
  renderTrash();
  renderTrashCount();
}

async function autoCleanTrash() {
  const all = await dbGetAll('trash');
  const now = Date.now();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  for (const item of all) {
    if (item.trashedAt && (now - item.trashedAt) > thirtyDays) await permanentlyDelete(item.id);
  }
}

async function renderTrash() {
  const list = document.getElementById('trash-list');
  list.innerHTML = '';
  const all = await dbGetAll('trash');

  if (all.length === 0) {
    list.innerHTML = '<p style="padding:20px;color:#666;">Trash is empty.</p>';
    document.getElementById('trash-count-label').textContent = '0 items';
    return;
  }

  document.getElementById('trash-count-label').textContent = `${all.length} item${all.length > 1 ? 's' : ''}`;

  for (const item of all) {
    const el = document.createElement('div');
    el.className = 'trash-item';

    if (item.mediaKeys && item.mediaKeys.length > 0) {
      const record = await dbGet('images', item.mediaKeys[0].key);
      if (record) {
        const isVideo = item.mediaKeys[0].mediaType === 'video';
        if (isVideo) {
          const video = document.createElement('video');
          video.src = record.data;
          video.className = 'trash-item-thumb';
          video.muted = true;
          el.appendChild(video);
        } else {
          const thumb = document.createElement('img');
          thumb.className = 'trash-item-thumb';
          thumb.src = record.data;
          el.appendChild(thumb);
        }
      }
    }

    const info = document.createElement('div');
    info.className = 'trash-item-info';
    const text = document.createElement('div');
    text.className = 'trash-item-text';
    text.textContent = item.text || '(no text)';
    const meta = document.createElement('div');
    meta.className = 'trash-item-meta';
    const daysLeft = item.trashedAt
      ? Math.max(0, 30 - Math.floor((Date.now() - item.trashedAt) / (24 * 60 * 60 * 1000)))
      : 30;
    meta.textContent = `Deleted ${item.trashedAt ? new Date(item.trashedAt).toLocaleDateString() : 'unknown'} · ${daysLeft} days left`;
    info.appendChild(text);
    info.appendChild(meta);
    el.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'trash-item-actions';
    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'trash-restore-btn';
    restoreBtn.textContent = 'Restore';
    restoreBtn.addEventListener('click', () => restoreFromTrash(item.id));
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'trash-delete-btn';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => permanentlyDelete(item.id));
    actions.appendChild(restoreBtn);
    actions.appendChild(deleteBtn);
    el.appendChild(actions);
    list.appendChild(el);
  }
}

async function renderTrashCount() {
  const all = await dbGetAll('trash');
  const trashTab = document.querySelector('.main-tab[data-tab="trash"]');
  if (trashTab) trashTab.textContent = all.length > 0 ? `Trash (${all.length})` : 'Trash';
}

// ==================== LIGHTBOX ====================

async function openLightbox(item) {
  const quoteLabel = document.getElementById('lightbox-quote-label');
  const author = document.getElementById('lightbox-author');
  const text = document.getElementById('lightbox-text');
  const link = document.getElementById('lightbox-link');
  const embedContainer = document.getElementById('lightbox-embed');
  const originalSection = document.getElementById('lightbox-original');
  const originalEmbed = document.getElementById('lightbox-original-embed');

  quoteLabel.classList.toggle('hidden', item.tweetType !== 'quote');
  author.textContent = item.displayName ? `${item.displayName} @${item.username}` : (item.username || '');
  text.textContent = item.text || '';
  link.href = item.isManual ? '#' : `https://twitter.com/i/web/status/${item.id}`;
  if (item.isManual) link.style.display = 'none';
  else link.style.display = '';

  embedContainer.innerHTML = '';
  originalSection.classList.add('hidden');
  originalEmbed.innerHTML = '';

  await renderMediaInContainer(item.mediaKeys, embedContainer);

  if (item.tweetType === 'quote' && item.quotedId) {
    const original = await dbGet('likes', item.quotedId);
    if (original) {
      originalSection.classList.remove('hidden');
      if (original.text) {
        const origText = document.createElement('div');
        origText.style.cssText = 'font-size:14px;color:#ccc;line-height:1.5;margin-bottom:8px;';
        origText.textContent = original.text;
        originalEmbed.appendChild(origText);
      }
      await renderMediaInContainer(original.mediaKeys, originalEmbed);
    }
  }

  document.getElementById('lightbox').classList.remove('hidden');
  document.getElementById('lightbox').dataset.itemId = item.id;
}

function closeLightbox() {
  document.getElementById('lightbox').classList.add('hidden');
  document.getElementById('lightbox-embed').innerHTML = '';
  document.getElementById('lightbox-original-embed').innerHTML = '';
}

// ==================== DOWNLOAD ====================

async function downloadMedia(item) {
  if (!item.mediaKeys || item.mediaKeys.length === 0) { alert('No media to download.'); return; }
  for (const m of item.mediaKeys) {
    const record = await dbGet('images', m.key);
    if (!record) continue;
    const a = document.createElement('a');
    a.href = record.data;
    a.download = `likes_archive_${item.id}.${m.mediaType === 'video' ? 'mp4' : 'jpg'}`;
    a.click();
  }
}

async function downloadAllMedia() {
  const btn = document.getElementById('download-all-media-btn');
  const images = await dbGetAll('images');

  if (images.length === 0) {
    alert('No images or videos stored in the app.');
    return;
  }

  btn.textContent = 'Starting...';
  btn.disabled = true;

  let count = 0;
  for (const record of images) {
    try {
      const a = document.createElement('a');
      a.href = record.data;
      const ext = record.type ? record.type.split('/')[1] : 'jpg';
      a.download = `${record.id}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      count++;
      btn.textContent = `${count}/${images.length}`;
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.error('Failed to download', record.id, e);
    }
  }

  btn.textContent = 'Download';
  btn.disabled = false;
  alert(`Done. ${count} files downloaded.`);
}

// ==================== EXPORT APP FILES ====================

async function exportAppFiles() {
  const files = ['index.html', 'style.css', 'script.js', 'manifest.json', 'sw.js'];
  const base = window.location.href.replace(/[^/]*$/, '');
  alert('Downloading app files one by one.');
  for (const file of files) {
    try {
      const response = await fetch(base + file);
      if (!response.ok) throw new Error('not found');
      const blob = await response.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = file;
      a.click();
      await new Promise(r => setTimeout(r, 800));
    } catch {
      alert(`Could not download ${file}. Download manually from GitHub.`);
    }
  }
  alert('Done.');
}

// ==================== EXPORT / IMPORT LIBRARY ====================

async function exportLibrary() {
  const btn = document.getElementById('export-data-btn');
  btn.textContent = 'Exporting...';
  btn.disabled = true;
  try {
    const likes   = await dbGetAll('likes');
    const trash   = await dbGetAll('trash');
    const deleted = await dbGetAll('deleted');
    const images  = await dbGetAll('images');
    const boards  = await dbGetAll('boards');

    const payload = JSON.stringify({ likes, trash, deleted, images, boards });
    const blob = new Blob([payload], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const date = new Date().toISOString().slice(0, 10);
    a.download = `likes-archive-${date}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    alert('Export failed: ' + e.message);
  } finally {
    btn.textContent = 'Export';
    btn.disabled = false;
  }
}

async function importLibrary(file) {
  if (!file) return;
  const btn = document.getElementById('import-data-btn');
  btn.textContent = 'Importing...';
  btn.disabled = true;
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    const { likes, trash, deleted, images, boards } = payload;

    if (!likes || !Array.isArray(likes)) throw new Error('Invalid export file.');

    updateProgress(0, 1, 'Clearing existing data...');

    await dbClear('likes');
    await dbClear('trash');
    await dbClear('deleted');
    await dbClear('images');
    await dbClear('boards');

    const stores = [
      { name: 'likes',   data: likes   || [] },
      { name: 'trash',   data: trash   || [] },
      { name: 'deleted', data: deleted || [] },
      { name: 'images',  data: images  || [] },
      { name: 'boards',  data: boards  || [] }
    ];

    let done = 0;
    const total = stores.reduce((s, st) => s + st.data.length, 0) || 1;

    for (const store of stores) {
      for (const record of store.data) {
        await dbPut(store.name, record);
        done++;
        if (done % 20 === 0) updateProgress(done, total, `Restoring... ${done}/${total}`);
      }
    }

    hideProgress();
    document.getElementById('settings-panel').classList.add('hidden');
    refreshCurrentView();
    alert(`Import complete. ${likes.length} likes, ${boards?.length || 0} boards restored.`);
  } catch (e) {
    hideProgress();
    alert('Import failed: ' + e.message);
  } finally {
    btn.textContent = 'Import';
    btn.disabled = false;
    document.getElementById('data-import-input').value = '';
  }
}

// ==================== MASS SELECT ====================

function toggleCardSelection(id, card) {
  if (selectedIds.has(id)) { selectedIds.delete(id); card.classList.remove('selected'); }
  else { selectedIds.add(id); card.classList.add('selected'); }
  document.getElementById('mass-count').textContent = selectedIds.size + ' selected';
}

function enterMassSelectMode(item) {
  massSelectMode = true;
  selectedIds.clear();
  document.getElementById('top-bar').classList.add('hidden');
  document.getElementById('mass-select-bar').classList.remove('hidden');
  document.getElementById('mass-count').textContent = '0 selected';
  if (item) {
    const card = document.querySelector(`.card[data-id="${item.id}"]`);
    if (card) toggleCardSelection(item.id, card);
  }
  hideContextMenu();
}

function exitMassSelectMode() {
  massSelectMode = false;
  selectedIds.clear();
  document.querySelectorAll('.card.selected').forEach(c => c.classList.remove('selected'));
  document.getElementById('top-bar').classList.remove('hidden');
  document.getElementById('mass-select-bar').classList.add('hidden');
  document.getElementById('board-select-btn')?.classList.remove('active-mode');
  document.getElementById('general-select-btn')?.classList.remove('active-mode');
}

async function massDelete() {
  if (selectedIds.size === 0) { alert('No tweets selected.'); return; }
  const count = selectedIds.size;
  const ids = new Set(selectedIds);
  showConfirm(
    'Delete selected tweets',
    `Move ${count} tweet${count > 1 ? 's' : ''} to trash?`,
    'DELETE', 'Type DELETE to confirm',
    async () => {
      for (const id of ids) {
        const like = await dbGet('likes', id);
        if (like) await moveToTrash(id, like.board);
      }
      exitMassSelectMode();
      refreshCurrentView();
    }
  );
}

// ==================== MOVE TWEET ====================

async function moveTweetToBoard(itemId, boardId) {
  const like = await dbGet('likes', itemId);
  if (!like) return;
  const oldBoard = like.board;
  like.board = boardId;
  if (like.favorites && oldBoard) {
    const idx = like.favorites.indexOf(oldBoard);
    if (idx > -1) {
      like.favorites.splice(idx, 1);
      if (!like.favorites.includes(boardId)) like.favorites.push(boardId);
    }
  }
  await dbPut('likes', like);
}

// ==================== BOARD PICKER ====================

async function openBoardPicker(callback) {
  boardPickerCallback = callback;
  const picker = document.getElementById('board-picker');
  const list = document.getElementById('board-picker-list');
  list.innerHTML = '';
  const boards = await dbGetAll('boards');
  const topLevel = boards.filter(b => !b.parentId).sort((a, b) => (a.position || 0) - (b.position || 0));

  if (topLevel.length === 0) {
    list.innerHTML = '<p style="color:#666;font-size:13px;">No boards yet. Create one below.</p>';
  } else {
    for (const board of topLevel) {
      const subBoards = boards.filter(b => b.parentId === board.id);
      const itemWrap = document.createElement('div');
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:4px;';

      const btn = document.createElement('button');
      btn.className = 'board-picker-item';
      btn.style.flex = '1';
      btn.textContent = board.name;
      btn.addEventListener('click', () => {
        document.getElementById('board-picker').classList.add('hidden');
        if (boardPickerCallback) boardPickerCallback(board.id);
      });
      row.appendChild(btn);

      if (subBoards.length > 0) {
        const expandBtn = document.createElement('button');
        expandBtn.className = 'board-picker-expand';
        expandBtn.textContent = '+';
        const subsContainer = document.createElement('div');
        subsContainer.className = 'board-picker-subs';

        for (const sub of subBoards) {
          const subBtn = document.createElement('button');
          subBtn.className = 'board-picker-sub-item';
          subBtn.textContent = sub.name;
          subBtn.addEventListener('click', () => {
            document.getElementById('board-picker').classList.add('hidden');
            if (boardPickerCallback) boardPickerCallback(sub.id);
          });
          subsContainer.appendChild(subBtn);
        }

        expandBtn.addEventListener('click', () => {
          const expanded = subsContainer.classList.toggle('expanded');
          expandBtn.textContent = expanded ? '−' : '+';
        });

        row.appendChild(expandBtn);
        itemWrap.appendChild(row);
        itemWrap.appendChild(subsContainer);
      } else {
        itemWrap.appendChild(row);
      }
      list.appendChild(itemWrap);
    }
  }
  picker.classList.remove('hidden');
}

async function createBoardFromPicker() {
  const input = document.getElementById('new-board-name');
  const name = input.value.trim();
  if (!name) return;
  input.value = '';
  const boards = await dbGetAll('boards');
  const maxPos = boards.length > 0 ? Math.max(...boards.map(b => b.position || 0)) : -1;
  const newBoard = {
    id: 'board_' + Date.now(), name,
    parentId: null, coverTweetId: null,
    position: maxPos + 1, createdAt: Date.now()
  };
  await dbPut('boards', newBoard);
  document.getElementById('board-picker').classList.add('hidden');
  if (boardPickerCallback) boardPickerCallback(newBoard.id);
}

// ==================== CONFIRM MODAL ====================

function showConfirm(title, desc, keyword, label, callback) {
  confirmCallback = callback;
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-desc').textContent = desc;
  document.getElementById('confirm-type-label').textContent = label;
  document.getElementById('confirm-input').value = '';
  document.getElementById('confirm-input').placeholder = keyword;
  document.getElementById('confirm-modal').dataset.keyword = keyword;
  document.getElementById('confirm-modal').classList.remove('hidden');
}

function hideConfirm() {
  document.getElementById('confirm-modal').classList.add('hidden');
  document.getElementById('confirm-input').value = '';
  confirmCallback = null;
}

function updateCounter(count, unit) {
  document.getElementById('like-counter').textContent = `${count} ${unit}`;
}

function refreshCurrentView() {
  if (currentMainTab === 'general') {
    if (currentGeneralView === 'all') renderGallery('general');
    else renderGallery('favorites-general');
  } else if (currentMainTab === 'boards') {
    if (currentBoard) {
      if (currentBoardView === 'favorites') renderBoardGallery(currentBoard, 'favorites-board');
      else renderBoardGallery(currentBoard, 'board');
    } else renderBoards();
  } else if (currentMainTab === 'trash') {
    renderTrash();
  }
}

// ==================== MAIN TABS ====================

document.querySelectorAll('.main-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const tabName = tab.dataset.tab;
    currentMainTab = tabName;
    currentBoard = null;
    organizeMode = false;
    boardMoveMode = false;
    boardDeleteMode = false;

    document.querySelectorAll('.main-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');

    document.getElementById('general-view').classList.toggle('hidden', tabName !== 'general');
    document.getElementById('boards-view').classList.toggle('hidden', tabName !== 'boards');
    document.getElementById('trash-view').classList.toggle('hidden', tabName !== 'trash');
    document.getElementById('general-bottom-bar').classList.toggle('hidden', tabName !== 'general');
    document.getElementById('boards-bottom-bar').classList.toggle('hidden', tabName !== 'boards');
    document.getElementById('board-bottom-bar').classList.add('hidden');
    document.getElementById('search-row').classList.toggle('hidden', tabName === 'trash');
    document.getElementById('sort-filter-row').classList.toggle('hidden', tabName === 'trash');

    if (tabName === 'boards') {
      document.getElementById('boards-list').classList.remove('hidden');
      document.getElementById('board-contents').classList.add('hidden');
      renderBoards();
    } else if (tabName === 'trash') {
      renderTrash();
    } else {
      renderGallery('general');
    }
  });
});

document.querySelectorAll('#general-tabs .view-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#general-tabs .view-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentGeneralView = tab.dataset.view;
    if (currentGeneralView === 'all') renderGallery('general');
    else renderGallery('favorites-general');
  });
});

document.getElementById('back-to-boards').addEventListener('click', () => {
  currentBoard = null;
  organizeMode = false;
  document.getElementById('board-contents').classList.add('hidden');
  document.getElementById('boards-list').classList.remove('hidden');
  document.getElementById('board-bottom-bar').classList.add('hidden');
  document.getElementById('boards-bottom-bar').classList.remove('hidden');
  document.getElementById('board-organize-btn').classList.remove('active-mode');
  renderBoards();
});

// ==================== GENERAL BOTTOM BAR ====================

document.getElementById('general-select-btn').addEventListener('click', () => {
  if (massSelectMode) exitMassSelectMode();
  else enterMassSelectMode(null);
  document.getElementById('general-select-btn').classList.toggle('active-mode', massSelectMode);
});

document.getElementById('general-organize-btn').addEventListener('click', () => {
  organizeMode = !organizeMode;
  document.getElementById('general-organize-btn').classList.toggle('active-mode', organizeMode);
  refreshCurrentView();
});

// ==================== BOARDS BOTTOM BAR ====================

document.getElementById('boards-add-btn').addEventListener('click', async () => {
  const name = prompt('Board name:');
  if (!name || !name.trim()) return;
  const boards = await dbGetAll('boards');
  const maxPos = boards.length > 0 ? Math.max(...boards.map(b => b.position || 0)) : -1;
  await dbPut('boards', {
    id: 'board_' + Date.now(), name: name.trim(),
    parentId: null, coverTweetId: null,
    position: maxPos + 1, createdAt: Date.now()
  });
  renderBoards();
});

document.getElementById('boards-move-btn').addEventListener('click', () => {
  boardMoveMode = !boardMoveMode;
  if (boardMoveMode) boardDeleteMode = false;
  document.getElementById('boards-move-btn').classList.toggle('active-mode', boardMoveMode);
  document.getElementById('boards-delete-btn').classList.remove('active-mode');
  selectedBoardIds.clear();
  renderBoards();
});

document.getElementById('boards-delete-btn').addEventListener('click', () => {
  if (boardDeleteMode && selectedBoardIds.size > 0) {
    deleteSelectedBoards();
  } else {
    boardDeleteMode = !boardDeleteMode;
    if (boardDeleteMode) boardMoveMode = false;
    document.getElementById('boards-delete-btn').classList.toggle('active-mode', boardDeleteMode);
    document.getElementById('boards-move-btn').classList.remove('active-mode');
    selectedBoardIds.clear();
    renderBoards();
  }
});

// ==================== BOARD BOTTOM BAR ====================

document.getElementById('board-select-btn').addEventListener('click', () => {
  if (massSelectMode) exitMassSelectMode();
  else enterMassSelectMode(null);
  document.getElementById('board-select-btn').classList.toggle('active-mode', massSelectMode);
});

document.getElementById('board-organize-btn').addEventListener('click', () => {
  organizeMode = !organizeMode;
  document.getElementById('board-organize-btn').classList.toggle('active-mode', organizeMode);
  refreshCurrentView();
});

document.getElementById('board-add-sub-btn').addEventListener('click', () => {
  if (currentBoard) createSubBoard(currentBoard);
});

// ==================== CONTEXT MENU ACTIONS ====================

document.getElementById('ctx-set-cover').addEventListener('click', async () => {
  if (!contextTargetItem || !currentBoard) return;
  const board = await dbGet('boards', currentBoard);
  if (board) { board.coverTweetId = contextTargetItem.id; await dbPut('boards', board); }
  hideContextMenu();
  alert('Cover image set.');
});

document.getElementById('ctx-favorite').addEventListener('click', async () => {
  if (!contextTargetItem) return;
  const context = document.getElementById('context-menu').dataset.context;
  await toggleFavorite(contextTargetItem, context);
  hideContextMenu();
});

document.getElementById('ctx-move').addEventListener('click', () => {
  const item = contextTargetItem;
  hideContextMenu();
  openBoardPicker(async boardId => {
    await moveTweetToBoard(item.id, boardId);
    refreshCurrentView();
  });
});

document.getElementById('ctx-download').addEventListener('click', async () => {
  if (!contextTargetItem) return;
  await downloadMedia(contextTargetItem);
  hideContextMenu();
});

document.getElementById('ctx-delete').addEventListener('click', async () => {
  if (!contextTargetItem) return;
  const item = contextTargetItem;
  hideContextMenu();
  await moveToTrash(item.id, item.board);
  refreshCurrentView();
});

document.getElementById('context-overlay').addEventListener('click', hideContextMenu);

// ==================== LIGHTBOX ACTIONS ====================

document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
document.getElementById('lightbox-overlay').addEventListener('click', closeLightbox);

document.getElementById('lightbox-delete').addEventListener('click', async () => {
  const itemId = document.getElementById('lightbox').dataset.itemId;
  if (!itemId) return;
  const like = await dbGet('likes', itemId);
  if (like) await moveToTrash(itemId, like.board);
  closeLightbox();
  refreshCurrentView();
});

document.getElementById('lightbox-board-btn').addEventListener('click', async () => {
  const itemId = document.getElementById('lightbox').dataset.itemId;
  if (!itemId) return;
  closeLightbox();
  openBoardPicker(async boardId => {
    await moveTweetToBoard(itemId, boardId);
    refreshCurrentView();
  });
});

// ==================== MASS SELECT BAR ====================

document.getElementById('mass-cancel-btn').addEventListener('click', exitMassSelectMode);
document.getElementById('mass-delete-btn').addEventListener('click', massDelete);

document.getElementById('mass-board-btn').addEventListener('click', () => {
  openBoardPicker(async boardId => {
    for (const id of selectedIds) await moveTweetToBoard(id, boardId);
    exitMassSelectMode();
    refreshCurrentView();
  });
});

document.getElementById('mass-edit-btn').addEventListener('click', () => {
  if (selectedIds.size === 0) { alert('No tweets selected.'); return; }
  openEditModal(new Set(selectedIds));
});

document.getElementById('mass-compile-btn').addEventListener('click', () => {
  if (selectedIds.size < 2) { alert('Select at least 2 cards to compile.'); return; }
  compileSelected(new Set(selectedIds));
});

// ==================== BOARD PICKER ====================

document.getElementById('board-picker-overlay').addEventListener('click', () => {
  document.getElementById('board-picker').classList.add('hidden');
});
document.getElementById('board-picker-cancel').addEventListener('click', () => {
  document.getElementById('board-picker').classList.add('hidden');
});
document.getElementById('new-board-btn').addEventListener('click', createBoardFromPicker);

// ==================== RENAME MODAL ====================

document.getElementById('rename-cancel').addEventListener('click', () => {
  document.getElementById('rename-modal').classList.add('hidden');
});
document.getElementById('rename-overlay').addEventListener('click', () => {
  document.getElementById('rename-modal').classList.add('hidden');
});

// ==================== MANUAL ADD ====================

document.getElementById('add-manual-btn').addEventListener('click', openManualAdd);

document.getElementById('photo-picker').addEventListener('change', e => {
  if (e.target.files && e.target.files.length > 0) {
    handlePhotoPicker(e.target.files);
  }
});

document.getElementById('manual-add-close').addEventListener('click', () => {
  document.getElementById('manual-add-modal').classList.add('hidden');
  manualFiles = [];
});

document.getElementById('manual-add-overlay').addEventListener('click', () => {
  document.getElementById('manual-add-modal').classList.add('hidden');
  manualFiles = [];
});

document.getElementById('manual-board-pick-btn').addEventListener('click', () => {
  openBoardPicker(async boardId => {
    manualBoardSelected = boardId;
    const board = await dbGet('boards', boardId);
    document.getElementById('manual-board-label').textContent = board ? board.name : boardId;
  });
});

document.getElementById('manual-cancel-btn').addEventListener('click', () => {
  document.getElementById('manual-add-modal').classList.add('hidden');
  manualFiles = [];
});

document.getElementById('manual-save-btn').addEventListener('click', saveManualEntry);

// ==================== COLUMN SWITCHER ====================

document.querySelectorAll('.col-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentCols = parseInt(btn.dataset.cols);
    document.querySelectorAll('.col-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('gallery').style.gridTemplateColumns = `repeat(${currentCols}, 1fr)`;
    document.getElementById('board-gallery').style.gridTemplateColumns = `repeat(${currentCols}, 1fr)`;
  });
});

// ==================== SEARCH & SORT ====================

document.getElementById('search-text').addEventListener('input', refreshCurrentView);
document.getElementById('search-author').addEventListener('input', refreshCurrentView);
document.getElementById('sort-select').addEventListener('change', refreshCurrentView);
document.getElementById('filter-select').addEventListener('change', refreshCurrentView);

// ==================== IMPORT ====================

document.getElementById('file-input').addEventListener('change', e => {
  const files = Array.from(e.target.files);
  if (files.length > 0) importFiles(files);
});

// ==================== SETTINGS ====================

document.getElementById('settings-btn').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.remove('hidden');
});
document.getElementById('settings-close').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.add('hidden');
});
document.getElementById('settings-overlay').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.add('hidden');
});
document.getElementById('export-app-btn').addEventListener('click', exportAppFiles);
document.getElementById('download-all-media-btn').addEventListener('click', downloadAllMedia);
document.getElementById('export-data-btn').addEventListener('click', exportLibrary);

document.getElementById('import-data-btn').addEventListener('click', () => {
  document.getElementById('data-import-input').click();
});

document.getElementById('data-import-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  showConfirm(
    'Import library',
    'This will overwrite everything on this device with the contents of the export file. This cannot be undone.',
    'IMPORT',
    'Type IMPORT to confirm',
    () => importLibrary(file)
  );
});

document.getElementById('wipe-log-btn').addEventListener('click', () => {
  showConfirm('Wipe delete log', 'Clears permanently deleted tweet IDs.', 'WIPE', 'Type WIPE to confirm',
    async () => { await dbClear('deleted'); alert('Delete log wiped.'); });
});

document.getElementById('clear-likes-btn').addEventListener('click', () => {
  showConfirm('Clear all likes', 'Deletes your entire library and trash. Delete log kept.', 'DELETE', 'Type DELETE to confirm',
    async () => {
      await dbClear('likes'); await dbClear('images'); await dbClear('boards'); await dbClear('trash');
      refreshCurrentView(); alert('Library cleared.');
    });
});

document.getElementById('full-reset-btn').addEventListener('click', () => {
  showConfirm('Full reset', 'Wipes everything. App returns to factory state.', 'RESET', 'Type RESET to confirm',
    async () => {
      await dbClear('likes'); await dbClear('images'); await dbClear('boards');
      await dbClear('trash'); await dbClear('deleted');
      refreshCurrentView(); alert('Full reset complete.');
    });
});

// ==================== CONFIRM MODAL ====================

document.getElementById('confirm-cancel').addEventListener('click', hideConfirm);
document.getElementById('confirm-ok').addEventListener('click', async () => {
  const keyword = document.getElementById('confirm-modal').dataset.keyword;
  const input = document.getElementById('confirm-input').value.trim();
  if (input !== keyword) { alert(`You must type ${keyword} exactly.`); return; }
  const cb = confirmCallback;
  hideConfirm();
  if (cb) { try { await cb(); } catch(e) { alert('Error: ' + e.message); } }
});

document.getElementById('empty-trash-btn').addEventListener('click', () => {
  showConfirm('Empty trash', 'Permanently deletes all items in trash.', 'EMPTY', 'Type EMPTY to confirm', emptyTrash);
});

// ==================== INIT ====================

openDB().then(async database => {
  db = database;
  await autoCleanTrash();
  await renderTrashCount();
  renderGallery('general');
  closeLightbox();
  document.getElementById('board-picker').classList.add('hidden');
  document.getElementById('settings-panel').classList.add('hidden');
  document.getElementById('confirm-modal').classList.add('hidden');
  document.getElementById('context-menu').classList.add('hidden');
  document.getElementById('context-overlay').classList.add('hidden');
  document.getElementById('mass-select-bar').classList.add('hidden');
  document.getElementById('board-bottom-bar').classList.add('hidden');
  document.getElementById('rename-modal').classList.add('hidden');
  document.getElementById('manual-add-modal').classList.add('hidden');
  document.getElementById('boards-view').classList.add('hidden');
  document.getElementById('trash-view').classList.add('hidden');
  document.getElementById('board-contents').classList.add('hidden');
  document.getElementById('general-bottom-bar').classList.remove('hidden');
});

