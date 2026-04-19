const DB_NAME = 'likesArchive';
const DB_VERSION = 4;
let db;
let currentItem = null;
let currentCols = 2;
let currentTab = 'general';
let currentBoard = null;
let massSelectMode = false;
let selectedIds = new Set();
let contextTargetItem = null;
let longPressTimer = null;
let confirmCallback = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('likes')) {
        db.createObjectStore('likes', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('deleted')) {
        db.createObjectStore('deleted', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('images')) {
        db.createObjectStore('images', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('boards')) {
        db.createObjectStore('boards', { keyPath: 'id' });
      }
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
      if (inQuotes && next === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      row.push(current);
      current = '';
    } else if ((ch === '\n' || (ch === '\r' && next === '\n')) && !inQuotes) {
      if (ch === '\r') i++;
      row.push(current);
      current = '';
      rows.push(row);
      row = [];
    } else {
      current += ch;
    }
  }
  if (current || row.length) {
    row.push(current);
    rows.push(row);
  }

  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i];
    if (!cols || cols.length < 2) continue;

    const id = cols[1]?.trim();
    const date = cols[2]?.trim();
    const username = cols[3]?.trim();
    const displayName = cols[4]?.trim();
    const text = cols[5]?.trim();
    const mediaRaw = cols[16]?.trim();

    if (!id) continue;

    const images = mediaRaw
      ? mediaRaw.split(';').map(u => u.trim()).filter(u => u.startsWith('http'))
      : [];

    results.push({ id, date, username, displayName, text, images });
  }

  return results;
}

async function downloadAndStoreImage(url, key) {
  try {
    const response = await fetch(url);
    if (!response.ok) return false;
    const blob = await response.blob();
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onloadend = () => {
        dbPut('images', { id: key, data: reader.result }).then(() => resolve(true));
      };
      reader.onerror = () => resolve(false);
      reader.readAsDataURL(blob);
    });
  } catch {
    return false;
  }
}

async function importFiles(files) {
  const deletedAll = await dbGetAll('deleted');
  const deletedIds = new Set(deletedAll.map(d => d.id));
  let imported = 0;
  let skipped = 0;

  for (const file of files) {
    const text = await file.text();
    let entries;

    if (file.name.endsWith('.csv')) {
      entries = parseCSV(text);
    } else {
      try {
        const cleaned = text
          .replace(/^window\.YTD\.like\.part\d+\s*=\s*/, '')
          .replace(/^window\.YTD\.bookmark\.part\d+\s*=\s*/, '')
          .trim();
        const json = JSON.parse(cleaned);
        entries = json.map(entry => {
          const item = entry.like || entry.bookmark;
          return {
            id: item.tweetId,
            text: item.fullText || '',
            username: '',
            displayName: '',
            date: '',
            images: []
          };
        });
      } catch {
        alert(`Could not read ${file.name}. Skipping.`);
        continue;
      }
    }

    for (const entry of entries) {
      if (!entry.id) continue;
      if (deletedIds.has(entry.id)) { skipped++; continue; }
      const existing = await dbGet('likes', entry.id);
      if (existing) { skipped++; continue; }

      const storedImages = [];
      for (let i = 0; i < entry.images.length; i++) {
        const key = `${entry.id}_${i}`;
        const ok = await downloadAndStoreImage(entry.images[i], key);
        if (ok) storedImages.push(key);
      }

      await dbPut('likes', {
        id: entry.id,
        text: entry.text || '',
        username: entry.username || '',
        displayName: entry.displayName || '',
        date: entry.date || '',
        imageKeys: storedImages,
        board: null
      });

      imported++;
    }
  }

  alert(`Done. ${imported} new likes imported, ${skipped} skipped.`);
  renderGallery();
}

