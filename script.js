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
  const gallery = document.getElementById(vsGalleryId);
  const end = Math.min(vsRenderedCount + VS_BATCH, vsAllItems.length);
  for (let i = vsRenderedCount; i < end; i++) {
    gallery.appendChild(await createCard(vsAllItems[i], vsContext));
  }
  vsRenderedCount = end;
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
      renderBoardGallery(sub.id, 'board');
    });
    tabsContainer.appendChild(subTab);
  }
}

async function createBoard(name, parentId = null) {
  const boards = await dbGetAll('boards');
  const maxPos = boards.length > 0 ? Math.max(...boards.map(b => b.position || 0)) : -1;
  const id = 'board_' + Date.now();
  await dbPut('boards', { id, name, parentId, position: maxPos + 1, coverTweetId: null });
  return id;
}

async function createBoardFromPicker() {
  const input = document.getElementById('new-board-name');
  const name = input.value.trim();
  if (!name) return;
  const id = await createBoard(name);
  input.value = '';
  if (boardPickerCallback) {
    document.getElementById('board-picker').classList.add('hidden');
    await boardPickerCallback(id);
    boardPickerCallback = null;
  } else {
    renderBoards();
    renderBoardPickerList();
  }
}

async function moveBoardUp(boardId) {
  const boards = await dbGetAll('boards');
  const topLevel = boards.filter(b => !b.parentId).sort((a, b) => (a.position || 0) - (b.position || 0));
  const idx = topLevel.findIndex(b => b.id === boardId);
  if (idx <= 0) return;
  [topLevel[idx].position, topLevel[idx - 1].position] = [topLevel[idx - 1].position, topLevel[idx].position];
  await dbPut('boards', topLevel[idx]);
  await dbPut('boards', topLevel[idx - 1]);
  renderBoards();
}

async function moveBoardDown(boardId) {
  const boards = await dbGetAll('boards');
  const topLevel = boards.filter(b => !b.parentId).sort((a, b) => (a.position || 0) - (b.position || 0));
  const idx = topLevel.findIndex(b => b.id === boardId);
  if (idx < 0 || idx >= topLevel.length - 1) return;
  [topLevel[idx].position, topLevel[idx + 1].position] = [topLevel[idx + 1].position, topLevel[idx].position];
  await dbPut('boards', topLevel[idx]);
  await dbPut('boards', topLevel[idx + 1]);
  renderBoards();
}

async function deleteBoard(boardId) {
  const boards = await dbGetAll('boards');
  const subBoards = boards.filter(b => b.parentId === boardId);
  for (const sub of subBoards) await deleteBoard(sub.id);
  const likes = await dbGetAll('likes');
  for (const like of likes) {
    if (like.board === boardId) {
      like.board = null;
      like.previousBoard = null;
      await dbPut('likes', like);
    }
  }
  await dbDelete('boards', boardId);
}

// ==================== BOARD PICKER ====================

async function openBoardPicker(callback) {
  boardPickerCallback = callback;
  document.getElementById('board-picker').classList.remove('hidden');
  await renderBoardPickerList();
}

