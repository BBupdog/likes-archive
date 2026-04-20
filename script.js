const DB_NAME = 'likesArchive';
const DB_VERSION = 5;
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

async function downloadAndStoreMedia(url, key) {
  try {
    const response = await fetch(url);
    if (!response.ok) return false;
    const blob = await response.blob();
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onloadend = () => {
        dbPut('images', { id: key, data: reader.result, type: blob.type }).then(() => resolve(true));
      };
      reader.onerror = () => resolve(false);
      reader.readAsDataURL(blob);
    });
  } catch { return false; }
}

async function renderMediaInContainer(mediaKeys, container) {
  if (!mediaKeys || mediaKeys.length === 0) return;
  for (const m of mediaKeys) {
    const record = await dbGet('images', m.key);
    if (!record) continue;
    if (m.mediaType === 'video') {
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

async function getFirstMediaElement(mediaKeys) {
  if (!mediaKeys || mediaKeys.length === 0) return null;
  const record = await dbGet('images', mediaKeys[0].key);
  if (!record) return null;

  const wrap = document.createElement('div');
  wrap.className = 'card-img-wrap';
  wrap.style.cssText = 'width:100%;background:#2a2a2a;overflow:hidden;min-height:80px;';

  if (mediaKeys[0].mediaType === 'video') {
    const video = document.createElement('video');
    video.src = record.data;
    video.muted = true;
    video.playsInline = true;
    video.style.cssText = 'width:100%;display:block;';
    video.onloadedmetadata = () => {
      wrap.style.minHeight = '';
    };
    wrap.appendChild(video);
  } else {
    const img = document.createElement('img');
    img.src = record.data;
    img.loading = 'lazy';
    img.style.cssText = 'width:100%;display:block;';
    img.onload = () => {
      wrap.style.minHeight = '';
    };
    wrap.appendChild(img);
  }

  return wrap;
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
      const ok = await downloadAndStoreMedia(entry.images[i], key);
      if (ok) mediaKeys.push({ key, mediaType: 'image' });
    }
    if (entry.videoUrl) {
      const key = `${entry.id}_video`;
      const ok = await downloadAndStoreMedia(entry.videoUrl, key);
      if (ok) {
        mediaKeys.push({ key, mediaType: 'video' });
      } else if (entry.thumbnailUrl) {
        const thumbKey = `${entry.id}_thumb`;
        const thumbOk = await downloadAndStoreMedia(entry.thumbnailUrl, thumbKey);
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
      previousBoard: null
    });
    imported++;
  }

  hideProgress();
  alert(`Done.\n${imported} imported\n${skippedDuplicate} duplicates skipped\n${skippedDeleted} permanently deleted tweets skipped\n${skippedTrash} in trash skipped`);
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

function applyFilters(likes, { sort, filter, text, author }) {
  let result = likes.filter(item => {
    if (text && !(item.text || '').toLowerCase().includes(text)) return false;
    if (author && !(item.username || '').toLowerCase().includes(author) &&
        !(item.displayName || '').toLowerCase().includes(author)) return false;
    if (filter === 'images') return item.mediaKeys && item.mediaKeys.some(m => m.mediaType === 'image');
    if (filter === 'videos') return item.mediaKeys && item.mediaKeys.some(m => m.mediaType === 'video');
    if (filter === 'text') return !item.mediaKeys || item.mediaKeys.length === 0;
    return true;
  });

  if (sort === 'newest') result.sort((a, b) => new Date(b.date) - new Date(a.date));
  else if (sort === 'oldest') result.sort((a, b) => new Date(a.date) - new Date(b.date));
  else if (sort === 'images') result.sort((a, b) => {
    const aHas = a.mediaKeys && a.mediaKeys.some(m => m.mediaType === 'image') ? 1 : 0;
    const bHas = b.mediaKeys && b.mediaKeys.some(m => m.mediaType === 'image') ? 1 : 0;
    return bHas - aHas;
  });
  else if (sort === 'videos') result.sort((a, b) => {
    const aHas = a.mediaKeys && a.mediaKeys.some(m => m.mediaType === 'video') ? 1 : 0;
    const bHas = b.mediaKeys && b.mediaKeys.some(m => m.mediaType === 'video') ? 1 : 0;
    return bHas - aHas;
  });
  else if (sort === 'text') result = result.filter(item => !item.mediaKeys || item.mediaKeys.length === 0);

  return result;
}

// ==================== POSITION HELPERS ====================

async function getOrderedContextItems(context) {
  const all = await dbGetAll('likes');
  const items = getContextItems(all, context);
  return items.sort((a, b) => (a.position || 0) - (b.position || 0));
}

async function moveCardUp(id, context) {
  const items = await getOrderedContextItems(context);
  const idx = items.findIndex(i => i.id === id);
  if (idx <= 0) return;
  const above = items[idx - 1];
  const current = items[idx];
  const temp = above.position;
  above.position = current.position;
  current.position = temp;
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
  const temp = below.position;
  below.position = current.position;
  current.position = temp;
  await dbPut('likes', below);
  await dbPut('likes', current);
  refreshCurrentView();
}

async function moveCardToTop(id, context) {
  const items = await getOrderedContextItems(context);
  const idx = items.findIndex(i => i.id === id);
  if (idx <= 0) return;
  const current = items[idx];
  const minPos = items[0].position || 0;
  current.position = minPos - 1;
  await dbPut('likes', current);
  refreshCurrentView();
}

async function moveCardToBottom(id, context) {
  const items = await getOrderedContextItems(context);
  const idx = items.findIndex(i => i.id === id);
  if (idx < 0 || idx >= items.length - 1) return;
  const current = items[idx];
  const maxPos = items[items.length - 1].position || 0;
  current.position = maxPos + 1;
  await dbPut('likes', current);
  refreshCurrentView();
}

function getContextItems(all, context) {
  if (context === 'general') return all.filter(i => !i.board);
  if (context === 'favorites-general') return all.filter(i => !i.board && i.favorites && i.favorites.includes('general'));
  if (context === 'board') return all.filter(i => i.board === currentBoard);
  if (context === 'favorites-board') return all.filter(i => i.board === currentBoard && i.favorites && i.favorites.includes(currentBoard));
  return all;
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

    const topBtn = document.createElement('button');
    topBtn.className = 'arrow-btn';
    topBtn.textContent = '⇈';
    topBtn.title = 'Move to top';
    topBtn.onclick = async e => { e.stopPropagation(); await moveCardToTop(item.id, context); };

    const upBtn = document.createElement('button');
    upBtn.className = 'arrow-btn';
    upBtn.textContent = '↑';
    upBtn.title = 'Move up';
    upBtn.onclick = async e => { e.stopPropagation(); await moveCardUp(item.id, context); };

    const downBtn = document.createElement('button');
    downBtn.className = 'arrow-btn';
    downBtn.textContent = '↓';
    downBtn.title = 'Move down';
    downBtn.onclick = async e => { e.stopPropagation(); await moveCardDown(item.id, context); };

    const bottomBtn = document.createElement('button');
    bottomBtn.className = 'arrow-btn';
    bottomBtn.textContent = '⇊';
    bottomBtn.title = 'Move to bottom';
    bottomBtn.onclick = async e => { e.stopPropagation(); await moveCardToBottom(item.id, context); };

    arrows.appendChild(topBtn);
    arrows.appendChild(upBtn);
    arrows.appendChild(downBtn);
    arrows.appendChild(bottomBtn);
    card.appendChild(arrows);
    card.classList.add('organize-mode');
  }

  if (item.tweetType === 'quote') {
    const label = document.createElement('div');
    label.className = 'card-quote-label';
    label.textContent = 'Quote tweet';
    card.appendChild(label);
  }

  if (item.text) {
    const p = document.createElement('div');
    p.className = 'card-text';
    p.textContent = item.text.slice(0, 140) + (item.text.length > 140 ? '...' : '');
    card.appendChild(p);
  }

  const mediaEl = await getFirstMediaElement(item.mediaKeys);
  if (mediaEl) card.appendChild(mediaEl);

  if (item.tweetType === 'quote' && item.quotedId) {
    const original = await dbGet('likes', item.quotedId);
    if (original) {
      const divider = document.createElement('hr');
      divider.className = 'card-quote-divider';
      card.appendChild(divider);
      const origMedia = await getFirstMediaElement(original.mediaKeys);
      if (origMedia) card.appendChild(origMedia);
      if (original.text) {
        const origText = document.createElement('div');
        origText.className = 'card-text';
        origText.style.color = '#999';
        origText.textContent = original.text.slice(0, 100) + (original.text.length > 100 ? '...' : '');
        card.appendChild(origText);
      }
    }
  }

  if (item.displayName || item.username) {
    const author = document.createElement('div');
    author.className = 'card-author';
    author.textContent = item.displayName || item.username;
    card.appendChild(author);
  }

  const isFavorited = item.favorites && (
    context === 'general' || context === 'favorites-general'
      ? item.favorites.includes('general')
      : item.favorites.includes(currentBoard)
  );
  if (isFavorited) card.classList.add('favorited');
  if (selectedIds.has(item.id)) card.classList.add('selected');

  card.addEventListener('pointerdown', () => {
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      showContextMenu(item, card, context);
    }, 500);
  });

  card.addEventListener('pointerup', () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
      if (massSelectMode) toggleCardSelection(item.id, card);
      else if (!organizeMode) openLightbox(item);
    }
  });

  card.addEventListener('pointercancel', () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  });

  return card;
}