async function createCard(item) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = item.id;

  const checkmark = document.createElement('div');
  checkmark.className = 'card-checkmark';
  checkmark.textContent = '✓';
  card.appendChild(checkmark);

  if (item.imageKeys && item.imageKeys.length > 0) {
    const imgRecord = await dbGet('images', item.imageKeys[0]);
    if (imgRecord) {
      const img = document.createElement('img');
      img.src = imgRecord.data;
      img.alt = item.text ? item.text.slice(0, 60) : '';
      img.loading = 'lazy';
      card.appendChild(img);
    }
  }

  if (item.text) {
    const p = document.createElement('div');
    p.className = 'card-text';
    p.textContent = item.text.slice(0, 140) + (item.text.length > 140 ? '...' : '');
    card.appendChild(p);
  }

  if (item.displayName || item.username) {
    const author = document.createElement('div');
    author.className = 'card-author';
    author.textContent = item.displayName || item.username;
    card.appendChild(author);
  }

  if (item.board) {
    const tag = document.createElement('div');
    tag.className = 'card-board-tag';
    tag.textContent = item.board;
    card.appendChild(tag);
  }

  card.addEventListener('pointerdown', () => {
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      showContextMenu(item, card);
    }, 500);
  });

  card.addEventListener('pointerup', () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
      if (massSelectMode) {
        toggleCardSelection(item.id, card);
      } else {
        openLightbox(item);
      }
    }
  });

  card.addEventListener('pointercancel', () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  });

  if (selectedIds.has(item.id)) {
    card.classList.add('selected');
  }

  return card;
}

function toggleCardSelection(id, card) {
  if (selectedIds.has(id)) {
    selectedIds.delete(id);
    card.classList.remove('selected');
  } else {
    selectedIds.add(id);
    card.classList.add('selected');
  }
  document.getElementById('mass-count').textContent = selectedIds.size + ' selected';
}

function showContextMenu(item, card) {
  contextTargetItem = item;
  const menu = document.getElementById('context-menu');
  const overlay = document.getElementById('context-overlay');
  const rect = card.getBoundingClientRect();
  menu.style.top = (rect.top + window.scrollY + 40) + 'px';
  menu.style.left = (rect.left + 10) + 'px';
  menu.classList.remove('hidden');
  overlay.classList.remove('hidden');
}

function hideContextMenu() {
  document.getElementById('context-menu').classList.add('hidden');
  document.getElementById('context-overlay').classList.add('hidden');
  contextTargetItem = null;
}

function enterMassSelectMode() {
  massSelectMode = true;
  selectedIds.clear();
  document.getElementById('top-bar').classList.add('hidden');
  document.getElementById('mass-select-bar').classList.remove('hidden');
  document.getElementById('mass-count').textContent = '0 selected';
  if (contextTargetItem) {
    const card = document.querySelector(`.card[data-id="${contextTargetItem.id}"]`);
    if (card) toggleCardSelection(contextTargetItem.id, card);
  }
  hideContextMenu();
}

function exitMassSelectMode() {
  massSelectMode = false;
  selectedIds.clear();
  document.querySelectorAll('.card.selected').forEach(c => c.classList.remove('selected'));
  document.getElementById('top-bar').classList.remove('hidden');
  document.getElementById('mass-select-bar').classList.add('hidden');
}

async function massDelete() {
  if (selectedIds.size === 0) {
    alert('No tweets selected.');
    return;
  }
  const count = selectedIds.size;
  const ids = new Set(selectedIds);
  showConfirm(
    'Delete selected tweets',
    `You are about to permanently delete ${count} tweet${count > 1 ? 's' : ''} from your archive. This cannot be undone.`,
    'DELETE',
    'Type DELETE to confirm',
    async () => {
      for (const id of ids) {
        const like = await dbGet('likes', id);
        if (like && like.imageKeys) {
          for (const key of like.imageKeys) await dbDelete('images', key);
        }
        await dbDelete('likes', id);
        await dbPut('deleted', { id });
      }
      exitMassSelectMode();
      refreshCurrentView();
    }
  );
}

async function massAddToBoard() {
  if (selectedIds.size === 0) {
    alert('No tweets selected.');
    return;
  }
  openBoardPicker(true);
}

async function renderGallery(filter = '') {
  const gallery = document.getElementById('gallery');
  gallery.innerHTML = '';
  const all = await dbGetAll('likes');
  const filtered = all.filter(item =>
    !item.board &&
    (item.text || '').toLowerCase().includes(filter.toLowerCase())
  );
  updateCounter(filtered.length);
  if (filtered.length === 0) {
    gallery.innerHTML = '<p style="padding:20px;color:#666;">No likes yet. Tap Import to get started.</p>';
    return;
  }
  for (const item of filtered) {
    gallery.appendChild(await createCard(item));
  }
}