async function renderBoardPickerList() {
  const list = document.getElementById('board-picker-list');
  list.innerHTML = '';
  const boards = await dbGetAll('boards');
  const topLevel = boards.filter(b => !b.parentId).sort((a, b) => (a.position || 0) - (b.position || 0));

  for (const board of topLevel) {
    const subs = boards.filter(b => b.parentId === board.id).sort((a, b) => (a.position || 0) - (b.position || 0));
    const wrapper = document.createElement('div');

    const item = document.createElement('button');
    item.className = 'board-picker-item';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = board.name;
    item.appendChild(nameSpan);

    if (subs.length > 0) {
      const expandBtn = document.createElement('button');
      expandBtn.className = 'board-picker-expand';
      expandBtn.textContent = '▶';
      expandBtn.addEventListener('click', e => {
        e.stopPropagation();
        subsDiv.classList.toggle('expanded');
        expandBtn.textContent = subsDiv.classList.contains('expanded') ? '▼' : '▶';
      });
      item.appendChild(expandBtn);
    }

    item.addEventListener('click', async () => {
      if (boardPickerCallback) {
        document.getElementById('board-picker').classList.add('hidden');
        await boardPickerCallback(board.id);
        boardPickerCallback = null;
      }
    });
    wrapper.appendChild(item);

    if (subs.length > 0) {
      const subsDiv = document.createElement('div');
      subsDiv.className = 'board-picker-subs';
      for (const sub of subs) {
        const subItem = document.createElement('button');
        subItem.className = 'board-picker-sub-item';
        subItem.textContent = sub.name;
        subItem.addEventListener('click', async () => {
          if (boardPickerCallback) {
            document.getElementById('board-picker').classList.add('hidden');
            await boardPickerCallback(sub.id);
            boardPickerCallback = null;
          }
        });
        subsDiv.appendChild(subItem);
      }
      wrapper.appendChild(subsDiv);
    }

    list.appendChild(wrapper);
  }
}

// ==================== MOVE TO BOARD ====================

async function moveTweetToBoard(tweetId, boardId) {
  const item = await dbGet('likes', tweetId);
  if (!item) return;
  item.previousBoard = item.board;
  item.board = boardId;
  await dbPut('likes', item);
}

// ==================== TRASH ====================

async function moveToTrash(id, board) {
  const item = await dbGet('likes', id);
  if (!item) return;
  item.trashedAt = Date.now();
  item.previousBoard = board || null;
  await dbPut('trash', item);
  await dbDelete('likes', id);
}

async function restoreFromTrash(id) {
  const item = await dbGet('trash', id);
  if (!item) return;
  item.board = item.previousBoard || null;
  item.trashedAt = null;
  await dbPut('likes', item);
  await dbDelete('trash', id);
}

async function permanentlyDelete(id) {
  const item = await dbGet('trash', id);
  if (item && item.mediaKeys) {
    for (const m of item.mediaKeys) await dbDelete('images', m.key);
  }
  await dbDelete('trash', id);
  await dbPut('deleted', { id });
}

async function emptyTrash() {
  const items = await dbGetAll('trash');
  for (const item of items) {
    if (item.mediaKeys) {
      for (const m of item.mediaKeys) await dbDelete('images', m.key);
    }
    await dbDelete('trash', item.id);
    await dbPut('deleted', { id: item.id });
  }
  renderTrashList();
  renderTrashCount();
}

async function autoCleanTrash() {
  const items = await dbGetAll('trash');
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const item of items) {
    if (item.trashedAt && item.trashedAt < cutoff) await permanentlyDelete(item.id);
  }
}