// ==================== GALLERY RENDER ====================

async function renderGallery(context = 'general') {
  const gallery = document.getElementById('gallery');
  gallery.innerHTML = '';
  const sf = getSortFilter();
  const all = await dbGetAll('likes');
  let items = getContextItems(all, context);
  items = applyFilters(items, sf);
  if (sf.sort !== 'newest' && sf.sort !== 'oldest') {
    items.sort((a, b) => (a.position || 0) - (b.position || 0));
  }
  updateCounter(items.length, 'likes');
  if (items.length === 0) {
    gallery.innerHTML = '<p style="padding:20px;color:#666;">No likes here yet.</p>';
    return;
  }
  for (const item of items) {
    gallery.appendChild(await createCard(item, context));
  }
}

async function renderBoardGallery(boardId, context = 'board') {
  const gallery = document.getElementById('board-gallery');
  gallery.innerHTML = '';
  const sf = getSortFilter();
  const all = await dbGetAll('likes');
  let items = getContextItems(all, context);
  items = applyFilters(items, sf);
  if (sf.sort !== 'newest' && sf.sort !== 'oldest') {
    items.sort((a, b) => (a.position || 0) - (b.position || 0));
  }
  updateCounter(items.length, 'likes');
  if (items.length === 0) {
    gallery.innerHTML = '<p style="padding:20px;color:#666;">No likes here yet.</p>';
    return;
  }
  for (const item of items) {
    gallery.appendChild(await createCard(item, context));
  }
}