async function renderBoardGallery(boardName, filter = '') {
  const gallery = document.getElementById('board-gallery');
  gallery.innerHTML = '';
  const all = await dbGetAll('likes');
  const filtered = all.filter(item =>
    item.board === boardName &&
    (item.text || '').toLowerCase().includes(filter.toLowerCase())
  );
  updateCounter(filtered.length);
  if (filtered.length === 0) {
    gallery.innerHTML = '<p style="padding:20px;color:#666;">No likes in this board yet.</p>';
    return;
  }
  for (const item of filtered) {
    gallery.appendChild(await createCard(item));
  }
}

async function renderBoards() {
  const boardsList = document.getElementById('boards-list');
  boardsList.innerHTML = '';
  const boards = await dbGetAll('boards');
  const likes = await dbGetAll('likes');
  if (boards.length === 0) {
    boardsList.innerHTML = '<p style="padding:20px;color:#666;">No boards yet. Long press a like and tap "Add to board".</p>';
    return;
  }
  for (const board of boards) {
    const count = likes.filter(l => l.board === board.id).length;
    const item = document.createElement('div');
    item.className = 'board-item';
    const info = document.createElement('div');
    info.style.flex = '1';
    const name = document.createElement('div');
    name.className = 'board-name';
    name.textContent = board.id;
    const cnt = document.createElement('div');
    cnt.className = 'board-count';
    cnt.textContent = count + ' likes';
    info.appendChild(name);
    info.appendChild(cnt);
    const delBtn = document.createElement('button');
    delBtn.className = 'board-delete-btn';
    delBtn.textContent = '×';
    delBtn.onclick = async e => {
      e.stopPropagation();
      if (confirm(`Delete board "${board.id}"? Likes will be moved back to General.`)) {
        const all = await dbGetAll('likes');
        for (const like of all) {
          if (like.board === board.id) {
            like.board = null;
            await dbPut('likes', like);
          }
        }
        await dbDelete('boards', board.id);
        renderBoards();
      }
    };
    item.appendChild(info);
    item.appendChild(delBtn);
    item.addEventListener('click', () => openBoard(board.id));
    boardsList.appendChild(item);
  }
}

function openBoard(boardName) {
  currentBoard = boardName;
  document.getElementById('boards-list').classList.add('hidden');
  document.getElementById('board-contents').classList.remove('hidden');
  renderBoardGallery(boardName);
}

function updateCounter(count) {
  document.getElementById('like-counter').textContent = count + ' likes';
}

function refreshCurrentView() {
  const filter = document.getElementById('search').value;
  if (currentTab === 'general') {
    renderGallery(filter);
  } else if (currentBoard) {
    renderBoardGallery(currentBoard, filter);
  } else {
    renderBoards();
  }
}

async function openLightbox(item) {
  currentItem = item;
  const text = document.getElementById('lightbox-text');
  const author = document.getElementById('lightbox-author');
  const link = document.getElementById('lightbox-link');
  const embedContainer = document.getElementById('lightbox-embed');
  text.textContent = item.text || '';
  author.textContent = item.displayName ? `${item.displayName} @${item.username}` : '';
  link.href = `https://twitter.com/i/web/status/${item.id}`;
  embedContainer.innerHTML = '';
  if (item.imageKeys && item.imageKeys.length > 0) {
    for (const key of item.imageKeys) {
      const imgRecord = await dbGet('images', key);
      if (imgRecord) {
        const img = document.createElement('img');
        img.src = imgRecord.data;
        img.style.cssText = 'width:100%;border-radius:10px;display:block;margin-bottom:8px;';
        embedContainer.appendChild(img);
      }
    }
  }
  document.getElementById('lightbox').classList.remove('hidden');
}

function closeLightbox() {
  document.getElementById('lightbox').classList.add('hidden');
  document.getElementById('lightbox-embed').innerHTML = '';
  currentItem = null;
}