async function renderTrashList() {
  const list = document.getElementById('trash-list');
  list.innerHTML = '';
  const items = await dbGetAll('trash');
  items.sort((a, b) => (b.trashedAt || 0) - (a.trashedAt || 0));

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'trash-item';

    const thumb = document.createElement('div');
    thumb.className = 'trash-thumb';
    if (item.mediaKeys && item.mediaKeys.length > 0) {
      const record = await dbGet('images', item.mediaKeys[0].key);
      if (record) {
        const isVideo = item.mediaKeys[0].mediaType === 'video' || (record.type && record.type.startsWith('video'));
        if (isVideo) {
          const v = document.createElement('video');
          v.src = record.data;
          v.muted = true;
          thumb.appendChild(v);
        } else {
          const img = document.createElement('img');
          img.src = record.data;
          thumb.appendChild(img);
        }
      }
    } else {
      thumb.style.cssText = 'display:flex;align-items:center;justify-content:center;font-size:11px;color:#555;';
      thumb.textContent = 'T';
    }

    const info = document.createElement('div');
    info.className = 'trash-info';
    const author = document.createElement('div');
    author.className = 'trash-author';
    author.textContent = item.displayName || item.username || 'Unknown';
    const txt = document.createElement('div');
    txt.className = 'trash-text';
    txt.textContent = item.text || '(no text)';
    const date = document.createElement('div');
    date.className = 'trash-date';
    const daysLeft = item.trashedAt
      ? Math.max(0, 30 - Math.floor((Date.now() - item.trashedAt) / (1000 * 60 * 60 * 24)))
      : 30;
    date.textContent = `Deleted ${daysLeft}d left`;
    info.appendChild(author);
    info.appendChild(txt);
    info.appendChild(date);

    const actions = document.createElement('div');
    actions.className = 'trash-actions';
    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'trash-restore-btn';
    restoreBtn.textContent = 'Restore';
    restoreBtn.addEventListener('click', async () => {
      await restoreFromTrash(item.id);
      renderTrashList();
      renderTrashCount();
    });
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'trash-delete-btn';
    deleteBtn.textContent = '🗑';
    deleteBtn.addEventListener('click', async () => {
      await permanentlyDelete(item.id);
      renderTrashList();
      renderTrashCount();
    });
    actions.appendChild(restoreBtn);
    actions.appendChild(deleteBtn);

    row.appendChild(thumb);
    row.appendChild(info);
    row.appendChild(actions);
    list.appendChild(row);
  }
}

async function renderTrashCount() {
  const items = await dbGetAll('trash');
  document.getElementById('trash-count-label').textContent = `${items.length} items`;
}

// ==================== COUNTER ====================

function updateCounter(count, type) {
  document.getElementById('like-counter').textContent = `${count} ${type}`;
}

// ==================== LIGHTBOX ====================

async function openLightbox(item) {
  const lb = document.getElementById('lightbox');
  lb.dataset.itemId = item.id;
  lb.classList.remove('hidden');

  document.getElementById('lightbox-quote-label').classList.add('hidden');
  document.getElementById('lightbox-original').classList.add('hidden');

  const authorEl = document.getElementById('lightbox-author');
  authorEl.textContent = item.displayName
    ? `${item.displayName} @${item.username}`
    : (item.username ? `@${item.username}` : '');

  document.getElementById('lightbox-text').textContent = item.text || '';

  const embedEl = document.getElementById('lightbox-embed');
  embedEl.innerHTML = '';
  await renderMediaInContainer(item.mediaKeys, embedEl);

  if (item.tweetType === 'quote') {
    document.getElementById('lightbox-quote-label').classList.remove('hidden');
    if (item.quotedId) {
      const original = await dbGet('likes', item.quotedId);
      if (original) {
        document.getElementById('lightbox-original').classList.remove('hidden');
        const origEmbed = document.getElementById('lightbox-original-embed');
        origEmbed.innerHTML = '';
        const origAuthor = document.createElement('div');
        origAuthor.style.cssText = 'font-size:13px;color:#aaa;margin-bottom:6px;';
        origAuthor.textContent = original.displayName
          ? `${original.displayName} @${original.username}`
          : (original.username ? `@${original.username}` : '');
        origEmbed.appendChild(origAuthor);
        const origText = document.createElement('div');
        origText.style.cssText = 'font-size:13px;color:#ddd;margin-bottom:8px;';
        origText.textContent = original.text || '';
        origEmbed.appendChild(origText);
        await renderMediaInContainer(original.mediaKeys, origEmbed);
      }
    }
  }

  const link = document.getElementById('lightbox-link');
  link.href = `https://twitter.com/i/web/status/${item.id}`;

  const favBtn = document.getElementById('lightbox-fav-btn');
  if (favBtn) {
    const favScope = currentMainTab === 'general' ? 'general' : currentBoard;
    const isFav = item.favorites && item.favorites.includes(favScope);
    favBtn.textContent = isFav ? '★ Unfavorite' : '☆ Favorite';
  }
}