// ==================== BOARDS ====================

async function renderBoards() {
  const boardsList = document.getElementById('boards-list');
  boardsList.innerHTML = '';
  const boards = await dbGetAll('boards');
  const likes = await dbGetAll('likes');
  const topLevel = boards.filter(b => !b.parentId).sort((a, b) => (a.position || 0) - (b.position || 0));

  if (topLevel.length === 0) {
    boardsList.innerHTML = '<p style="padding:20px;color:#666;">No boards yet. Tap + to create one.</p>';
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
    upBtn.onclick = async e => { e.stopPropagation(); await moveBoardUp(board.id); };
    const downBtn = document.createElement('button');
    downBtn.className = 'board-arrow-btn';
    downBtn.textContent = '↓';
    downBtn.onclick = async e => { e.stopPropagation(); await moveBoardDown(board.id); };
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
    const subCount = subBoards.length > 0 ? ` · ${subBoards.length} sub-board${subBoards.length > 1 ? 's' : ''}` : '';
    meta.textContent = `${count} likes${subCount}`;
    info.appendChild(name);
    info.appendChild(meta);
    card.appendChild(info);

    card.addEventListener('click', () => {
      if (boardDeleteMode) toggleBoardSelection(board.id, card);
      else if (!boardMoveMode) openBoard(board.id, board.name);
    });

    card.addEventListener('pointerdown', () => {
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        showBoardContextMenu(board, card);
      }, 500);
    });

    card.addEventListener('pointerup', () => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    });

    card.addEventListener('pointercancel', () => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    });

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
  allTab.onclick = () => {
    currentBoard = boardId;
    currentBoardView = 'all';
    document.querySelectorAll('#board-view-tabs .view-tab').forEach(t => t.classList.remove('active'));
    allTab.classList.add('active');
    renderBoardGallery(boardId, 'board');
  };
  tabsContainer.appendChild(allTab);

  const favTab = document.createElement('button');
  favTab.className = 'view-tab';
  favTab.textContent = 'Favorites';
  favTab.onclick = () => {
    currentBoard = boardId;
    currentBoardView = 'favorites';
    document.querySelectorAll('#board-view-tabs .view-tab').forEach(t => t.classList.remove('active'));
    favTab.classList.add('active');
    renderBoardGallery(boardId, 'favorites-board');
  };
  tabsContainer.appendChild(favTab);

  for (const sub of subBoards) {
    const subTab = document.createElement('button');
    subTab.className = 'view-tab';
    subTab.textContent = sub.name;
    subTab.onclick = () => {
      currentBoard = sub.id;
      currentBoardView = 'sub-' + sub.id;
      document.querySelectorAll('#board-view-tabs .view-tab').forEach(t => t.classList.remove('active'));
      subTab.classList.add('active');
      document.getElementById('board-title-label').textContent = sub.name;
      renderBoardGallery(sub.id, 'board');
    };
    tabsContainer.appendChild(subTab);
  }
}