async function deleteLike(id) {
  const like = await dbGet('likes', id);
  if (like && like.imageKeys) {
    for (const key of like.imageKeys) await dbDelete('images', key);
  }
  await dbDelete('likes', id);
  await dbPut('deleted', { id });
  closeLightbox();
  refreshCurrentView();
}

async function openBoardPicker(isMassMode = false) {
  const picker = document.getElementById('board-picker');
  const list = document.getElementById('board-picker-list');
  list.innerHTML = '';
  const boards = await dbGetAll('boards');
  if (boards.length === 0) {
    list.innerHTML = '<p style="color:#666;font-size:13px;">No boards yet. Create one below.</p>';
  } else {
    for (const board of boards) {
      const btn = document.createElement('button');
      btn.className = 'board-picker-item';
      btn.textContent = board.id;
      btn.onclick = () => isMassMode ? assignMassToBoard(board.id) : assignToBoard(board.id);
      list.appendChild(btn);
    }
  }
  picker.dataset.massMode = isMassMode ? 'true' : 'false';
  picker.classList.remove('hidden');
}

async function assignToBoard(boardName) {
  const target = contextTargetItem || currentItem;
  if (!target) return;
  await dbPut('boards', { id: boardName });
  const like = await dbGet('likes', target.id);
  if (like) {
    like.board = boardName;
    await dbPut('likes', like);
  }
  document.getElementById('board-picker').classList.add('hidden');
  hideContextMenu();
  closeLightbox();
  refreshCurrentView();
}

async function assignMassToBoard(boardName) {
  await dbPut('boards', { id: boardName });
  for (const id of selectedIds) {
    const like = await dbGet('likes', id);
    if (like) {
      like.board = boardName;
      await dbPut('likes', like);
    }
  }
  document.getElementById('board-picker').classList.add('hidden');
  exitMassSelectMode();
  refreshCurrentView();
}

async function createNewBoard() {
  const input = document.getElementById('new-board-name');
  const name = input.value.trim();
  if (!name) return;
  input.value = '';
  const isMassMode = document.getElementById('board-picker').dataset.massMode === 'true';
  if (isMassMode) {
    await assignMassToBoard(name);
  } else {
    await assignToBoard(name);
  }
}

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

document.getElementById('confirm-cancel').addEventListener('click', hideConfirm);

document.getElementById('confirm-ok').addEventListener('click', async () => {
  const keyword = document.getElementById('confirm-modal').dataset.keyword;
  const input = document.getElementById('confirm-input').value.trim();
  if (input !== keyword) {
    alert(`You must type ${keyword} exactly to confirm.`);
    return;
  }
  const cb = confirmCallback;
  hideConfirm();
  if (cb) {
    try {
      await cb();
    } catch(e) {
      alert('Something went wrong: ' + e.message);
    }
  }
});

document.getElementById('wipe-log-btn').addEventListener('click', () => {
  showConfirm(
    'Wipe delete log',
    'This will clear the list of tweets you have deleted. Previously deleted tweets will appear again on your next import. Your library is not affected.',
    'WIPE',
    'Type WIPE to confirm',
    async () => {
      await dbClear('deleted');
      alert('Delete log wiped successfully.');
    }
  );
});

document.getElementById('clear-likes-btn').addEventListener('click', () => {
  showConfirm(
    'Clear all likes',
    'This will delete your entire library — all tweets and all stored images. Your delete log will be kept, so previously deleted tweets will still be skipped on import. This cannot be undone.',
    'DELETE',
    'Type DELETE to confirm',
    async () => {
      await dbClear('likes');
      await dbClear('images');
      await dbClear('boards');
      refreshCurrentView();
      alert('Library cleared successfully.');
    }
  );
});

document.getElementById('full-reset-btn').addEventListener('click', () => {
  showConfirm(
    'Full reset',
    'This will wipe everything — your entire library, all images, all boards, and the delete log. The app will return to a completely fresh state. Use this before importing a new CSV to avoid duplicate conflicts. This cannot be undone.',
    'RESET',
    'Type RESET to confirm',
    async () => {
      await dbClear('likes');
      await dbClear('images');
      await dbClear('boards');
      await dbClear('deleted');
      refreshCurrentView();
      alert('Full reset complete. App is now fresh.');
    }
  );
});