function closeLightbox() {
  document.getElementById('lightbox').classList.add('hidden');
  document.getElementById('lightbox').dataset.itemId = '';
  document.getElementById('lightbox-embed').innerHTML = '';
  document.getElementById('lightbox-original-embed').innerHTML = '';
}

// ==================== CONTEXT MENU ====================

function showContextMenu(item, card, context) {
  contextTargetItem = item;
  const menu = document.getElementById('context-menu');
  const overlay = document.getElementById('context-overlay');

  const favScope = context === 'general' || context === 'favorites-general' ? 'general' : currentBoard;
  const isFav = item.favorites && item.favorites.includes(favScope);
  document.getElementById('ctx-favorite').textContent = isFav ? 'Unfavorite' : 'Favorite';

  const isInBoard = !!item.board;
  document.getElementById('ctx-set-cover').style.display = isInBoard ? '' : 'none';

  menu.classList.remove('hidden');
  overlay.classList.remove('hidden');
}

function hideContextMenu() {
  document.getElementById('context-menu').classList.add('hidden');
  document.getElementById('context-overlay').classList.add('hidden');
  contextTargetItem = null;
}

// ==================== BOARD CONTEXT MENU ====================

let boardContextTarget = null;

function showBoardContextMenu(board, card) {
  boardContextTarget = board;
  const menu = document.getElementById('board-context-menu');
  if (!menu) return;
  menu.classList.remove('hidden');
  document.getElementById('board-context-overlay').classList.remove('hidden');
}

// ==================== FAVORITE ====================

async function toggleFavorite(itemId, scope) {
  const item = await dbGet('likes', itemId);
  if (!item) return;
  item.favorites = item.favorites || [];
  const idx = item.favorites.indexOf(scope);
  if (idx >= 0) item.favorites.splice(idx, 1);
  else item.favorites.push(scope);
  await dbPut('likes', item);
  return item;
}

// ==================== ORGANIZE MODE ====================

function enterOrganizeMode() {
  organizeMode = true;
  refreshCurrentView();
}

function exitOrganizeMode() {
  organizeMode = false;
  refreshCurrentView();
}

// ==================== MASS SELECT ====================

function enterMassSelectMode() {
  massSelectMode = true;
  selectedIds.clear();
  document.getElementById('mass-select-bar').classList.remove('hidden');
  document.getElementById('general-bottom-bar').classList.add('hidden');
  document.getElementById('board-bottom-bar').classList.add('hidden');
}

function exitMassSelectMode() {
  massSelectMode = false;
  selectedIds.clear();
  document.getElementById('mass-select-bar').classList.add('hidden');
  if (currentMainTab === 'general') document.getElementById('general-bottom-bar').classList.remove('hidden');
  if (currentMainTab === 'boards' && currentBoard) document.getElementById('board-bottom-bar').classList.remove('hidden');
  refreshCurrentView();
}

function toggleCardSelection(id, card) {
  if (selectedIds.has(id)) {
    selectedIds.delete(id);
    card.classList.remove('selected');
  } else {
    selectedIds.add(id);
    card.classList.add('selected');
  }
  document.getElementById('mass-count').textContent = `${selectedIds.size} selected`;
}

async function massDelete() {
  if (selectedIds.size === 0) return;
  const ids = Array.from(selectedIds);
  for (const id of ids) {
    const item = await dbGet('likes', id);
    if (item) await moveToTrash(id, item.board);
  }
  exitMassSelectMode();
  refreshCurrentView();
}

// ==================== COMPILE ====================

async function compileSelected(ids) {
  if (ids.size < 2) return;
  const items = [];
  for (const id of ids) {
    const item = await dbGet('likes', id);
    if (item) items.push(item);
  }
  if (items.length < 2) return;

  const primary = items[0];
  const combinedMediaKeys = [];
  for (const item of items) {
    for (const mk of (item.mediaKeys || [])) combinedMediaKeys.push(mk);
  }

  primary.mediaKeys = combinedMediaKeys;
  await dbPut('likes', primary);

  for (let i = 1; i < items.length; i++) {
    await moveToTrash(items[i].id, items[i].board);
  }

  exitMassSelectMode();
  refreshCurrentView();
}