async function moveBoardUp(boardId) {
  const boards = await dbGetAll('boards');
  const topLevel = boards.filter(b => !b.parentId).sort((a, b) => (a.position || 0) - (b.position || 0));
  const idx = topLevel.findIndex(b => b.id === boardId);
  if (idx <= 0) return;
  const above = topLevel[idx - 1];
  const current = topLevel[idx];
  const temp = above.position;
  above.position = current.position;
  current.position = temp;
  await dbPut('boards', above);
  await dbPut('boards', current);
  renderBoards();
}

async function moveBoardDown(boardId) {
  const boards = await dbGetAll('boards');
  const topLevel = boards.filter(b => !b.parentId).sort((a, b) => (a.position || 0) - (b.position || 0));
  const idx = topLevel.findIndex(b => b.id === boardId);
  if (idx < 0 || idx >= topLevel.length - 1) return;
  const below = topLevel[idx + 1];
  const current = topLevel[idx];
  const temp = below.position;
  below.position = current.position;
  current.position = temp;
  await dbPut('boards', below);
  await dbPut('boards', current);
  renderBoards();
}

function toggleBoardSelection(boardId, card) {
  if (selectedBoardIds.has(boardId)) {
    selectedBoardIds.delete(boardId);
    card.classList.remove('board-selected');
  } else {
    selectedBoardIds.add(boardId);
    card.classList.add('board-selected');
  }
}