document.getElementById('settings-btn').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.remove('hidden');
});

document.getElementById('settings-close').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.add('hidden');
});

document.getElementById('settings-overlay').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.add('hidden');
});

document.getElementById('file-input').addEventListener('change', e => {
  const files = Array.from(e.target.files);
  if (files.length > 0) importFiles(files);
});

document.getElementById('search').addEventListener('input', e => {
  if (currentTab === 'general') {
    renderGallery(e.target.value);
  } else if (currentBoard) {
    renderBoardGallery(currentBoard, e.target.value);
  }
});

document.getElementById('tab-general').addEventListener('click', () => {
  currentTab = 'general';
  currentBoard = null;
  document.getElementById('tab-general').classList.add('active');
  document.getElementById('tab-boards').classList.remove('active');
  document.getElementById('general-view').classList.remove('hidden');
  document.getElementById('boards-view').classList.add('hidden');
  renderGallery(document.getElementById('search').value);
});

document.getElementById('tab-boards').addEventListener('click', () => {
  currentTab = 'boards';
  currentBoard = null;
  document.getElementById('tab-boards').classList.add('active');
  document.getElementById('tab-general').classList.remove('active');
  document.getElementById('boards-view').classList.remove('hidden');
  document.getElementById('general-view').classList.add('hidden');
  document.getElementById('board-contents').classList.add('hidden');
  document.getElementById('boards-list').classList.remove('hidden');
  renderBoards();
});

document.getElementById('back-btn').addEventListener('click', () => {
  currentBoard = null;
  document.getElementById('board-contents').classList.add('hidden');
  document.getElementById('boards-list').classList.remove('hidden');
  renderBoards();
});

document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
document.getElementById('lightbox-overlay').addEventListener('click', closeLightbox);
document.getElementById('lightbox-delete').addEventListener('click', () => {
  if (currentItem) deleteLike(currentItem.id);
});
document.getElementById('lightbox-board-btn').addEventListener('click', () => {
  if (currentItem) {
    contextTargetItem = currentItem;
    openBoardPicker(false);
  }
});

document.getElementById('ctx-delete').addEventListener('click', async () => {
  if (!contextTargetItem) return;
  const target = contextTargetItem;
  hideContextMenu();
  await deleteLike(target.id);
});

document.getElementById('ctx-board').addEventListener('click', () => {
  document.getElementById('context-menu').classList.add('hidden');
  document.getElementById('context-overlay').classList.add('hidden');
  openBoardPicker(false);
});

document.getElementById('ctx-mass').addEventListener('click', () => {
  enterMassSelectMode();
});

document.getElementById('context-overlay').addEventListener('click', hideContextMenu);

document.getElementById('board-picker-overlay').addEventListener('click', () => {
  document.getElementById('board-picker').classList.add('hidden');
});

document.getElementById('board-picker-cancel').addEventListener('click', () => {
  document.getElementById('board-picker').classList.add('hidden');
});

document.getElementById('new-board-btn').addEventListener('click', createNewBoard);

document.getElementById('mass-cancel-btn').addEventListener('click', exitMassSelectMode);
document.getElementById('mass-delete-btn').addEventListener('click', massDelete);
document.getElementById('mass-board-btn').addEventListener('click', () => massAddToBoard());

document.querySelectorAll('.col-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentCols = parseInt(btn.dataset.cols);
    document.querySelectorAll('.col-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('gallery').style.columnCount = currentCols;
    document.getElementById('board-gallery').style.columnCount = currentCols;
  });
});

openDB().then(database => {
  db = database;
  renderGallery();
  closeLightbox();
  document.getElementById('board-picker').classList.add('hidden');
  document.getElementById('settings-panel').classList.add('hidden');
  document.getElementById('confirm-modal').classList.add('hidden');
  document.getElementById('context-menu').classList.add('hidden');
  document.getElementById('context-overlay').classList.add('hidden');
  document.getElementById('mass-select-bar').classList.add('hidden');
});