// ==================== EDIT MODAL ====================

let editTargetIds = null;

async function openEditModal(ids) {
  editTargetIds = ids;
  const modal = document.getElementById('edit-modal');
  if (!modal) return;

  if (ids.size === 1) {
    const id = Array.from(ids)[0];
    const item = await dbGet('likes', id);
    document.getElementById('edit-author').value = item.displayName || item.username || '';
    document.getElementById('edit-text').value = item.text || '';
  } else {
    document.getElementById('edit-author').value = '';
    document.getElementById('edit-text').value = '';
  }
  modal.classList.remove('hidden');
}

async function saveEdit() {
  if (!editTargetIds) return;
  const author = document.getElementById('edit-author').value.trim();
  const text = document.getElementById('edit-text').value.trim();

  for (const id of editTargetIds) {
    const item = await dbGet('likes', id);
    if (!item) continue;
    if (author) { item.displayName = author; item.username = author; }
    if (text) item.text = text;
    await dbPut('likes', item);
  }

  document.getElementById('edit-modal').classList.add('hidden');
  editTargetIds = null;
  exitMassSelectMode();
  refreshCurrentView();
}

// ==================== DOWNLOAD ====================

async function downloadMedia(item) {
  if (!item.mediaKeys || item.mediaKeys.length === 0) return;
  for (const mk of item.mediaKeys) {
    const record = await dbGet('images', mk.key);
    if (!record) continue;
    const a = document.createElement('a');
    a.href = record.data;
    const ext = record.type ? record.type.split('/')[1] : 'jpg';
    a.download = `${item.id}_${mk.key}.${ext}`;
    a.click();
  }
}

// ==================== DOWNLOAD ALL MEDIA ====================

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
      // Small delay so the browser doesn't block the downloads
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
  for (const filename of files) {
    try {
      const response = await fetch(filename);
      if (!response.ok) continue;
      const text = await response.text();
      const blob = new Blob([text], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
      await new Promise(r => setTimeout(r, 300));
    } catch (e) { console.error('Export failed for', filename, e); }
  }
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

// ==================== REFRESH ====================

function refreshCurrentView() {
  if (currentMainTab === 'general') {
    if (currentGeneralView === 'favorites') renderGallery('favorites-general');
    else renderGallery('general');
  } else if (currentMainTab === 'boards') {
    if (currentBoard) {
      if (currentBoardView === 'favorites') renderBoardGallery(currentBoard, 'favorites-board');
      else if (currentBoardView.startsWith('sub-')) renderBoardGallery(currentBoard, 'board');
      else renderBoardGallery(currentBoard, 'board');
    } else {
      renderBoards();
    }
  } else if (currentMainTab === 'trash') {
    renderTrashList();
    renderTrashCount();
  }
}

// ==================== CONFIRM MODAL ====================

function showConfirm(title, desc, keyword, label, callback) {
  confirmCallback = callback;
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-desc').textContent = desc;
  document.getElementById('confirm-type-label').textContent = label;
  document.getElementById('confirm-input').value = '';
  document.getElementById('confirm-modal').dataset.keyword = keyword;
  document.getElementById('confirm-modal').classList.remove('hidden');
}

function hideConfirm() {
  document.getElementById('confirm-modal').classList.add('hidden');
  document.getElementById('confirm-input').value = '';
  confirmCallback = null;
}

// ==================== MAIN TABS ====================

document.querySelectorAll('.main-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    currentMainTab = tab.dataset.tab;
    document.querySelectorAll('.main-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');

    document.getElementById('general-view').classList.toggle('hidden', currentMainTab !== 'general');
    document.getElementById('boards-view').classList.toggle('hidden', currentMainTab !== 'boards');
    document.getElementById('trash-view').classList.toggle('hidden', currentMainTab !== 'trash');

    document.getElementById('general-bottom-bar').classList.toggle('hidden', currentMainTab !== 'general');
    document.getElementById('boards-bottom-bar').classList.toggle('hidden', currentMainTab !== 'boards');
    document.getElementById('board-bottom-bar').classList.add('hidden');

    if (currentMainTab === 'general') renderGallery('general');
    else if (currentMainTab === 'boards') { currentBoard = null; renderBoards(); }
    else if (currentMainTab === 'trash') { renderTrashList(); renderTrashCount(); }
  });
});