async function deleteSelectedBoards() {
  if (selectedBoardIds.size === 0) { alert('No boards selected.'); return; }
  const count = selectedBoardIds.size;
  if (!confirm(`Delete ${count} board${count > 1 ? 's' : ''}? Likes inside will be moved to General.`)) return;
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
    { label: 'Set cover image', action: () => openBoardCoverPicker(board.id) },
    { label: 'Delete', action: () => deleteSingleBoard(board.id), danger: true }
  ];

  for (const opt of options) {
    const btn = document.createElement('button');
    btn.textContent = opt.label;
    btn.style.cssText = `display:block;width:100%;padding:12px 16px;background:transparent;border:none;border-bottom:1px solid #2a2a2a;color:${opt.danger ? '#ff4444' : '#f0f0f0'};font-size:14px;text-align:left;cursor:pointer;`;
    btn.onclick = () => { removeBoardCtxMenu(); opt.action(); };
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);

  const overlay = document.createElement('div');
  overlay.id = 'board-ctx-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:399;';
  overlay.onclick = removeBoardCtxMenu;
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

async function openBoardCoverPicker(boardId) {
  const all = await dbGetAll('likes');
  const boardLikes = all.filter(l => l.board === boardId && l.mediaKeys && l.mediaKeys.length > 0);
  if (boardLikes.length === 0) { alert('No images in this board to use as cover.'); return; }

  const picker = document.createElement('div');
  picker.style.cssText = 'position:fixed;inset:0;z-index:500;display:flex;align-items:center;justify-content:center;';
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.85);';
  overlay.onclick = () => picker.remove();
  const content = document.createElement('div');
  content.style.cssText = 'position:relative;z-index:501;background:#1a1a1a;border-radius:16px;width:88vw;max-height:70vh;overflow-y:auto;padding:16px;';
  const title = document.createElement('h2');
  title.textContent = 'Choose cover image';
  title.style.cssText = 'font-size:16px;margin-bottom:12px;';
  content.appendChild(title);
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;';

  for (const like of boardLikes) {
    const record = await dbGet('images', like.mediaKeys[0].key);
    if (!record) continue;
    const img = document.createElement('img');
    img.src = record.data;
    img.style.cssText = 'width:100%;height:80px;object-fit:cover;border-radius:8px;cursor:pointer;border:2px solid transparent;';
    img.onclick = async () => {
      const board = await dbGet('boards', boardId);
      if (board) { board.coverTweetId = like.id; await dbPut('boards', board); }
      picker.remove();
      renderBoards();
    };
    grid.appendChild(img);
  }

  content.appendChild(grid);
  picker.appendChild(overlay);
  picker.appendChild(content);
  document.body.appendChild(picker);
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
  contextTargetItem = item;
  const menu = document.getElementById('context-menu');
  const overlay = document.getElementById('context-overlay');

  const isFavorited = item.favorites && (
    context === 'general' || context === 'favorites-general'
      ? item.favorites.includes('general')
      : item.favorites.includes(currentBoard)
  );
  document.getElementById('ctx-favorite').textContent = isFavorited ? 'Unfavorite' : 'Favorite';
  document.getElementById('ctx-set-cover').style.display = !!item.board ? 'block' : 'none';

  const rect = card.getBoundingClientRect();
  menu.style.top = (rect.top + window.scrollY + 40) + 'px';
  menu.style.left = (rect.left + 10) + 'px';
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

// ==================== TRASH ====================

async function moveToTrash(id, previousBoard = null) {
  const like = await dbGet('likes', id);
  if (!like) return;
  like.trashedAt = Date.now();
  like.previousBoard = previousBoard || like.board;
  like.board = null;
  await dbPut('trash', like);
  await dbDelete('likes', id);
  closeLightbox();
  refreshCurrentView();
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
    if (item.trashedAt && (now - item.trashedAt) > thirtyDays) {
      await permanentlyDelete(item.id);
    }
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
        const thumb = document.createElement('img');
        thumb.className = 'trash-item-thumb';
        thumb.src = record.data;
        el.appendChild(thumb);
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
    meta.textContent = `Deleted ${item.trashedAt ? new Date(item.trashedAt).toLocaleDateString() : 'unknown'} · ${daysLeft} days until auto-delete`;
    info.appendChild(text);
    info.appendChild(meta);
    el.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'trash-item-actions';
    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'trash-restore-btn';
    restoreBtn.textContent = 'Restore';
    restoreBtn.onclick = () => restoreFromTrash(item.id);
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'trash-delete-btn';
    deleteBtn.textContent = 'Delete';
    deleteBtn.onclick = () => permanentlyDelete(item.id);
    actions.appendChild(restoreBtn);
    actions.appendChild(deleteBtn);
    el.appendChild(actions);

    list.appendChild(el);
  }
}