// ==================== GENERAL VIEW TABS ====================

document.querySelectorAll('#general-tabs .view-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    currentGeneralView = tab.dataset.view;
    document.querySelectorAll('#general-tabs .view-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    if (currentGeneralView === 'favorites') renderGallery('favorites-general');
    else renderGallery('general');
  });
});

// ==================== BOTTOM BARS ====================

document.getElementById('general-select-btn').addEventListener('click', enterMassSelectMode);
document.getElementById('general-organize-btn').addEventListener('click', () => {
  if (organizeMode) exitOrganizeMode();
  else enterOrganizeMode();
});

document.getElementById('boards-add-btn').addEventListener('click', async () => {
  const name = prompt('Board name:');
  if (name && name.trim()) { await createBoard(name.trim()); renderBoards(); }
});

document.getElementById('boards-move-btn').addEventListener('click', () => {
  boardMoveMode = !boardMoveMode;
  if (boardMoveMode) boardDeleteMode = false;
  renderBoards();
});

document.getElementById('boards-delete-btn').addEventListener('click', async () => {
  if (selectedBoardIds.size > 0) {
    for (const id of selectedBoardIds) await deleteBoard(id);
    selectedBoardIds.clear();
    boardDeleteMode = false;
    renderBoards();
  } else {
    boardDeleteMode = !boardDeleteMode;
    if (boardDeleteMode) boardMoveMode = false;
    renderBoards();
  }
});

document.getElementById('back-to-boards').addEventListener('click', () => {
  currentBoard = null;
  document.getElementById('boards-list').classList.remove('hidden');
  document.getElementById('board-contents').classList.add('hidden');
  document.getElementById('board-bottom-bar').classList.add('hidden');
  document.getElementById('boards-bottom-bar').classList.remove('hidden');
  renderBoards();
});

document.getElementById('board-select-btn').addEventListener('click', enterMassSelectMode);
document.getElementById('board-organize-btn').addEventListener('click', () => {
  if (organizeMode) exitOrganizeMode();
  else enterOrganizeMode();
});
document.getElementById('board-add-sub-btn').addEventListener('click', async () => {
  if (!currentBoard) return;
  const name = prompt('Sub-board name:');
  if (name && name.trim()) {
    await createBoard(name.trim(), currentBoard);
    await renderBoardViewTabs(currentBoard);
  }
});

// ==================== CONTEXT MENU ACTIONS ====================

document.getElementById('ctx-set-cover').addEventListener('click', async () => {
  if (!contextTargetItem || !contextTargetItem.board) return;
  const board = await dbGet('boards', contextTargetItem.board);
  if (!board) return;
  board.coverTweetId = contextTargetItem.id;
  await dbPut('boards', board);
  hideContextMenu();
  renderBoards();
});

document.getElementById('ctx-favorite').addEventListener('click', async () => {
  if (!contextTargetItem) return;
  const item = contextTargetItem;
  const context = vsContext;
  const favScope = context === 'general' || context === 'favorites-general' ? 'general' : currentBoard;
  hideContextMenu();
  await toggleFavorite(item.id, favScope);
  refreshCurrentView();
});

document.getElementById('ctx-move').addEventListener('click', () => {
  if (!contextTargetItem) return;
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