async function renderTrashCount() {
  const all = await dbGetAll('trash');
  const trashTab = document.querySelector('.main-tab[data-tab="trash"]');
  if (trashTab) {
    trashTab.textContent = all.length > 0 ? `Trash (${all.length})` : 'Trash';
  }
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
  author.textContent = item.displayName ? `${item.displayName} @${item.username}` : '';
  text.textContent = item.text || '';
  link.href = `https://twitter.com/i/web/status/${item.id}`;
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
  if (!item.mediaKeys || item.mediaKeys.length === 0) {
    alert('No media to download.');
    return;
  }
  for (const m of item.mediaKeys) {
    const record = await dbGet('images', m.key);
    if (!record) continue;
    const a = document.createElement('a');
    a.href = record.data;
    a.download = `likes_archive_${item.id}.${m.mediaType === 'video' ? 'mp4' : 'jpg'}`;
    a.click();
  }
}

// ==================== EXPORT APP FILES ====================

async function exportAppFiles() {
  const files = ['index.html', 'style.css', 'script.js', 'manifest.json', 'sw.js'];
  const repoUrl = window.location.origin + window.location.pathname.replace(/\/?$/, '/');

  alert('Downloading app files one by one. Allow each download when prompted.');

  for (const file of files) {
    try {
      const response = await fetch(repoUrl + file);
      if (!response.ok) throw new Error('Not found');
      const blob = await response.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = file;
      a.click();
      await new Promise(r => setTimeout(r, 800));
    } catch {
      alert(`Could not download ${file}. Try downloading it manually from GitHub.`);
    }
  }

  alert('Done. Keep these files somewhere safe as a backup.');
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
}

async function massDelete() {
  if (selectedIds.size === 0) { alert('No tweets selected.'); return; }
  const count = selectedIds.size;
  const ids = new Set(selectedIds);
  showConfirm(
    'Delete selected tweets',
    `You are about to move ${count} tweet${count > 1 ? 's' : ''} to trash.`,
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
      const btn = document.createElement('button');
      btn.className = 'board-picker-item';
      btn.textContent = board.name;
      btn.onclick = () => {
        document.getElementById('board-picker').classList.add('hidden');
        if (boardPickerCallback) boardPickerCallback(board.id);
      };
      list.appendChild(btn);

      const subBoards = boards.filter(b => b.parentId === board.id);
      for (const sub of subBoards) {
        const subBtn = document.createElement('button');
        subBtn.className = 'board-picker-item';
        subBtn.style.paddingLeft = '24px';
        subBtn.textContent = '↳ ' + sub.name;
        subBtn.onclick = () => {
          document.getElementById('board-picker').classList.add('hidden');
          if (boardPickerCallback) boardPickerCallback(sub.id);
        };
        list.appendChild(subBtn);
      }
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
    id: 'board_' + Date.now(),
    name,
    parentId: null,
    coverTweetId: null,
    position: maxPos + 1,
    createdAt: Date.now()
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

// ==================== COUNTER ====================

function updateCounter(count, unit) {
  document.getElementById('like-counter').textContent = `${count} ${unit}`;
}

// ==================== REFRESH ====================

function refreshCurrentView() {
  if (currentMainTab === 'general') {
    if (currentGeneralView === 'all') renderGallery('general');
    else renderGallery('favorites-general');
  } else if (currentMainTab === 'boards') {
    if (currentBoard) {
      if (currentBoardView === 'favorites') renderBoardGallery(currentBoard, 'favorites-board');
      else renderBoardGallery(currentBoard, 'board');
    } else {
      renderBoards();
    }
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

// ==================== GENERAL VIEW TABS ====================

document.querySelectorAll('#general-tabs .view-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#general-tabs .view-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentGeneralView = tab.dataset.view;
    if (currentGeneralView === 'all') renderGallery('general');
    else renderGallery('favorites-general');
  });
});

// ==================== BACK BUTTON ====================

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

// ==================== BOARDS BOTTOM BAR ====================

document.getElementById('boards-add-btn').addEventListener('click', async () => {
  const name = prompt('Board name:');
  if (!name || !name.trim()) return;
  const boards = await dbGetAll('boards');
  const maxPos = boards.length > 0 ? Math.max(...boards.map(b => b.position || 0)) : -1;
  await dbPut('boards', {
    id: 'board_' + Date.now(),
    name: name.trim(),
    parentId: null,
    coverTweetId: null,
    position: maxPos + 1,
    createdAt: Date.now()
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
    const like = await dbGet('likes', item.id);
    if (like) { like.board = boardId; await dbPut('likes', like); }
    refreshCurrentView();
  });
});

document.getElementById('ctx-download').addEventListener('click', async () => {
  if (!contextTargetItem) return;
  await downloadMedia(contextTargetItem);
  hideContextMenu();
});

document.getElementById('ctx-set-cover').addEventListener('click', async () => {
  if (!contextTargetItem || !currentBoard) return;
  const board = await dbGet('boards', currentBoard);
  if (board) { board.coverTweetId = contextTargetItem.id; await dbPut('boards', board); }
  hideContextMenu();
  alert('Cover image set.');
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
    const like = await dbGet('likes', itemId);
    if (like) { like.board = boardId; await dbPut('likes', like); }
    refreshCurrentView();
  });
});

// ==================== MASS SELECT BAR ====================

document.getElementById('mass-cancel-btn').addEventListener('click', exitMassSelectMode);
document.getElementById('mass-delete-btn').addEventListener('click', massDelete);
document.getElementById('mass-board-btn').addEventListener('click', () => {
  openBoardPicker(async boardId => {
    for (const id of selectedIds) {
      const like = await dbGet('likes', id);
      if (like) { like.board = boardId; await dbPut('likes', like); }
    }
    exitMassSelectMode();
    refreshCurrentView();
  });
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

// ==================== COLUMN SWITCHER ====================

document.querySelectorAll('.col-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentCols = parseInt(btn.dataset.cols);
    document.querySelectorAll('.col-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('gallery').style.columnCount = currentCols;
    document.getElementById('board-gallery').style.columnCount = currentCols;
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

document.getElementById('wipe-log-btn').addEventListener('click', () => {
  showConfirm('Wipe delete log', 'Clears permanently deleted tweet IDs. Previously deleted tweets may reappear on next import.', 'WIPE', 'Type WIPE to confirm',
    async () => { await dbClear('deleted'); alert('Delete log wiped.'); });
});

document.getElementById('clear-likes-btn').addEventListener('click', () => {
  showConfirm('Clear all likes', 'Deletes your entire library and trash. Delete log is kept.', 'DELETE', 'Type DELETE to confirm',
    async () => {
      await dbClear('likes'); await dbClear('images'); await dbClear('boards'); await dbClear('trash');
      refreshCurrentView(); alert('Library cleared.');
    });
});

document.getElementById('full-reset-btn').addEventListener('click', () => {
  showConfirm('Full reset', 'Wipes everything including delete log. App returns to factory state.', 'RESET', 'Type RESET to confirm',
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

// ==================== EMPTY TRASH ====================

document.getElementById('empty-trash-btn').addEventListener('click', () => {
  showConfirm('Empty trash', 'Permanently deletes all items in trash. This cannot be undone.', 'EMPTY', 'Type EMPTY to confirm', emptyTrash);
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
  document.getElementById('boards-view').classList.add('hidden');
  document.getElementById('trash-view').classList.add('hidden');
  document.getElementById('board-contents').classList.add('hidden');
});
